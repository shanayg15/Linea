// ConversationRelay WebSocket loop (TRACK_B §B6): Twilio STT → Claude Haiku (streamed) → Twilio TTS.
import Anthropic from '@anthropic-ai/sdk';
import { ulid } from 'ulid';
import type { WebSocket } from 'ws';
import type { PortId } from '../../../shared/types';
import { claudeCost, MODELS, usageTokens } from '../agent/cost';
import { thinkingOff } from '../agent/dispatcher';
import { fmtClock, portLabel, truckLabel } from '../agent/time';
import { finishCall, setStatus, type CallRecord, type VoiceCtx } from './calls';
import {
  CLOSING,
  DISPATCHER_GREETING,
  DISPATCHER_RULES,
  DISPATCHER_TOOLS,
  DRIVER_RULES,
  DRIVER_TOOLS,
  dispatcherCallData,
  driverCallData,
  driverGreeting,
} from './prompts';
import { translateUtterance } from './translate';

const MAX_HOPS = 3;
const CAP_MS = { driver: 90_000, dispatcher: 120_000 };

let client: Anthropic | null = null;

type TwilioMsg =
  | { type: 'setup'; callSid?: string; customParameters?: Record<string, string> }
  | { type: 'prompt'; voicePrompt: string; lang?: string; last?: boolean }
  | { type: 'interrupt'; utteranceUntilInterrupt?: string; durationUntilInterruptMs?: number }
  | { type: 'dtmf'; digit: string }
  | { type: 'error'; description: string };

export function greetingFor(ctx: VoiceCtx, call: CallRecord): string {
  return call.kind === 'dispatcher' ? DISPATCHER_GREETING : driverGreeting(call.personName, call.goal ?? 'check_status');
}

export function handleRelay(ctx: VoiceCtx, ws: WebSocket, callIdFromUrl: string | null) {
  let call: CallRecord | null = callIdFromUrl ? ctx.calls.get(callIdFromUrl) ?? null : null;
  const messages: Anthropic.MessageParam[] = [];
  let system: Anthropic.TextBlockParam[] = [];
  let abort: AbortController | null = null;
  let turn: Promise<void> = Promise.resolve();
  let ending = false;
  let capTimer: NodeJS.Timeout | null = null;

  const send = (m: Record<string, unknown>) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };

  ws.on('message', (raw) => {
    let m: TwilioMsg;
    try {
      m = JSON.parse(raw.toString()) as TwilioMsg;
    } catch {
      return;
    }
    switch (m.type) {
      case 'setup':
        call ??= ctx.calls.get(m.customParameters?.callId ?? '') ?? null;
        if (!call) {
          console.error('[relay] unknown call, closing');
          send({ type: 'end', handoffData: JSON.stringify({ error: 'unknown call' }) });
          return;
        }
        onSetup(call, m.callSid);
        break;
      case 'prompt':
        if (!call || m.last === false || !m.voicePrompt?.trim() || ending) return;
        onPrompt(call, m.voicePrompt.trim(), m.lang ?? call.language);
        break;
      case 'interrupt':
        onInterrupt(m.utteranceUntilInterrupt ?? '');
        break;
      case 'error':
        console.error('[relay] Twilio error:', m.description);
        break;
    }
  });

  ws.on('close', () => {
    abort?.abort();
    if (capTimer) clearTimeout(capTimer);
    if (call && !call.ended) finishCall(ctx, call, call.status === 'in_progress' ? 'completed' : 'failed', `Call with ${call.personName} ended.`);
  });

  function onSetup(c: CallRecord, callSid?: string) {
    if (callSid) c.callSid = callSid;
    setStatus(ctx, c, 'in_progress');
    const greeting = greetingFor(ctx, c);
    emitTranscript(c, 'linea', greeting, c.language);
    system =
      c.kind === 'driver'
        ? [
            { type: 'text', text: DRIVER_RULES },
            {
              type: 'text',
              text: driverCallData({ goal: c.goal ?? 'check_status', truckBrief: truckBrief(c), instruction: c.instruction, greeting }),
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
    capTimer = setTimeout(() => void hangUp(c, c.language === 'es-MX' ? CLOSING.es : CLOSING.en, 'Time limit reached.'), CAP_MS[c.kind]);
    if (c.kind === 'dispatcher') {
      // Ana hears the greeting; Linea delivers the summary without waiting for her to speak.
      messages.push({ role: 'user', content: '[Ana picked up and heard your greeting. Deliver the summary and ask the question now.]' });
      turn = turn.then(() => runTurn(c));
    }
  }

  function onPrompt(c: CallRecord, text: string, lang: string) {
    abort?.abort();
    const utteranceId = emitTranscript(c, 'human', text, lang);
    translateUtterance(ctx, { callId: c.callId, utteranceId, speaker: 'human', text, lang });
    turn = turn.then(() => {
      messages.push({ role: 'user', content: text });
      return runTurn(c);
    });
  }

  function onInterrupt(spoken: string) {
    abort?.abort();
    // Keep only what the caller actually heard in the history.
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && typeof last.content !== 'string' && last.content.every((b) => b.type === 'text')) {
      last.content = spoken ? [{ type: 'text', text: spoken }] : [{ type: 'text', text: '…' }];
    }
  }

  async function runTurn(c: CallRecord) {
    if (c.ended || ending) return;
    abort = new AbortController();
    const signal = abort.signal;
    const model = MODELS.voice;
    const thinking = thinkingOff(model);
    let spoken = '';
    let endRequested: { summary: string } | null = null;
    try {
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        client ??= new Anthropic();
        const stream = client.messages.stream(
          {
            model,
            max_tokens: 200,
            system,
            tools: c.kind === 'driver' ? DRIVER_TOOLS : DISPATCHER_TOOLS,
            messages,
            ...(thinking ? { thinking } : {}),
          },
          { signal },
        );
        stream.on('text', (delta) => {
          spoken += delta;
          send({ type: 'text', token: delta, last: false });
        });
        const msg = await stream.finalMessage();
        const costUsd = claudeCost(model, msg.usage);
        c.claudeCostUsd += costUsd;
        ctx.hooks.onCost(costUsd);
        ctx.world.bus.emit('agent.usage', { requestId: ulid(), purpose: 'voice', model, ...usageTokens(msg.usage), costUsd });
        messages.push({ role: 'assistant', content: msg.content });

        const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (!uses.length || msg.stop_reason !== 'tool_use') break;
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const u of uses) {
          const { result, end } = runVoiceTool(c, u.name, (u.input ?? {}) as Record<string, unknown>);
          if (end) endRequested = end;
          ctx.world.bus.emit('call.tool', { callId: c.callId, tool: u.name, args: (u.input ?? {}) as Record<string, unknown>, result });
          results.push({ type: 'tool_result', tool_use_id: u.id, content: result });
        }
        messages.push({ role: 'user', content: results });
        if (endRequested && spoken.trim()) break; // already said goodbye
      }
    } catch (err) {
      if (!signal.aborted) console.error('[relay] Claude turn failed', (err as Error).message);
    } finally {
      abort = null;
    }
    if (signal.aborted) return;
    send({ type: 'text', token: '', last: true });
    if (spoken.trim()) {
      const id = emitTranscript(c, 'linea', spoken.trim(), c.language);
      translateUtterance(ctx, { callId: c.callId, utteranceId: id, speaker: 'linea', text: spoken.trim(), lang: c.language });
    }
    if (endRequested) await hangUp(c, spoken.trim() ? null : c.language === 'es-MX' ? CLOSING.es : CLOSING.en, endRequested.summary);
  }

  function runVoiceTool(c: CallRecord, name: string, a: Record<string, unknown>): { result: string; end?: { summary: string } } {
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
        return { result: 'Ending call', end: { summary: String(a.summary_en ?? `Call with ${c.personName} completed.`) } };
      default:
        return { result: `Unknown tool ${name}` };
    }
  }

  async function hangUp(c: CallRecord, closingLine: string | null, summary: string) {
    if (ending || c.ended) return;
    ending = true;
    abort?.abort();
    if (capTimer) clearTimeout(capTimer);
    if (closingLine) {
      send({ type: 'text', token: closingLine, last: true });
      emitTranscript(c, 'linea', closingLine, c.language);
    }
    await new Promise((r) => setTimeout(r, 1500));
    send({ type: 'end', handoffData: JSON.stringify({ summary }) });
    setStatus(ctx, c, 'completed');
    finishCall(ctx, c, 'completed', summary);
  }

  function emitTranscript(c: CallRecord, speaker: 'linea' | 'human', text: string, lang: string): string {
    const utteranceId = ulid();
    ctx.world.bus.emit('call.transcript', {
      callId: c.callId,
      utteranceId,
      speaker,
      text,
      lang,
      textEnglish: lang.startsWith('en') ? text : null,
      final: true,
    });
    return utteranceId;
  }

  function truckBrief(c: CallRecord): string {
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
}
