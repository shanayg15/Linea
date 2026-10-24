// §A9 mock agent (AGENT_MODE=mock): rule-based stand-in for Claude. Takes the optimizer's best option, re-plans
// on port changes, and scripts the demo beats (driver-as-sensor call, missed call, oscillation guard + escalation)
// so the UI has realistic event traffic without any API calls. Deterministic: scripted steps advance on world ticks.
import { ulid } from 'ulid';
import type { SourceRef, Truck, LineaEvent } from '../../../shared/types';
import type { Agent, WorldApi, OptionScore, WorldAction } from './api';
import { parseIso, clockLabel, MIN } from './clock';

const REPLAN_MARGIN = 20;
const STATUS_EVERY_MS = 10 * MIN;
const OSC_WINDOW_MS = 15 * MIN;
const TICKS_PER_LINE = 4; // ~1 s wall between scripted call lines

type WorldLike = WorldApi & { truthMxNow?: (p: 'otay_mesa' | 'tecate') => number };

const n = (id: string) => id.replace(/^T/, '');
const portName = (p: string) => (p === 'tecate' ? 'Tecate' : 'Otay Mesa');
const laneName = (l: string) => (l === 'fast' ? 'FAST' : 'standard');

export function createMockAgent(world: WorldLike): Agent {
  const bus = world.bus;
  let queue: (() => void)[] = [];
  let tickCount = 0;
  let nextAt = 0;
  let lastStatusSlot = -1;
  let queueCallDone = false;
  let missedCallDone = false;
  let frozen = new Set<string>();
  let flips = new Map<string, number[]>();
  let capUsd = Number(process.env.BUDGET_CAP_USD || 3);
  let budgetState: 'ok' | 'warn' | 'tripped' = 'ok';
  let loopsState: { state: 'ok' | 'warn' | 'tripped'; detail: string } = { state: 'ok', detail: 'No repeated actions' };

  const off = bus.on((e: LineaEvent) => {
    if (e.type === 'world.tick') {
      tickCount++;
      if (queue.length && tickCount >= nextAt) {
        const fn = queue.shift()!;
        nextAt = tickCount + TICKS_PER_LINE;
        try { fn(); } catch (err) { console.error('[mock] script step failed', err); }
      }
      const slot = Math.floor(parseIso(e.payload.clock.simTime) / STATUS_EVERY_MS);
      if (slot !== lastStatusSlot) {
        lastStatusSlot = slot;
        emitStatus();
      }
    } else if (e.type === 'sim.control' && e.payload.note?.startsWith('missed call armed')) {
      missedCall();
    } else if (e.type === 'sim.control' && e.payload.note === 'reset') {
      queue = [];
      queueCallDone = false;
      missedCallDone = false;
      frozen = new Set();
      flips = new Map();
      capUsd = Number(process.env.BUDGET_CAP_USD || 3);
      budgetState = 'ok';
      loopsState = { state: 'ok', detail: 'No repeated actions' };
    }
  });

  const script = (...steps: (() => void)[]) => {
    if (!queue.length) nextAt = tickCount + 1;
    queue.push(...steps);
  };

  function emitStatus(): void {
    let fleetDelayMin = 0;
    try { fleetDelayMin = world.projectFleetDelayMin(); } catch { /* ignore */ }
    bus.emit('watchdog.status', {
      budget: { state: budgetState, usedUsd: 0, capUsd, model: budgetState === 'ok' ? 'mock' : 'mock-degraded' },
      loops: loopsState,
      progress: { state: 'ok', fleetDelayMin, trend: 'flat' },
    });
  }

  function sourcesFor(ids: string[]): SourceRef[] {
    const all = world.sources();
    const out = ids.map((id) => all.find((s) => s.id === id)).filter((s): s is SourceRef => !!s);
    const opt = all.find((s) => s.id === `optimizer:${ids.find((i) => i.startsWith('schedule:'))?.slice(9)}`);
    if (opt) out.push(opt);
    return out;
  }

  function gate(tool: string, args: Record<string, unknown>, verdict: 'allowed' | 'blocked', reason?: string, tripKind?: 'oscillation') {
    bus.emit('tool.gate', {
      toolCallId: ulid(), tool, args, idempotencyKey: `${tool}:${JSON.stringify(args)}`, verdict, reason, tripKind, origin: 'mock',
    });
  }

  function act(a: WorldAction, opt: OptionScore, title: string, trigger: string): boolean {
    const tool = a.kind === 'hold' ? 'hold_truck' : a.kind === 'dispatch' ? 'dispatch_truck' : 'reassign_truck';
    const args = { ...a } as Record<string, unknown>;
    if (a.kind === 'reassign' && guardOscillation(a.truckId, tool, args)) return false;
    const res = world.applyAction(a);
    if (!res.ok) {
      gate(tool, args, 'blocked', res.message);
      return false;
    }
    gate(tool, args, 'allowed');
    bus.emit('agent.decision', {
      decisionId: ulid(),
      action: a.kind,
      truckIds: [a.truckId],
      title,
      detail: `${res.message}. Trigger: ${trigger}.`,
      reasoning: opt.explanation,
      sources: sourcesFor(opt.sourceIds),
      costUsd: 0,
      model: 'mock',
      origin: 'mock',
    });
    return true;
  }

  /** Mock watchdog: the 3rd port flip for one truck inside 15 sim-min is blocked, the truck frozen, Ana called. */
  function guardOscillation(truckId: string, tool: string, args: Record<string, unknown>): boolean {
    if (frozen.has(truckId)) {
      gate(tool, args, 'blocked', `Truck ${n(truckId)} is frozen pending dispatcher review`, 'oscillation');
      return true;
    }
    const now = parseIso(world.now());
    const list = (flips.get(truckId) ?? []).filter((t) => now - t < OSC_WINDOW_MS);
    if (list.length >= 2) {
      frozen.add(truckId);
      gate(tool, args, 'blocked', `3rd port flip for Truck ${n(truckId)} in ${Math.round((now - list[0]) / MIN)} sim-min`, 'oscillation');
      tripOscillation(truckId, list.length + 1);
      return true;
    }
    list.push(now);
    flips.set(truckId, list);
    return false;
  }

  function tripOscillation(truckId: string, count: number): void {
    const tripId = ulid();
    const callId = ulid();
    loopsState = { state: 'tripped', detail: `Truck ${n(truckId)} flipped ports ${count}× — frozen` };
    bus.emit('watchdog.trip', {
      tripId, kind: 'oscillation', truckId,
      title: `Loop detected: Truck ${n(truckId)} keeps flipping ports`,
      detail: 'Tecate CBP data is flapping 15↔95 min. Further reroutes for this truck are blocked until a human decides.',
      evidence: [`${count} reassign proposals within 15 sim-min`, 'Tecate standard wait alternating every 2 sim-min'],
      response: 'escalated',
    });
    emitStatus();
    const t = world.getTruck(truckId);
    const where = t?.port ? portName(t.port) : 'Otay Mesa';
    script(
      () => bus.emit('escalation', { escalationId: ulid(), to: 'Ana (dispatcher)', tripIds: [tripId], summary: `Truck ${n(truckId)} oscillating between ports; needs a decision.`, callId }),
      () => bus.emit('call.started', { callId, kind: 'dispatcher', truckId, personName: 'Ana', mode: 'simulated', language: 'en-US', purpose: `Resolve oscillation on Truck ${n(truckId)}` }),
      () => bus.emit('call.status', { callId, status: 'ringing' }),
      () => bus.emit('call.status', { callId, status: 'in_progress' }),
      () => say(callId, 'linea', `Hi Ana, it's Linea, the AI dispatcher. One thing needs you: Tecate's wait data is flapping and Truck ${n(truckId)} keeps flipping ports. I've frozen it on ${where}. Keep it there?`, 'en-US', null),
      () => say(callId, 'human', `Keep Pedro on ${where}.`, 'en-US', null),
      () => bus.emit('call.tool', { callId, tool: 'resolve_trip', args: { tripId, decision: `keep on ${where}` }, result: 'resolved' }),
      () => say(callId, 'linea', `Done. Truck ${n(truckId)} stays on ${where}. Thanks, Ana.`, 'en-US', null),
      () => {
        bus.emit('call.status', { callId, status: 'completed' });
        bus.emit('call.ended', { callId, kind: 'dispatcher', outcome: 'completed', durationSec: 34, summary: `Ana: keep Truck ${n(truckId)} on ${where}.`, costUsd: 0 });
        bus.emit('watchdog.resolved', { tripId, resolution: `Dispatcher: keep Truck ${n(truckId)} on ${where}`, by: 'dispatcher' });
        loopsState = { state: 'ok', detail: `Truck ${n(truckId)} pinned to ${where} by dispatcher` };
        emitStatus();
      },
    );
  }

  function say(callId: string, speaker: 'linea' | 'human', text: string, lang: string, textEnglish: string | null): void {
    bus.emit('call.transcript', { callId, utteranceId: ulid(), speaker, text, lang, textEnglish, final: true });
  }

  function decide(truckId: string, trigger: string): void {
    const t = world.getTruck(truckId);
    if (!t || (t.state !== 'at_yard' && t.state !== 'held')) return;
    const opts = world.scoreOptions(truckId);
    const best = opts[0];
    if (!best) return;
    bus.emit('agent.thinking', { text: `Truck ${n(truckId)} (${t.cargo.replace('_', ' ')}, due ${clockLabel(parseIso(t.deadline))}): ${opts.length} options scored. Best: ${best.explanation}.`, trigger });
    if (best.option === 'go_now') {
      act({ kind: 'dispatch', truckId, port: best.port, lane: best.lane }, best,
        `Dispatching Truck ${n(truckId)} to ${portName(best.port)} ${laneName(best.lane)}`, trigger);
    } else {
      const ok = act({ kind: 'hold', truckId, until: best.departAt }, best,
        `Holding Truck ${n(truckId)} at the yard until ${clockLabel(parseIso(best.departAt))}`, trigger);
      if (ok && (t.port !== best.port || t.lane !== best.lane)) world.applyAction({ kind: 'reassign', truckId, port: best.port, lane: best.lane });
    }
  }

  function replan(trigger: string): void {
    const view = world.view('linea');
    const moving = view.trucks.filter((t) => t.state === 'en_route');
    if (moving.length) bus.emit('agent.thinking', { text: `Re-scoring ${moving.length} truck(s) on the road after ${trigger.replace('_', ' ')}.`, trigger });
    for (const t of moving) {
      if (frozen.has(t.id)) continue;
      const opts = world.scoreOptions(t.id);
      const best = opts[0];
      const current = opts.find((o) => o.port === t.port && o.lane === t.lane);
      if (!best || !current || (best.port === t.port && best.lane === t.lane)) continue;
      if (best.score + REPLAN_MARGIN > current.score) continue;
      act({ kind: 'reassign', truckId: t.id, port: best.port, lane: best.lane }, best,
        `Rerouting Truck ${n(t.id)} to ${portName(best.port)} ${laneName(best.lane)}`, trigger);
    }
  }

  function queueReportCall(): void {
    if (queueCallDone) return;
    const view = world.view('linea');
    const inLine = (t: Truck) => t.port === 'otay_mesa' && (t.state === 'in_queue_mx' || t.state === 'in_queue_us');
    const driver = view.trucks.find((t) => t.id === 'T4' && inLine(t)) ?? view.trucks.find(inLine);
    if (!driver) return;
    queueCallDone = true;
    const callId = ulid();
    const extra = Math.round(world.truthMxNow ? world.truthMxNow('otay_mesa') : 60);
    script(
      () => bus.emit('agent.thinking', { text: `CBP shows only the US side. ${driver.driverName} (Truck ${n(driver.id)}) is in line at Otay Mesa — asking for the Mexican-side queue.`, trigger: 'port_change' }),
      () => bus.emit('call.started', { callId, kind: 'driver', truckId: driver.id, personName: driver.driverName, mode: 'simulated', language: 'es-MX', purpose: 'Ask for Mexican-side queue length at Otay Mesa' }),
      () => bus.emit('call.status', { callId, status: 'ringing' }),
      () => bus.emit('call.status', { callId, status: 'in_progress' }),
      () => say(callId, 'linea', `Hola ${driver.driverName}, soy Linea, el asistente automatizado de despacho de Transportes Mesa. ¿Qué tan larga está la fila del lado mexicano?`, 'es-MX',
        `Hi ${driver.driverName}, this is Linea, Transportes Mesa's automated dispatch assistant. How long is the line on the Mexican side?`),
      () => say(callId, 'human', 'Estoy como a dos kilómetros, del lado mexicano. Casi no se mueve.', 'es-MX', "I'm about two kilometers back, on the Mexican side. It's barely moving."),
      () => {
        world.reportQueue({ portId: 'otay_mesa', lengthKm: 2, extraWaitMin: extra, reportedBy: driver.id });
        bus.emit('call.tool', { callId, tool: 'report_queue', args: { portId: 'otay_mesa', lengthKm: 2, extraWaitMin: extra }, result: `Recorded +${extra} min Mexican-side wait` });
      },
      () => say(callId, 'linea', 'Gracias. Sigue en la fila, ya replaneé a los demás camiones.', 'es-MX', "Thanks. Stay in line — I've re-planned the other trucks."),
      () => {
        bus.emit('call.status', { callId, status: 'completed' });
        bus.emit('call.ended', { callId, kind: 'driver', outcome: 'completed', durationSec: 41, summary: `${driver.driverName}: ~2 km Mexican-side queue at Otay (+${extra} min).`, costUsd: 0 });
      },
    );
  }

  function missedCall(): void {
    if (missedCallDone) return;
    missedCallDone = true;
    const tripId = ulid();
    const attempt = () => {
      const callId = ulid();
      return [
        () => bus.emit('call.started', { callId, kind: 'driver', truckId: 'T6', personName: 'Iván', mode: 'simulated', language: 'es-MX', purpose: 'Confirm departure plan for Truck 6' }),
        () => bus.emit('call.status', { callId, status: 'ringing' }),
        () => bus.emit('call.status', { callId, status: 'no_answer' }),
        () => bus.emit('call.ended', { callId, kind: 'driver', outcome: 'no_answer', durationSec: 30, summary: 'Iván did not answer.', costUsd: 0 }),
      ];
    };
    script(
      ...attempt(),
      ...attempt(),
      () => bus.emit('watchdog.trip', {
        tripId, kind: 'no_answer', truckId: 'T6', title: 'Truck 6 not answering', detail: 'Two call attempts to Iván went unanswered. Retrying stopped; plan continues on the last confirmed instructions.',
        evidence: ['call 1: no answer (30 s)', 'call 2: no answer (30 s)'], response: 'blocked',
      }),
    );
  }

  return {
    trigger(reason: string, detail?: Record<string, unknown>): void {
      try {
        const truckId = typeof detail?.truckId === 'string' ? detail.truckId : null;
        switch (reason) {
          case 'truck_ready':
          case 'hold_expired':
            if (truckId) decide(truckId, reason);
            break;
          case 'port_change':
            replan(reason);
            if (detail?.portId === 'otay_mesa' && detail?.lane === 'standard' && Number(detail?.waitMin) >= 90) queueReportCall();
            break;
          case 'queue_report':
            replan(reason);
            break;
          case 'heartbeat':
            if (world.isScenarioFlag('missed_call_T6')) missedCall();
            break;
          default:
            break;
        }
      } catch (err) {
        console.error(`[mock] trigger ${reason} failed`, err);
      }
    },
    handleControl(cmd: { cmd: string }): void {
      try {
        switch (cmd.cmd) {
          case 'request_queue_report':
            queueCallDone = false;
            queueReportCall();
            break;
          case 'budget_squeeze':
            capUsd = 0.1;
            budgetState = 'tripped';
            bus.emit('watchdog.trip', {
              tripId: ulid(), kind: 'budget', truckId: null, title: 'Budget squeezed', detail: 'Cap set to used + $0.10. Degrading to the cheaper model; non-priority calls blocked.',
              evidence: ['cap $0.10'], response: 'degraded',
            });
            emitStatus();
            break;
          case 'chaos_flip': {
            const t = world.getTruck('T7');
            if (!t) break;
            for (let i = 0; i < 3; i++) {
              const port = (world.getTruck('T7')?.port ?? 'otay_mesa') === 'otay_mesa' ? 'tecate' : 'otay_mesa';
              const a: WorldAction = { kind: 'reassign', truckId: 'T7', port, lane: 'standard' };
              if (guardOscillation('T7', 'reassign_truck', { ...a, origin: 'chaos' })) break;
              const res = world.applyAction(a);
              gate('reassign_truck', { ...a }, res.ok ? 'allowed' : 'blocked', res.ok ? undefined : res.message);
            }
            break;
          }
          default:
            break;
        }
      } catch (err) {
        console.error(`[mock] control ${cmd.cmd} failed`, err);
      }
    },
    stop(): void {
      off();
    },
  };
}
