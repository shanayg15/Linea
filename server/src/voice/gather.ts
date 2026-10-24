// Twilio <Gather input="speech"> loop — the free-tier alternative to ConversationRelay (which trial accounts can't use).
// Each turn: Twilio <Say>s Linea's line and transcribes the reply → POST /voice/gather → Claude Haiku (same prompts and
// tools as relay.ts) → next <Say>/<Gather>, or <Hangup/> after end_call. Select with VOICE_TRANSPORT=gather|relay.
import Anthropic from '@anthropic-ai/sdk';
import { ulid } from 'ulid';
import type { PortId } from '../../../shared/types';
import { claudeCost, MODELS, usageTokens } from '../agent/cost';
import { thinkingOff } from '../agent/dispatcher';
import { fmtClock, portLabel, truckLabel } from '../agent/time';
import { finishCall, setStatus, type CallRecord, type VoiceCtx } from './calls';
import { CLOSING, DISPATCHER_RULES, DISPATCHER_TOOLS, DRIVER_RULES, DRIVER_TOOLS, dispatcherCallData, driverCallData } from './prompts';
import { greetingFor } from './relay';
import { translateUtterance } from './translate';

const MAX_HOPS = 3;
const CAP_MS = { driver: 90_000, dispatcher: 120_000 };
const MAX_SILENCES = 2;

let client: Anthropic | null = null;

interface Session {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  silences: number;
  startedAt: number;
}

const sessions = new Map<string, Session>();

export function useGather(): boolean {
  return (process.env.VOICE_TRANSPORT ?? 'gather').trim().toLowerCase() !== 'relay';
}

/** First TwiML for an answered call: greet, then listen. */
export async function gatherStart(ctx: VoiceCtx, call: CallRecord, base: string): Promise<string> {
  setStatus(ctx, call, 'in_progress');
  const greeting = greetingFor(ctx, call);
  say(ctx, call, 'linea', greeting);
  const s: Session = { system: systemFor(ctx, call, greeting), messages: [], silences: 0, startedAt: Date.now() };
  sessions.set(call.callId, s);
  if (call.kind === 'dispatcher') {
    // Ana hears the greeting; Linea delivers the summary without waiting for her to speak.
    s.messages.push({ role: 'user', content: '[Ana picked up and heard your greeting. Deliver the summary and ask the question now.]' });
    const r = await runTurn(ctx, call, s);
    if (r.spoken) say(ctx, call, 'linea', r.spoken);
    if (r.end) return end(ctx, call, `${greeting} ${r.spoken}`.trim(), r.end);
    return listen(base, call, `${greeting} ${r.spoken}`.trim());
  }
  return listen(base, call, greeting);
}

/** One conversational turn from Twilio's transcription (empty on silence). */
export async function gatherTurn(ctx: VoiceCtx, callId: string, speech: string, base: string): Promise<string> {
  const call = ctx.calls.get(callId);
  if (!call || call.ended) return hangupXml();
  const es = call.language === 'es-MX';
  const s = sessions.get(callId);
  if (!s) return hangupXml();
  if (Date.now() - s.startedAt > CAP_MS[call.kind]) return end(ctx, call, es ? CLOSING.es : CLOSING.en, 'Time limit reached.');

  const text = speech.trim();
  if (!text) {
    s.silences++;
    if (s.silences >= MAX_SILENCES) return end(ctx, call, es ? CLOSING.es : CLOSING.en, `${call.personName} went quiet.`);
    return listen(base, call, es ? '¿Me escuchas?' : 'Are you there?');
  }
  s.silences = 0;
  say(ctx, call, 'human', text);
  pushUserText(s, text);
  const r = await runTurn(ctx, call, s);
  if (r.spoken) say(ctx, call, 'linea', r.spoken);
  if (r.end) return end(ctx, call, r.spoken || (es ? CLOSING.es : CLOSING.en), r.end);
  return listen(base, call, r.spoken || (es ? 'Perdón, ¿me repites?' : 'Sorry, could you say that again?'));
}

/** Append the caller's words; merge into a trailing tool_result turn so roles keep alternating. */
function pushUserText(s: Session, text: string): void {
  const last = s.messages[s.messages.length - 1];
  if (last?.role === 'user' && Array.isArray(last.content)) last.content.push({ type: 'text', text });
  else s.messages.push({ role: 'user', content: text });
}

async function runTurn(ctx: VoiceCtx, c: CallRecord, s: Session): Promise<{ spoken: string; end: string | null }> {
  const model = MODELS.voice;
  const thinking = thinkingOff(model);
  let spoken = '';
  let endSummary: string | null = null;
  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      client ??= new Anthropic();
      const msg = await client.messages.create({
        model,
        max_tokens: 400,
        system: s.system,
        tools: c.kind === 'driver' ? DRIVER_TOOLS : DISPATCHER_TOOLS,
        messages: s.messages,
        ...(thinking ? { thinking } : {}),
      });
      const costUsd = claudeCost(model, msg.usage);
      c.claudeCostUsd += costUsd;
      ctx.hooks.onCost(costUsd);
      ctx.world.bus.emit('agent.usage', { requestId: ulid(), purpose: 'voice', model, ...usageTokens(msg.usage), costUsd });
      s.messages.push({ role: 'assistant', content: msg.content });
      for (const b of msg.content) if (b.type === 'text') spoken += (spoken ? ' ' : '') + b.text.trim();

      // Every tool_use must get a tool_result, whatever the stop_reason, or the next request is rejected.
      const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (!uses.length) break;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        const { result, end } = runVoiceTool(ctx, c, u.name, (u.input ?? {}) as Record<string, unknown>);
        if (end) endSummary = end;
        ctx.world.bus.emit('call.tool', { callId: c.callId, tool: u.name, args: (u.input ?? {}) as Record<string, unknown>, result });
        results.push({ type: 'tool_result', tool_use_id: u.id, content: result });
      }
      s.messages.push({ role: 'user', content: results });
      if (endSummary && spoken.trim()) break; // already said goodbye
      if (msg.stop_reason !== 'tool_use') break;
    }
  } catch (err) {
    console.error('[gather] Claude turn failed', (err as Error).message);
  }
  return { spoken: spoken.trim(), end: endSummary };
}

// Same tool semantics as relay.ts.
function runVoiceTool(ctx: VoiceCtx, c: CallRecord, name: string, a: Record<string, unknown>): { result: string; end?: string } {
  switch (name) {
    case 'report_queue_position': {
      const portId: PortId = a.port_id === 'tecate' ? 'tecate' : 'otay_mesa';
      const lengthKm = Number(a.length_km) || 0;
      const extraWaitMin = Number(a.extra_wait_min) || Math.round(lengthKm * 30);
      const src = ctx.world.reportQueue({ portId, lengthKm, extraWaitMin, reportedBy: c.truckId ?? 'unknown' });
      return { result: `Recorded: ${src.label}` };
    }
    case 'report_status':
      return { result: `Status recorded: ${String(a.status ?? 'unknown')}` };
    case 'confirm_instruction':
      return { result: a.accepted ? 'Driver accepted' : 'Driver did not accept' };
    case 'dispatcher_decision': {
      const ids = Array.isArray(a.trip_ids) ? (a.trip_ids as unknown[]).map(String).filter(Boolean) : [];
      const allowed = ['keep_current', 'approve_linea_plan', 'raise_budget', 'custom'] as const;
      const decision = allowed.find((d) => d === a.decision) ?? 'custom';
      const d = { tripIds: ids.length ? ids : c.tripIds, decision, note: String(a.note ?? '') };
      c.decision = d;
      ctx.hooks.onDispatcherDecision(d);
      return { result: 'Applied' };
    }
    case 'end_call':
      return { result: 'Ending call', end: String(a.summary_en ?? `Call with ${c.personName} completed.`) };
    default:
      return { result: `Unknown tool ${name}` };
  }
}

function systemFor(ctx: VoiceCtx, c: CallRecord, greeting: string): Anthropic.TextBlockParam[] {
  return c.kind === 'driver'
    ? [
        { type: 'text', text: DRIVER_RULES },
        {
          type: 'text',
          text: driverCallData({ goal: c.goal ?? 'check_status', truckBrief: truckBrief(ctx, c), instruction: c.instruction, greeting }),
          cache_control: { type: 'ephemeral' },
        },
      ]
    : [
        { type: 'text', text: DISPATCHER_RULES },
        {
          type: 'text',
          text: dispatcherCallData({ summary: c.summary ?? '', questions: c.questions ?? [], tripIds: c.tripIds, greeting }),
          cache_control: { type: 'ephemeral' },
        },
      ];
}

function truckBrief(ctx: VoiceCtx, c: CallRecord): string {
  const t = c.truckId ? ctx.world.getTruck(c.truckId) : undefined;
  if (!t) return 'sin datos del camión';
  const where =
    t.state === 'in_queue_mx' || t.state === 'in_queue_us'
      ? `en la fila de ${portLabel(t.port)} (${t.lane === 'fast' ? 'FAST' : 'estándar'})`
      : t.state === 'en_route'
        ? `manejando hacia ${portLabel(t.port)}`
        : 'en el patio';
  return `${truckLabel(t.id).replace('Truck', 'Camión')}, chofer ${t.driverName}, carga ${t.cargo}, ${where}, entrega antes de ${fmtClock(t.deadline)}`;
}

/** Transcript event (+ async English translation for Spanish lines). */
function say(ctx: VoiceCtx, c: CallRecord, speaker: 'linea' | 'human', text: string): void {
  const utteranceId = ulid();
  const lang = c.language;
  ctx.world.bus.emit('call.transcript', { callId: c.callId, utteranceId, speaker, text, lang, textEnglish: lang.startsWith('en') ? text : null, final: true });
  translateUtterance(ctx, { callId: c.callId, utteranceId, speaker, text, lang });
}

function end(ctx: VoiceCtx, c: CallRecord, line: string, summary: string): string {
  sessions.delete(c.callId);
  setStatus(ctx, c, 'completed');
  finishCall(ctx, c, 'completed', summary);
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${sayXml(line, c.language)}<Hangup/></Response>`;
}

function listen(base: string, c: CallRecord, line: string): string {
  const action = `${base}/voice/gather?callId=${encodeURIComponent(c.callId)}`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" language="${c.language}" speechTimeout="auto" timeout="6" actionOnEmptyResult="true" method="POST" action="${xml(action)}">${sayXml(line, c.language)}</Gather></Response>`;
}

function sayXml(text: string, lang: CallRecord['language']): string {
  const voice = lang === 'es-MX' ? 'Polly.Mia' : 'Polly.Joanna';
  return `<Say language="${lang}" voice="${voice}">${xml(text)}</Say>`;
}

function hangupXml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
