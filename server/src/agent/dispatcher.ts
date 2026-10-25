// Dispatcher loop (TRACK_B §B1): coalesced triggers → one Claude request at a time → watchdog gate → world.
import Anthropic from '@anthropic-ai/sdk';
import { ulid } from 'ulid';
import type { ActionKind, PayloadOf, SourceRef } from '../../../shared/types';
import type { OptionScore, WorldApi } from '../world/api';
import { claudeCost, usageTokens } from './cost';
import { DISPATCHER_SYSTEM } from './prompts';
import { fmtClock, MIN, ms, portLabel, truckLabel, truncate } from './time';
import { ACTION_OF, DISPATCH_TOOLS, toProposal } from './tools';
import type { ProposedAction, Voice } from './types';
import type { Watchdog } from './watchdog';

const DEBOUNCE = 3 * MIN;
// truck_ready / hold_expired skip the debounce too: the world auto-dispatches after 10 sim-min without an action.
const IMMEDIATE = new Set(['queue_report', 'request_queue_report', 'call_ended', 'dispatcher_decision', 'truck_ready', 'hold_expired']);

type DecisionPayload = PayloadOf<'agent.decision'>;

export type Dispatcher = ReturnType<typeof createDispatcher>;

/** Sonnet 5.5 turns thinking off with `between_tools`; Haiku 5.5 with `disabled`. Single-shot planning doesn't need it. */
export function thinkingOff(model: string): Anthropic.ThinkingConfigParam | undefined {
  if (model.startsWith('claude-sonnet-5-5')) return { type: 'between_tools' };
  if (model.startsWith('claude-haiku-5-5')) return { type: 'disabled' };
  return undefined;
}

export function createDispatcher(world: WorldApi, watchdog: Watchdog, voice: Voice, client = new Anthropic({ maxRetries: 0 })) {
  const bus = world.bus;
  const pending: string[] = [];
  let immediate = false;
  let running = false;
  let stopped = false;
  let lastRequestAt = -Infinity;
  const recentDecisions: { t: string; title: string }[] = [];

  const off = bus.on((e) => {
    if (e.type === 'agent.decision' && e.payload.action !== 'no_action') {
      recentDecisions.push({ t: fmtClock(e.simTime), title: e.payload.title });
      while (recentDecisions.length > 10) recentDecisions.shift();
    }
  });

  function trigger(reason: string, detail?: Record<string, unknown>) {
    if (stopped) return;
    const line = describeTrigger(reason, detail);
    if (!pending.includes(line)) pending.push(line);
    if (IMMEDIATE.has(reason) || reason.startsWith('operator')) immediate = true;
    pump();
  }

  function pump() {
    if (running || stopped || !pending.length || watchdog.isPaused() || watchdog.isStopped()) return;
    if (!immediate && ms(world.now()) - lastRequestAt < DEBOUNCE) return;
    const reasons = pending.splice(0);
    immediate = false;
    running = true;
    run(reasons)
      .catch((err) => console.error('[dispatcher] request failed', err))
      .finally(() => {
        running = false;
        lastRequestAt = ms(world.now());
      });
  }
  // Debounce windows are in sim time, so re-check on a wall-clock poll.
  const timer = setInterval(pump, 250);
  timer.unref?.();

  async function run(triggers: string[]) {
    const model = watchdog.currentModel();
    const requestId = ulid();
    const brief = buildBrief(triggers);
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: 2048,
      system: [{ type: 'text', text: DISPATCHER_SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: DISPATCH_TOOLS,
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: `<state>\n${JSON.stringify(brief)}\n</state>` }],
    };
    const thinking = thinkingOff(model);
    if (thinking) params.thinking = thinking;
    // Low effort: fewer, consolidated tool calls and no long preamble — a plan must land well inside
    // the world's 10-sim-min agent timeout (10 wall-seconds at 60×).
    params.output_config = { effort: 'low' };

    let msg: Anthropic.Message;
    try {
      msg = await createWithRetry(params);
    } catch (err) {
      console.error('[dispatcher] Claude unavailable, using optimizer fallback:', (err as Error).message);
      bus.emit('agent.thinking', { text: 'Planner unavailable — used optimizer fallback', trigger: triggers.join('; ') });
      mockFallback(triggers);
      return;
    }

    const costUsd = claudeCost(model, msg.usage);
    watchdog.addCost(costUsd);
    bus.emit('agent.usage', { requestId, purpose: 'dispatch', model, ...usageTokens(msg.usage), costUsd });

    const prose = msg.content
      .map((b) => (b.type === 'text' ? b.text : b.type === 'thinking' ? b.thinking : ''))
      .join(' ')
      .trim();
    if (prose) bus.emit('agent.thinking', { text: truncate(prose, 140), trigger: triggers.join('; ') });
    if (msg.stop_reason === 'refusal') {
      bus.emit('agent.thinking', { text: 'Planner declined this request — used optimizer fallback', trigger: triggers.join('; ') });
      mockFallback(triggers);
      return;
    }

    const toolUses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    // A max_tokens stop can cut the last tool call off mid-input — don't act on a partial call.
    if (msg.stop_reason === 'max_tokens' && toolUses.length) toolUses.pop();
    const decisions: DecisionPayload[] = [];
    for (const block of toolUses) {
      const p = toProposal(block.id, block.name, block.input, world.now(), 'agent');
      if (!p) continue;
      const d = await gateAndExecute(p, model);
      if (d) decisions.push(d);
    }
    const share = decisions.length ? costUsd / decisions.length : 0;
    for (const d of decisions) bus.emit('agent.decision', { ...d, costUsd: share });
    watchdog.afterRequest();
  }

  async function createWithRetry(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    try {
      return await client.messages.create(params);
    } catch (err) {
      if (!retryable(err)) throw err;
      await new Promise((r) => setTimeout(r, 2000));
      return client.messages.create(params);
    }
  }

  /** Gate → execute. Returns the decision payload (without cost) if executed. */
  async function gateAndExecute(p: ProposedAction, model: string): Promise<DecisionPayload | null> {
    const g = watchdog.gate(p);
    if (g.verdict !== 'allowed') return null;
    const res = await execute(p);
    if (!res.ok) {
      bus.emit('agent.thinking', { text: truncate(`${truckLabel(p.truckId ?? '')}: ${res.message}`, 140), trigger: p.tool });
      return null;
    }
    const a = p.args;
    return {
      decisionId: ulid(),
      action: ACTION_OF[p.tool] as ActionKind,
      truckIds: p.truckId ? [p.truckId] : [],
      title: truncate(String(a.title ?? defaultTitle(p)), 80),
      detail: res.detail,
      reasoning: String(a.reasoning ?? ''),
      sources: resolveSources(p.sourceIds),
      costUsd: 0,
      model,
      origin: p.origin,
    };
  }

  async function execute(p: ProposedAction): Promise<{ ok: boolean; message: string; detail: string }> {
    const t = p.truckId;
    switch (p.tool) {
      case 'hold_truck': {
        if (!t || !p.until) return { ok: false, message: 'hold needs truck_id and a valid "until" time', detail: '' };
        const r = world.applyAction({ kind: 'hold', truckId: t, until: p.until });
        return { ...r, detail: `Hold at the yard until ${fmtClock(p.until)}` };
      }
      case 'dispatch_truck':
      case 'reassign_truck': {
        if (!t || !p.port || !p.lane) return { ok: false, message: `${p.tool} needs truck_id, port and lane`, detail: '' };
        const beforePort = world.getTruck(t)?.port ?? null; // read before applyAction mutates the truck
        const kind = p.tool === 'dispatch_truck' ? 'dispatch' : 'reassign';
        const r = world.applyAction({ kind, truckId: t, port: p.port, lane: p.lane });
        const from = beforePort && beforePort !== p.port ? `${portLabel(beforePort)} → ` : '';
        return { ...r, detail: `${from}${portLabel(p.port)} · ${p.lane} lane` };
      }
      case 'call_driver': {
        if (!t || !p.goal) return { ok: false, message: 'call_driver needs truck_id and goal', detail: '' };
        const instruction = typeof p.args.instruction === 'string' ? p.args.instruction : undefined;
        await voice.startDriverCall({ truckId: t, goal: p.goal, instruction, operator: p.args.operator === true });
        const name = world.getTruck(t)?.driverName ?? truckLabel(t);
        return { ok: true, message: 'calling', detail: `Calling ${name} · ${p.goal.replace(/_/g, ' ')}` };
      }
      case 'escalate_to_dispatcher': {
        const summary = String(p.args.summary ?? '');
        const questions = Array.isArray(p.args.questions) ? (p.args.questions as unknown[]).map(String).slice(0, 2) : [];
        const escalationId = ulid();
        const callId = await voice.startDispatcherCall({ summary, questions, tripIds: [] });
        bus.emit('escalation', { escalationId, to: 'Ana', tripIds: [], summary, callId });
        return { ok: true, message: 'escalated', detail: summary };
      }
      case 'no_action':
        return { ok: true, message: 'no action', detail: String(p.args.reasoning ?? '') };
    }
  }

  function defaultTitle(p: ProposedAction): string {
    const t = p.truckId ? truckLabel(p.truckId) : '';
    switch (p.tool) {
      case 'hold_truck':
        return `Holding ${t} at the yard${p.until ? ` until ${fmtClock(p.until)}` : ''}`;
      case 'dispatch_truck':
        return `Sending ${t} to ${portLabel(p.port)}`;
      case 'reassign_truck':
        return `Rerouting ${t} to ${portLabel(p.port)}`;
      case 'call_driver':
        return `Calling ${t}'s driver`;
      case 'escalate_to_dispatcher':
        return 'Calling Ana for a decision';
      case 'no_action':
        return 'No change needed';
    }
  }

  function resolveSources(ids: string[]): SourceRef[] {
    const all = new Map(world.sources().map((s) => [s.id, s]));
    return ids.map((id) => all.get(id)).filter((s): s is SourceRef => !!s);
  }

  /** Optimizer fallback: best option for the trucks named in the triggers (or every truck waiting at the yard). */
  function mockFallback(triggers: string[]) {
    const named = new Set(triggers.flatMap((t) => [...t.matchAll(/\bT(\d+)\b/g)].map((m) => `T${m[1]}`)));
    const trucks = world
      .view()
      .trucks.filter((t) => (named.size ? named.has(t.id) : true) && (t.state === 'at_yard' || (t.state === 'held' && !!t.heldUntil && ms(t.heldUntil) <= ms(world.now()))));
    for (const truck of trucks) {
      const best: OptionScore | undefined = world.scoreOptions(truck.id)[0];
      if (!best) continue;
      const go = best.option === 'go_now';
      const p: ProposedAction = {
        toolCallId: ulid(),
        tool: go ? 'dispatch_truck' : 'hold_truck',
        args: { truck_id: truck.id, ...(go ? { port: best.port, lane: best.lane } : { until: fmtClock(best.departAt) }) },
        truckId: truck.id,
        port: go ? best.port : undefined,
        lane: go ? best.lane : undefined,
        until: go ? undefined : best.departAt,
        sourceIds: best.sourceIds,
        origin: 'mock',
      };
      p.args.title = go ? `Sending ${truckLabel(truck.id)} to ${portLabel(best.port)}` : `Holding ${truckLabel(truck.id)} until ${fmtClock(best.departAt)}`;
      p.args.reasoning = best.explanation;
      void gateAndExecute(p, 'optimizer').then((d) => d && bus.emit('agent.decision', d));
    }
  }

  // ---------- state brief ----------
  function buildBrief(triggers: string[]) {
    const view = world.view('linea');
    const nowIso = world.now();
    const ports = view.ports.map((p) => ({
      id: p.id,
      standardWaitMin: p.standard.waitMin,
      fastWaitMin: p.fast.waitMin,
      mxSideExtraMin: p.mxSideExtraMin,
      sources: [p.standard.source.id, p.fast.waitMin != null ? p.fast.source.id : null, p.mxSideSource?.id ?? null].filter(Boolean),
    }));
    const trucks = view.trucks
      // Not-yet-loaded trucks can't be dispatched; the world fires truck_ready when they are.
      .filter((t) => t.state !== 'delivered' && !(t.state === 'at_yard' && ms(t.readyAt) > ms(nowIso)))
      .map((t) => {
        const last = watchdog.lastCalledAt(t.id);
        return {
          id: t.id,
          driver: t.driverName,
          cargo: t.cargo,
          priority: t.priority,
          fastEligible: t.fastEligible,
          state: t.state,
          port: t.port,
          lane: t.lane,
          heldUntil: t.heldUntil ? fmtClock(t.heldUntil) : null,
          deadline: fmtDeadline(t.deadline, nowIso),
          minutesInLine: Math.round(t.minutesInLine),
          canTakeCall: watchdog.canCall(t.id),
          lastCalledAt: last != null ? fmtClock(new Date(last).toISOString()) : null,
          frozen: watchdog.isFrozen(t.id) || undefined,
          options: safeOptions(t.id).slice(0, 3).map((o) => ({
            option: o.option,
            port: o.port,
            lane: o.lane,
            departAt: fmtClock(o.departAt),
            expectedLineMin: Math.round(o.expectedLineMin),
            lateMin: Math.round(o.lateMin),
            score: Math.round(o.score),
            explanation: o.explanation,
            sourceIds: o.sourceIds,
          })),
        };
      });
    return {
      now: fmtClock(nowIso),
      triggers,
      ports,
      trucks,
      recentDecisions,
      watchdog: {
        budget: { usedUsd: round2(watchdog.usedUsd()), capUsd: round2(watchdog.capUsd()) },
        blockedRecently: watchdog.blockedRecently(),
      },
      citeableSourceIds: world.sources().map((s) => s.id),
    };
  }

  function safeOptions(truckId: string): OptionScore[] {
    try {
      return world.scoreOptions(truckId);
    } catch {
      return [];
    }
  }

  return {
    trigger,
    stop() {
      stopped = true;
      clearInterval(timer);
      off();
    },
    /** exposed for chaos + tests */
    gateAndExecute,
  };
}

function describeTrigger(reason: string, detail?: Record<string, unknown>): string {
  if (!detail || !Object.keys(detail).length) return reason;
  const parts: string[] = [];
  if (typeof detail.truckId === 'string') parts.push(truckLabel(detail.truckId));
  if (typeof detail.portId === 'string') parts.push(String(detail.portId));
  if (typeof detail.lane === 'string') parts.push(String(detail.lane));
  if (detail.prevWaitMin != null || detail.waitMin != null) parts.push(`${detail.prevWaitMin ?? '?'}→${detail.waitMin ?? '?'}`);
  const rest = Object.entries(detail).filter(([k]) => !['truckId', 'portId', 'lane', 'prevWaitMin', 'waitMin'].includes(k));
  for (const [k, v] of rest.slice(0, 3)) parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  return truncate(`${reason}: ${parts.join(' ')}`, 160);
}

function fmtDeadline(deadline: string, nowIso: string): string {
  const days = Math.floor((ms(deadline) - 7 * 3600_000) / 86_400_000) - Math.floor((ms(nowIso) - 7 * 3600_000) / 86_400_000);
  return fmtClock(deadline) + (days >= 1 ? ' tomorrow' : '');
}

function retryable(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) return true;
  return err instanceof Anthropic.APIError && typeof err.status === 'number' && err.status >= 500;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
