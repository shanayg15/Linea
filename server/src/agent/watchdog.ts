// Watchdog gate (TRACK_B §B4). Every proposed action — agent, chaos, mock fallback — goes through gate().
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Lane, PayloadOf, PortId, TripKind, WatchdogState, WatchdogStatus } from '../../../shared/types';
import type { WorldApi } from '../world/api';
import { callCost, MODELS } from './cost';
import { fmtClock, MIN, ms, portLabel, toIso, truckLabel } from './time';
import type { BudgetState, DispatcherDecision, GateResult, Origin, ProposedAction, Voice } from './types';

const IDEMPOTENCY_BUCKET = 10 * MIN;
const OSC_WINDOW = 15 * MIN;
const REPEAT_TOOL_WINDOW = 20 * MIN;
const REPEAT_CALL_WINDOW = 20 * MIN;
const ESCALATION_BATCH = 2 * MIN;
const STATUS_EVERY = 10 * MIN;
const PAUSE_FOR = 30 * MIN;
const LOCK_FOR = 30 * MIN;
const TRUCK_IDLE_USD_PER_MIN = 1.5; // assumption: truck idle cost ≈ $90/h
const NO_PROGRESS_SAMPLES = 4;

interface Assignment {
  port: PortId;
  lane: Lane;
  t: number;
  change: boolean; // false for the initial dispatch / seed
  tecateWait: number | null;
}

interface Trip {
  tripId: string;
  kind: TripKind;
  truckId: string | null;
  title: string;
  detail: string;
  question?: string;
  origin: Origin;
}

export interface DispatcherControl {
  trigger(reason: string, detail?: Record<string, unknown>): void;
  stop(): void;
}

export interface WatchdogOptions {
  autoTick?: boolean; // default true; tests drive tick() by hand
}

export type Watchdog = ReturnType<typeof createWatchdog>;

export function createWatchdog(world: WorldApi, opts: WatchdogOptions = {}) {
  const bus = world.bus;
  const now = () => ms(world.now());

  let voice: Voice | null = null;
  let usedUsd = 0;
  let capUsd = Number(process.env.BUDGET_CAP_USD || 3);
  let budgetState: BudgetState = 'ok';
  let degradedAnnounced = false;
  let stopAnnounced = false;

  const seenKeys = new Map<string, number>(); // idempotency key → sim ms
  const toolAttempts = new Map<string, number[]>(); // normalized args → sim ms of non-blocked attempts
  const assignments = new Map<string, Assignment[]>();
  const frozen = new Set<string>();
  const lockedUntil = new Map<string, number>();
  const reassignBenefit = new Map<string, { min: number; t: number }>();
  const lastCalledAt = new Map<string, number>();
  const lastEscalatedAt = new Map<string, number>(); // truckId → sim ms Ana was last called about it
  const repeatCallBlocks = new Map<string, number>();
  const noAnswerCount = new Map<string, number>();
  const stoppedDrivers = new Set<string>();
  const blockedRecently: { t: number; text: string }[] = [];
  let lastMaterialChange = -Infinity;

  const progress: { delay: number; used: number }[] = [];
  let pausedUntil = -Infinity;
  let noProgressTripId: string | null = null;

  const openTrips = new Map<string, Trip>();
  let batch: Trip[] = [];
  let batchDeadline: number | null = null;
  const escalatedTrips = new Map<string, string[]>(); // escalationId → tripIds (awaiting Ana)
  let lastStatusAt = -Infinity;

  // Material changes un-block a repeat call (§B4.6).
  const off = bus.on((e) => {
    if (e.type === 'port.update') {
      const p = e.payload;
      if (p.waitMin != null && p.prevWaitMin != null && Math.abs(p.waitMin - p.prevWaitMin) >= 15) lastMaterialChange = ms(e.simTime);
    } else if (e.type === 'queue.report') {
      lastMaterialChange = ms(e.simTime);
    }
  });

  // ---------- helpers ----------
  function key(p: ProposedAction): string {
    return [p.tool, p.truckId ?? (Array.isArray(p.args.truck_ids) ? (p.args.truck_ids as string[]).join(',') : ''), p.port ?? '', p.lane ?? '', p.until ?? '', p.goal ?? ''].join('|');
  }

  function idempotencyKey(p: ProposedAction): string {
    const bucket = Math.floor(now() / IDEMPOTENCY_BUCKET);
    // A flip back to an earlier assignment isn't a duplicate — include where the truck is now,
    // otherwise A→B→A is deduped before the oscillation check can see it.
    // A repeat of the action that produced the current assignment keys to the same history position.
    let from = '';
    if (p.truckId && (p.tool === 'reassign_truck' || p.tool === 'dispatch_truck')) {
      const h = assignments.get(p.truckId) ?? [];
      const cur = currentAssignment(p.truckId);
      const repeat = !!cur && cur.port === p.port && cur.lane === p.lane && h.length > 0;
      const fromEntry = repeat ? h[h.length - 2] : cur;
      from = `${fromEntry ? `${fromEntry.port}/${fromEntry.lane}` : ''}#${repeat ? h.length - 1 : h.length}`;
    }
    return createHash('sha1').update(`${key(p)}|${from}|${bucket}`).digest('hex').slice(0, 16);
  }

  function currentAssignment(truckId: string): Assignment | null {
    const h = assignments.get(truckId);
    if (h?.length) return h[h.length - 1]!;
    const t = world.getTruck(truckId);
    if (t?.port && t.lane) return { port: t.port, lane: t.lane, t: -Infinity, change: false, tecateWait: null };
    return null;
  }

  function tecateWait(): number | null {
    return world.view().ports.find((p) => p.id === 'tecate')?.standard.waitMin ?? null;
  }

  function short(port: PortId, lane: Lane): string {
    return (port === 'otay_mesa' ? 'Otay' : 'Tecate') + (lane === 'fast' ? ' FAST' : '');
  }

  function changesInWindow(truckId: string): Assignment[] {
    const t = now();
    return (assignments.get(truckId) ?? []).filter((a) => a.change && t - a.t <= OSC_WINDOW);
  }

  function driverName(truckId: string | null): string {
    return (truckId && world.getTruck(truckId)?.driverName) || (truckId ? truckLabel(truckId) : 'the driver');
  }

  function optionScoreFor(truckId: string, port: PortId | undefined, lane: Lane | undefined): number | null {
    const opts = world.scoreOptions(truckId);
    const hit = opts.find((o) => o.option === 'go_now' && o.port === port && o.lane === lane) ?? opts.find((o) => o.port === port && o.lane === lane);
    return hit ? hit.score : null;
  }

  function emitTrip(
    kind: TripKind,
    truckId: string | null,
    title: string,
    detail: string,
    evidence: string[],
    response: PayloadOf<'watchdog.trip'>['response'],
    origin: Origin,
    question?: string,
  ): Trip {
    const trip: Trip = { tripId: ulid(), kind, truckId, title, detail, question, origin };
    openTrips.set(trip.tripId, trip);
    bus.emit('watchdog.trip', { tripId: trip.tripId, kind, truckId, title, detail, evidence, response });
    if (response === 'escalated' || response === 'paused' || response === 'stopped' || (kind === 'oscillation' && response === 'blocked')) {
      queueEscalation(trip);
    }
    return trip;
  }

  function noteBlocked(text: string) {
    blockedRecently.push({ t: now(), text });
    while (blockedRecently.length > 6) blockedRecently.shift();
  }

  // ---------- budget ----------
  function evaluateBudget() {
    const ratio = capUsd > 0 ? usedUsd / capUsd : 1;
    const prev = budgetState;
    budgetState = ratio >= 1 ? 'stopped' : ratio >= 0.9 ? 'critical' : ratio >= 0.7 ? 'warn' : 'ok';
    if (budgetState !== 'ok' && !degradedAnnounced) {
      degradedAnnounced = true;
      emitTrip(
        'budget',
        null,
        `Budget at ${Math.round(ratio * 100)}% — switched to Haiku`,
        `Spent $${usedUsd.toFixed(2)} of $${capUsd.toFixed(2)}. Dispatcher now runs on ${MODELS.degraded}.`,
        [`Used $${usedUsd.toFixed(2)}`, `Cap $${capUsd.toFixed(2)}`],
        'degraded',
        'agent',
      );
    }
    if (budgetState === 'stopped' && !stopAnnounced) {
      stopAnnounced = true;
      emitTrip(
        'budget',
        null,
        'Budget exhausted — dispatcher stopped',
        `Spent $${usedUsd.toFixed(2)} of the $${capUsd.toFixed(2)} cap. Trucks fall back to automatic dispatch.`,
        [`Used $${usedUsd.toFixed(2)}`, `Cap $${capUsd.toFixed(2)}`],
        'stopped',
        'agent',
        'Should I raise the budget so I can keep planning?',
      );
      dispatcher?.stop();
    }
    if (prev !== budgetState) emitStatus();
  }

  // ---------- gate ----------
  function gate(p: ProposedAction): GateResult {
    const idem = idempotencyKey(p);
    const result = check(p, idem);
    if (result.verdict === 'allowed') record(p, idem);
    else if (result.verdict === 'blocked') noteBlocked(`${p.tool} ${p.truckId ?? ''}${p.port ? ` → ${p.port}` : ''} (${result.tripKind ?? 'blocked'})`.trim());
    bus.emit('tool.gate', {
      toolCallId: p.toolCallId,
      tool: p.tool,
      args: p.args,
      idempotencyKey: idem,
      verdict: result.verdict,
      reason: result.reason,
      tripKind: result.tripKind,
      origin: p.origin,
    });
    emitStatus();
    return result;
  }

  function blocked(reason: string, tripKind: TripKind, idem: string): GateResult {
    return { verdict: 'blocked', reason, tripKind, idempotencyKey: idem };
  }

  function check(p: ProposedAction, idem: string): GateResult {
    const t = now();
    // 1. cite-or-block
    if (p.tool !== 'no_action') {
      const known = new Set(world.sources().map((s) => s.id));
      const bad = p.sourceIds.filter((id) => !known.has(id));
      if (p.sourceIds.length === 0) return blocked('No sources cited', 'uncited', idem);
      if (bad.length) return blocked(`Unknown source ids: ${bad.join(', ')}`, 'uncited', idem);
    }
    // 2. idempotency
    if (p.tool !== 'no_action' && seenKeys.has(idem)) {
      return { verdict: 'deduped', reason: 'Same action already taken in this 10-minute window', idempotencyKey: idem };
    }
    // 3. budget
    if (budgetState === 'stopped' && p.tool !== 'no_action') return blocked('Budget exhausted — dispatcher stopped', 'budget', idem);
    if (budgetState === 'critical' && p.tool === 'call_driver' && p.truckId && world.getTruck(p.truckId)?.priority === 'standard') {
      return blocked('Budget above 90% — calls limited to priority loads', 'budget', idem);
    }
    // 4. oscillation
    if ((p.tool === 'reassign_truck' || p.tool === 'dispatch_truck') && p.truckId) {
      const r = checkOscillation(p, idem);
      if (r) return r;
    }
    // 5. repeat tool
    if (p.tool !== 'no_action') {
      const k = key(p);
      const recent = (toolAttempts.get(k) ?? []).filter((x) => t - x <= REPEAT_TOOL_WINDOW);
      if (recent.length >= 2) {
        emitTrip(
          'repeat_tool',
          p.truckId,
          `Repeated ${p.tool.replace(/_/g, ' ')} blocked`,
          `Linea proposed the same ${p.tool} ${recent.length + 1} times in 20 minutes.`,
          recent.map((x) => `${fmtClock(toIso(x))} ${p.tool}`).concat(`${fmtClock(world.now())} ${p.tool} (blocked)`),
          'blocked',
          p.origin,
        );
        return blocked('Same tool and arguments 3× in 20 minutes', 'repeat_tool', idem);
      }
    }
    // 6. repeat call (+ drivers we stopped calling after no-answers)
    if (p.tool === 'call_driver' && p.truckId) {
      if (stoppedDrivers.has(p.truckId)) return blocked(`${driverName(p.truckId)} didn't answer twice — not calling again`, 'no_answer', idem);
      const last = lastCalledAt.get(p.truckId);
      if (last != null && t - last < REPEAT_CALL_WINDOW && lastMaterialChange <= last) {
        const n = (repeatCallBlocks.get(p.truckId) ?? 0) + 1;
        repeatCallBlocks.set(p.truckId, n);
        if (n === 2) {
          emitTrip(
            'repeat_call',
            p.truckId,
            `Stopped repeat calls to ${driverName(p.truckId)}`,
            `Called ${Math.round((t - last) / MIN)} min ago and nothing material has changed since.`,
            [`${fmtClock(toIso(last))} last call`, `${fmtClock(world.now())} call (blocked)`],
            'blocked',
            p.origin,
          );
        }
        return blocked(`Called ${Math.round((t - last) / MIN)} min ago, nothing changed since`, 'repeat_call', idem);
      }
    }
    // Same rule for Ana: every escalation is a human touch, so don't call her twice about the same truck.
    if (p.tool === 'escalate_to_dispatcher') {
      const again = escalationTrucks(p).find((id) => {
        const last = lastEscalatedAt.get(id);
        return last != null && t - last < REPEAT_CALL_WINDOW && lastMaterialChange <= last;
      });
      if (again) {
        const mins = Math.round((t - lastEscalatedAt.get(again)!) / MIN);
        return blocked(`Ana was called about ${truckLabel(again)} ${mins} min ago, nothing changed since`, 'repeat_call', idem);
      }
    }
    // 7. not worth it
    if (p.tool === 'call_driver' && p.truckId && (p.goal === 'give_instruction' || p.goal === 'check_status')) {
      const truck = world.getTruck(p.truckId);
      const opts = world.scoreOptions(p.truckId);
      const best = opts[0]?.score ?? 0;
      const cur = truck ? optionScoreFor(p.truckId, truck.port ?? undefined, truck.lane ?? undefined) : null;
      let benefitMin = cur != null ? Math.max(0, cur - best) : 0;
      const rb = reassignBenefit.get(p.truckId);
      if (rb && t - rb.t <= 10 * MIN) benefitMin = Math.max(benefitMin, rb.min);
      const benefitUsd = benefitMin * TRUCK_IDLE_USD_PER_MIN;
      const costUsd = callCost(90) + 0.01;
      if (benefitUsd < costUsd) {
        emitTrip(
          'not_worth_it',
          p.truckId,
          `Skipped a call to ${driverName(p.truckId)}`,
          `Expected benefit $${benefitUsd.toFixed(2)} is below the ~$${costUsd.toFixed(2)} call cost.`,
          [`Benefit ${benefitMin.toFixed(0)} min × $${TRUCK_IDLE_USD_PER_MIN}/min (assumed idle cost)`, `Call ≈ $${costUsd.toFixed(2)}`],
          'blocked',
          p.origin,
        );
        return blocked(`Benefit $${benefitUsd.toFixed(2)} < call cost $${costUsd.toFixed(2)}`, 'not_worth_it', idem);
      }
    }
    return { verdict: 'allowed', idempotencyKey: idem };
  }

  function checkOscillation(p: ProposedAction, idem: string): GateResult | null {
    const truckId = p.truckId!;
    const t = now();
    if (frozen.has(truckId)) return blocked(`${truckLabel(truckId)} is frozen until Ana decides`, 'oscillation', idem);
    const lock = lockedUntil.get(truckId);
    if (lock != null && t < lock) return blocked(`Ana locked ${truckLabel(truckId)}'s assignment until ${fmtClock(toIso(lock))}`, 'oscillation', idem);
    if (!p.port || !p.lane) return null;
    const cur = currentAssignment(truckId);
    if (!cur || (cur.port === p.port && cur.lane === p.lane)) return null; // initial dispatch or no-op
    const window = changesInWindow(truckId);
    const h = assignments.get(truckId) ?? [];
    const prev = h.length >= 2 ? h[h.length - 2]! : null;
    const reverts = !!prev && prev.change && t - prev.t <= OSC_WINDOW && prev.port === p.port && prev.lane === p.lane && cur.change;
    if (window.length + 1 < 3 && !reverts) return null;

    frozen.add(truckId);
    const evidence: string[] = [];
    for (let i = 0; i < h.length; i++) {
      const a = h[i]!;
      if (!a.change || t - a.t > OSC_WINDOW || i === 0) continue;
      const b = h[i - 1]!;
      evidence.push(`${fmtClock(toIso(a.t))} ${short(b.port, b.lane)} → ${short(a.port, a.lane)}${a.tecateWait != null ? ` (Tecate ${a.tecateWait} min)` : ''}`);
    }
    evidence.push(`${fmtClock(world.now())} ${short(cur.port, cur.lane)} → ${short(p.port, p.lane)} (blocked)`);
    const name = driverName(truckId);
    emitTrip(
      'oscillation',
      truckId,
      'Loop detected',
      `${truckLabel(truckId)} reassigned ${window.length + 1}× in ${Math.max(1, Math.round((t - (window[0]?.t ?? t)) / MIN))} min · Blocked · Calling Ana`,
      evidence,
      'blocked',
      p.origin,
      `Should I keep ${name} on ${portLabel(cur.port)}?`,
    );
    return blocked(`Oscillation: ${window.length + 1} changes in 15 min — ${truckLabel(truckId)} frozen`, 'oscillation', idem);
  }

  function record(p: ProposedAction, idem: string) {
    const t = now();
    if (p.tool === 'no_action') return;
    seenKeys.set(idem, t);
    const k = key(p);
    toolAttempts.set(k, [...(toolAttempts.get(k) ?? []).filter((x) => t - x <= REPEAT_TOOL_WINDOW), t]);
    if ((p.tool === 'reassign_truck' || p.tool === 'dispatch_truck') && p.truckId && p.port && p.lane) {
      const cur = currentAssignment(p.truckId);
      if (cur && (cur.port !== p.port || cur.lane !== p.lane)) {
        const before = optionScoreFor(p.truckId, cur.port, cur.lane);
        const after = optionScoreFor(p.truckId, p.port, p.lane);
        if (before != null && after != null) reassignBenefit.set(p.truckId, { min: Math.max(0, before - after), t });
      }
      if (!cur || cur.port !== p.port || cur.lane !== p.lane) {
        const h = assignments.get(p.truckId) ?? (cur ? [cur] : []);
        h.push({ port: p.port, lane: p.lane, t, change: !!cur, tecateWait: tecateWait() });
        assignments.set(p.truckId, h);
      }
    }
    if (p.tool === 'call_driver' && p.truckId) {
      lastCalledAt.set(p.truckId, t);
      repeatCallBlocks.delete(p.truckId);
    }
    if (p.tool === 'escalate_to_dispatcher') for (const id of escalationTrucks(p)) lastEscalatedAt.set(id, t);
  }

  function escalationTrucks(p: ProposedAction): string[] {
    const ids = Array.isArray(p.args.truck_ids) ? p.args.truck_ids.filter((x): x is string => typeof x === 'string') : [];
    return ids.length ? ids : p.truckId ? [p.truckId] : [];
  }

  /** Mark a starting assignment (chaos test) without counting it as a change. */
  function seedAssignment(truckId: string, port: PortId, lane: Lane) {
    assignments.set(truckId, [{ port, lane, t: now(), change: false, tecateWait: tecateWait() }]);
  }

  // ---------- escalation batching ----------
  function queueEscalation(trip: Trip) {
    batch.push(trip);
    if (batchDeadline == null) batchDeadline = now() + ESCALATION_BATCH;
  }

  function flushEscalation() {
    const trips = batch;
    batch = [];
    batchDeadline = null;
    if (!trips.length) return;
    const n = ['', 'One thing needs', 'Two things need', 'Three things need'][trips.length] ?? `${trips.length} things need`;
    const sentences = trips.map((tr) => describeForAna(tr));
    const questions = [...new Set(trips.map((tr) => tr.question).filter((q): q is string => !!q))].slice(0, 2);
    const summary = `${n} you. ${sentences.join(' ')}${questions[0] ? ` ${questions[0]}` : ''}`;
    const tripIds = trips.map((tr) => tr.tripId);
    const escalationId = ulid();
    escalatedTrips.set(escalationId, tripIds);
    const origin: Origin = trips.some((tr) => tr.origin === 'chaos') ? 'chaos' : 'agent';
    const sources = world.sources().filter((s) => s.kind === 'cbp_replay' || s.kind === 'driver_report').slice(0, 4);
    const truckIds = [...new Set(trips.map((tr) => tr.truckId).filter((x): x is string => !!x))];
    for (const id of truckIds) lastEscalatedAt.set(id, now());
    bus.emit('agent.decision', {
      decisionId: ulid(),
      action: 'escalate',
      truckIds,
      title: trips.length > 1 ? `Calling Ana about ${trips.length} issues` : 'Calling Ana for a decision',
      detail: trips.map((tr) => tr.title).join(' · '),
      reasoning: 'The watchdog batched issues that need human judgment into one call.',
      sources,
      costUsd: 0,
      model: 'watchdog',
      origin,
    });
    const startCall = voice ? voice.startDispatcherCall({ summary, questions, tripIds }) : Promise.resolve(null);
    startCall
      .then((callId) => bus.emit('escalation', { escalationId, to: 'Ana', tripIds, summary, callId }))
      .catch((err) => {
        console.error('[watchdog] escalation call failed', err);
        bus.emit('escalation', { escalationId, to: 'Ana', tripIds, summary, callId: null });
      });
  }

  function describeForAna(tr: Trip): string {
    const name = driverName(tr.truckId);
    switch (tr.kind) {
      case 'oscillation':
        return `${name}'s truck keeps flipping between Otay and Tecate because Tecate's feed is flapping.`;
      case 'no_answer':
        return `${name} hasn't answered twice.`;
      case 'no_progress':
        return `My plans aren't reducing delay, so I paused for 30 minutes.`;
      case 'budget':
        return `I've used the whole $${capUsd.toFixed(2)} budget and stopped planning.`;
      default:
        return tr.title + '.';
    }
  }

  // ---------- resolution ----------
  function resolve(d: DispatcherDecision) {
    const t = now();
    const ids = new Set(d.tripIds.filter((id) => openTrips.has(id)));
    if (!ids.size) {
      // Ana's call covers whatever batch is outstanding.
      for (const [, tripIds] of escalatedTrips) tripIds.forEach((id) => openTrips.has(id) && ids.add(id));
    }
    const label: Record<DispatcherDecision['decision'], string> = {
      keep_current: 'Ana: keep current assignment',
      approve_linea_plan: "Ana approved Linea's plan",
      raise_budget: 'Ana raised the budget',
      custom: 'Ana decided',
    };
    for (const id of ids) {
      const tr = openTrips.get(id)!;
      if (tr.kind === 'oscillation' && tr.truckId) {
        frozen.delete(tr.truckId);
        if (d.decision !== 'approve_linea_plan') lockedUntil.set(tr.truckId, t + LOCK_FOR);
      }
      if (tr.kind === 'no_progress') pausedUntil = -Infinity;
      if (tr.kind === 'budget' || d.decision === 'raise_budget') {
        capUsd = Math.max(capUsd, usedUsd) + 1;
        stopAnnounced = false;
        evaluateBudget();
      }
      openTrips.delete(id);
      bus.emit('watchdog.resolved', { tripId: id, resolution: d.note ? `${label[d.decision]} — ${d.note}` : label[d.decision], by: 'dispatcher' });
    }
    for (const [escId, tripIds] of escalatedTrips) if (tripIds.every((id) => !openTrips.has(id))) escalatedTrips.delete(escId);
    emitStatus();
    dispatcher?.trigger('dispatcher_decision', { decision: d.decision });
  }

  // ---------- progress ----------
  function afterRequest() {
    const delay = world.projectFleetDelayMin();
    progress.push({ delay, used: usedUsd });
    while (progress.length > NO_PROGRESS_SAMPLES + 1) progress.shift();
    // WATCHDOG_NO_PROGRESS=off (demo): the spike raises fleet delay no matter what the planner does, which would pause
    // planning and phone Ana off-script. Status still reports the trend.
    const noProgressOn = (process.env.WATCHDOG_NO_PROGRESS ?? 'on').trim().toLowerCase() !== 'off';
    if (noProgressOn && progress.length === NO_PROGRESS_SAMPLES + 1 && !isPaused()) {
      const base = progress[0]!;
      const improved = base.delay - delay;
      const spent = usedUsd - base.used;
      if (improved < 5 && spent >= 0.15) {
        pausedUntil = now() + PAUSE_FOR;
        const trip = emitTrip(
          'no_progress',
          null,
          'No progress — pausing the planner',
          `Fleet delay moved ${improved >= 0 ? '-' : '+'}${Math.abs(improved).toFixed(0)} min over ${NO_PROGRESS_SAMPLES} plans while spending $${spent.toFixed(2)}.`,
          progress.map((s) => `${s.delay.toFixed(0)} min projected · $${s.used.toFixed(2)} spent`),
          'paused',
          'agent',
          'Should I keep the current plan while I pause?',
        );
        noProgressTripId = trip.tripId;
        progress.length = 0;
      }
    }
    emitStatus();
  }

  function isPaused(): boolean {
    return now() < pausedUntil;
  }

  // ---------- voice feedback ----------
  function noAnswer(truckId: string) {
    const n = (noAnswerCount.get(truckId) ?? 0) + 1;
    noAnswerCount.set(truckId, n);
    if (n >= 2 && !stoppedDrivers.has(truckId)) {
      stoppedDrivers.add(truckId);
      const name = driverName(truckId);
      emitTrip(
        'no_answer',
        truckId,
        `${name} didn't answer twice`,
        `Stopped calling ${truckLabel(truckId)}. Asking Ana to follow up.`,
        [`${n} unanswered calls`],
        'escalated',
        'agent',
        `Should someone try ${name} another way?`,
      );
    }
    emitStatus();
  }

  function answered(truckId: string) {
    noAnswerCount.delete(truckId);
  }

  function addCost(usd: number) {
    if (!(usd > 0)) return;
    usedUsd += usd;
    evaluateBudget();
  }

  // ---------- status ----------
  function status(): WatchdogStatus {
    const budget: WatchdogState = budgetState === 'ok' ? 'ok' : budgetState === 'stopped' ? 'tripped' : 'warn';
    let loops: WatchdogState = 'ok';
    let loopDetail = 'No loops';
    if (frozen.size) {
      loops = 'tripped';
      loopDetail = `${[...frozen].map(truckLabel).join(', ')} frozen`;
    } else {
      const warnTruck = [...assignments.keys()].find((id) => changesInWindow(id).length >= 2);
      if (warnTruck) {
        loops = 'warn';
        loopDetail = `${truckLabel(warnTruck)} changed twice in 15 min`;
      }
    }
    const delays = progress.slice(-3).map((s) => s.delay);
    const fleetDelayMin = delays.length ? delays[delays.length - 1]! : safeDelay();
    const diff = delays.length >= 2 ? delays[delays.length - 1]! - delays[0]! : 0;
    const trend = diff < -2 ? 'improving' : diff > 2 ? 'worsening' : 'flat';
    return {
      budget: { state: budget, usedUsd: round(usedUsd), capUsd: round(capUsd), model: currentModel() },
      loops: { state: loops, detail: loopDetail },
      progress: { state: isPaused() ? 'tripped' : trend === 'worsening' ? 'warn' : 'ok', fleetDelayMin: Math.round(fleetDelayMin), trend },
    };
  }

  function safeDelay(): number {
    try {
      return world.projectFleetDelayMin();
    } catch {
      return 0;
    }
  }

  function emitStatus() {
    lastStatusAt = now();
    bus.emit('watchdog.status', status());
  }

  function currentModel(): string {
    return budgetState === 'ok' ? MODELS.dispatch : MODELS.degraded;
  }

  // ---------- clock ----------
  function tick() {
    const t = now();
    if (batchDeadline != null && t >= batchDeadline) flushEscalation();
    if (t - lastStatusAt >= STATUS_EVERY) emitStatus();
    if (noProgressTripId && !isPaused()) {
      const id = noProgressTripId;
      noProgressTripId = null;
      if (openTrips.delete(id)) bus.emit('watchdog.resolved', { tripId: id, resolution: 'Pause ended — planner resumed', by: 'auto' });
      dispatcher?.trigger('heartbeat');
    }
  }
  const timer = opts.autoTick === false ? null : setInterval(tick, 250);
  timer?.unref?.();

  let dispatcher: DispatcherControl | null = null;

  return {
    gate,
    tick,
    status,
    emitStatus,
    afterRequest,
    addCost,
    noAnswer,
    answered,
    resolve,
    seedAssignment,
    currentModel,
    isPaused,
    isStopped: () => budgetState === 'stopped',
    budgetState: () => budgetState,
    usedUsd: () => usedUsd,
    capUsd: () => capUsd,
    lastCalledAt: (truckId: string) => lastCalledAt.get(truckId) ?? null,
    canCall: (truckId: string) => !stoppedDrivers.has(truckId) && !(lastCalledAt.has(truckId) && now() - lastCalledAt.get(truckId)! < REPEAT_CALL_WINDOW),
    isFrozen: (truckId: string) => frozen.has(truckId),
    blockedRecently: () => blockedRecently.filter((b) => now() - b.t <= 30 * MIN).map((b) => b.text),
    attachVoice(v: Voice) {
      voice = v;
    },
    attachDispatcher(d: DispatcherControl) {
      dispatcher = d;
    },
    squeezeBudget() {
      capUsd = usedUsd + 0.1;
      evaluateBudget();
      emitStatus();
    },
    flushEscalation,
    stop() {
      if (timer) clearInterval(timer);
      off();
    },
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
