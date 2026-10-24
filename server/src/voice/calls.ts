// Call registry, live/simulated routing, Twilio call placement, call teardown.
import twilio from 'twilio';
import { ulid } from 'ulid';
import type { PayloadOf } from '../../../shared/types';
import { callCost } from '../agent/cost';
import type { CallGoal, DispatcherDecision, VoiceHooks } from '../agent/types';
import type { WorldApi } from '../world/api';

export interface CallRecord {
  callId: string;
  kind: 'driver' | 'dispatcher';
  mode: 'live' | 'simulated';
  truckId: string | null;
  personName: string;
  language: 'es-MX' | 'en-US';
  purpose: string;
  goal?: CallGoal;
  instruction?: string;
  summary?: string;
  questions?: string[];
  tripIds: string[];
  to?: string;
  callSid?: string;
  startedAtWall: number;
  answeredAtWall?: number;
  status: PayloadOf<'call.status'>['status'] | 'created';
  ended: boolean;
  decision?: DispatcherDecision;
  claudeCostUsd: number;
}

export interface VoiceCtx {
  world: WorldApi;
  hooks: VoiceHooks;
  calls: Map<string, CallRecord>;
  liveActive: string | null;
  liveQueue: CallRecord[];
}

export function publicBaseUrl(): string | null {
  const u = process.env.PUBLIC_BASE_URL?.trim();
  return u ? u.replace(/\/+$/, '') : null;
}

export function liveNumberFor(kind: 'driver' | 'dispatcher', truckId: string | null): string | null {
  if (!publicBaseUrl() || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM_NUMBER) return null;
  if (kind === 'dispatcher') return process.env.PHONE_DISPATCHER_ANA?.trim() || null;
  if (truckId === 'T4') return process.env.PHONE_T4_CARLOS?.trim() || null;
  return null;
}

export function newCall(ctx: VoiceCtx, c: Omit<CallRecord, 'callId' | 'startedAtWall' | 'status' | 'ended' | 'claudeCostUsd'>): CallRecord {
  const call: CallRecord = { ...c, callId: ulid(), startedAtWall: Date.now(), status: 'created', ended: false, claudeCostUsd: 0 };
  ctx.calls.set(call.callId, call);
  return call;
}

export function emitStarted(ctx: VoiceCtx, call: CallRecord) {
  ctx.world.bus.emit('call.started', {
    callId: call.callId,
    kind: call.kind,
    truckId: call.truckId,
    personName: call.personName,
    mode: call.mode,
    language: call.language,
    purpose: call.purpose,
  });
}

export function setStatus(ctx: VoiceCtx, call: CallRecord, status: PayloadOf<'call.status'>['status']) {
  if (call.ended || call.status === status) return;
  call.status = status;
  if (status === 'in_progress') {
    call.answeredAtWall ??= Date.now();
    if (call.truckId) ctx.hooks.onAnswered(call.truckId);
  }
  ctx.world.bus.emit('call.status', { callId: call.callId, status });
}

/** Queue-aware: only one live call at a time. */
export function startLive(ctx: VoiceCtx, call: CallRecord) {
  if (ctx.liveActive) {
    ctx.liveQueue.push(call);
    return;
  }
  ctx.liveActive = call.callId;
  void placeLive(ctx, call);
}

async function placeLive(ctx: VoiceCtx, call: CallRecord) {
  const base = publicBaseUrl()!;
  emitStarted(ctx, call);
  ctx.world.setClockSpeed(1);
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
    const created = await client.calls.create({
      to: call.to!,
      from: process.env.TWILIO_FROM_NUMBER!,
      url: `${base}/voice/twiml?callId=${call.callId}`,
      statusCallback: `${base}/voice/status?callId=${call.callId}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeout: 20,
    });
    call.callSid = created.sid;
  } catch (err) {
    console.error('[voice] Twilio call create failed', err);
    setStatus(ctx, call, 'failed');
    finishCall(ctx, call, 'failed', `Call to ${call.personName} could not be placed.`);
  }
}

/** Idempotent teardown: emits call.ended, books cost, restores clock, starts the next queued live call. */
export function finishCall(ctx: VoiceCtx, call: CallRecord, outcome: PayloadOf<'call.ended'>['outcome'], summary: string) {
  if (call.ended) return;
  call.ended = true;
  const durationSec = call.mode === 'live' ? Math.round((Date.now() - (call.answeredAtWall ?? Date.now())) / 1000) : 40;
  const costUsd = call.mode === 'live' && call.answeredAtWall ? callCost(durationSec) : 0;
  ctx.hooks.onCost(costUsd);
  ctx.world.bus.emit('call.ended', { callId: call.callId, kind: call.kind, outcome, durationSec: outcome === 'no_answer' ? 0 : durationSec, summary, costUsd });
  if (outcome === 'no_answer' && call.kind === 'driver' && call.truckId) ctx.hooks.onNoAnswer(call.truckId);
  if (call.kind === 'dispatcher' && outcome === 'completed' && !call.decision) {
    // Ana hung up without an explicit decision: treat as keep-current so frozen trucks don't stay frozen forever.
    ctx.hooks.onDispatcherDecision({ tripIds: call.tripIds, decision: 'keep_current', note: 'No explicit decision on the call' });
  }
  if (call.mode === 'live') {
    ctx.world.restoreClockSpeed();
    if (ctx.liveActive === call.callId) {
      ctx.liveActive = null;
      const next = ctx.liveQueue.shift();
      if (next) startLive(ctx, next);
    }
  }
}

export function twilioStatusToOurs(s: string): PayloadOf<'call.status'>['status'] | null {
  switch (s) {
    case 'ringing':
      return 'ringing';
    case 'in-progress':
    case 'answered':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'no-answer':
      return 'no_answer';
    case 'busy':
      return 'busy';
    case 'failed':
    case 'canceled':
      return 'failed';
    default:
      return null;
  }
}
