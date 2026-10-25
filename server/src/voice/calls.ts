// Call registry, live/simulated routing, Twilio call placement, call teardown.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
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
  /** Twilio fetched our TwiML for this call (i.e. it could reach the server through the tunnel). */
  twimlServed?: boolean;
}

export interface VoiceCtx {
  world: WorldApi;
  hooks: VoiceHooks;
  calls: Map<string, CallRecord>;
  liveActive: string | null;
  liveQueue: CallRecord[];
}

const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');

/** PUBLIC_BASE_URL, re-read from .env each time so a new tunnel URL works without restarting the server. */
export function publicBaseUrl(): string | null {
  let u = process.env.PUBLIC_BASE_URL?.trim();
  try {
    const fromFile = dotenv.parse(readFileSync(ENV_PATH)).PUBLIC_BASE_URL?.trim();
    if (fromFile) u = fromFile;
  } catch {
    // no .env file: keep the process env value
  }
  return u ? u.replace(/\/+$/, '') : null;
}

let reach: { at: number; url: string; ok: boolean } | null = null;

/** Can Twilio reach us? GET <PUBLIC_BASE_URL>/health through the tunnel (cached 10 s). */
export async function publicUrlReachable(): Promise<boolean> {
  const base = publicBaseUrl();
  if (!base) return false;
  if (reach && reach.url === base && Date.now() - reach.at < 10_000) return reach.ok;
  let ok = false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`${base}/health`, { signal: ctl.signal, headers: { 'user-agent': 'TwilioProxy/1.1', 'bypass-tunnel-reminder': '1' } });
    clearTimeout(t);
    ok = r.ok;
  } catch {
    ok = false;
  }
  reach = { at: Date.now(), url: base, ok };
  if (!ok) console.error(`[voice] ${base} is NOT reachable — live calls fall back to simulated. Restart the tunnel (and update PUBLIC_BASE_URL in .env if its URL changed).`);
  return ok;
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
    });
    call.callSid = created.sid;
    watchTwilio(ctx, call, client);
  } catch (err) {
    console.error('[voice] Twilio call create failed', err);
    setStatus(ctx, call, 'failed');
    finishCall(ctx, call, 'failed', `Call to ${call.personName} could not be placed.`);
  }
}

/**
 * Backstop for lost webhooks (e.g. the tunnel dropped mid-call): poll Twilio's REST API, which doesn't need the
 * tunnel, and end the call when Twilio says it's over — so the clock never stays stuck at 1×.
 */
function watchTwilio(ctx: VoiceCtx, call: CallRecord, client: ReturnType<typeof twilio>) {
  const started = Date.now();
  const timer = setInterval(async () => {
    if (call.ended || !call.callSid) return clearInterval(timer);
    if (Date.now() - started > 5 * 60_000) {
      clearInterval(timer);
      finishCall(ctx, call, 'failed', `Call to ${call.personName} timed out.`);
      return;
    }
    try {
      const s = twilioStatusToOurs((await client.calls(call.callSid).fetch()).status);
      if (!s || s === 'ringing' || s === 'in_progress' || call.ended) return;
      clearInterval(timer);
      if (s === 'completed' && !call.twimlServed) {
        setStatus(ctx, call, 'failed');
        finishCall(ctx, call, 'failed', `Twilio couldn't reach Linea's server during the call to ${call.personName} (tunnel down?).`);
      } else if (s === 'no_answer' || s === 'busy') {
        setStatus(ctx, call, s);
        finishCall(ctx, call, 'no_answer', `${call.personName} did not answer.`);
      } else if (s === 'failed') {
        setStatus(ctx, call, 'failed');
        finishCall(ctx, call, 'failed', `Call to ${call.personName} failed.`);
      } else {
        setStatus(ctx, call, 'completed');
        finishCall(ctx, call, 'completed', `Call with ${call.personName} ended.`);
      }
    } catch (err) {
      console.error('[voice] Twilio status poll failed', (err as Error).message);
    }
  }, 5000);
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
