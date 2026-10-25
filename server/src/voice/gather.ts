// Twilio <Gather input="speech"> loop — the free-tier alternative to ConversationRelay (which trial accounts can't use).
// Each turn: Twilio <Say>s Linea's line and transcribes the reply → POST /voice/gather → Claude Haiku (same prompts and
// tools as relay.ts) → next <Say>/<Gather>, or <Hangup/> after end_call. Select with VOICE_TRANSPORT=gather|relay.
import Anthropic from '@anthropic-ai/sdk';
import { ulid } from 'ulid';
import type { PortId } from '../../../shared/types';
import { claudeCost, MODELS, usageTokens } from '../agent/cost';
import { thinkingOff } from '../agent/dispatcher';
import { fmtClock, ms, portLabel, truckLabel } from '../agent/time';
import { finishCall, setStatus, type CallRecord, type VoiceCtx } from './calls';
import { closingFor, DISPATCHER_RULES, DISPATCHER_TOOLS, DRIVER_RULES, DRIVER_RULES_EN, DRIVER_TOOLS, dispatcherCallData, driverCallData } from './prompts';
import { greetingFor } from './relay';
import { translateUtterance } from './translate';

const MAX_HOPS = 3;
const CAP_MS = { driver: 90_000, dispatcher: 120_000 };
const MAX_SILENCES = 2;

let client: Anthropic | null = null;

/** The only way Linea talks: free text from the model (often its own planning) is never read to the caller. */
const SPEAK_TOOL: Anthropic.Tool = {
  name: 'speak',
  description: 'Say this to the person on the phone, word for word. The ONLY way they hear you. Call it in the same message as any other tools.',
  input_schema: { type: 'object', properties: { text: { type: 'string', description: 'What to say, in the call language, second person, max two short sentences.' } }, required: ['text'] },
};

interface Session {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  silences: number;
  startedAt: number;
  lastLine: string;
  /** Driver calls: the dispatcher's instruction, repeated after a silence. */
  briefing: string | null;
  /** learn_queue: one question about the Mexican-side line, then hang up. */
  sensor: boolean;
}

const sessions = new Map<string, Session>();

export function useGather(): boolean {
  return (process.env.VOICE_TRANSPORT ?? 'gather').trim().toLowerCase() !== 'relay';
}

/** First TwiML for an answered call: greet, then listen. */
export async function gatherStart(ctx: VoiceCtx, call: CallRecord, base: string): Promise<string> {
  setStatus(ctx, call, 'in_progress');
  const sensor = call.kind === 'driver' && call.goal === 'learn_queue';
  const briefing = call.kind === 'driver' && !sensor ? driverBriefing(ctx, call) : null;
  const greeting = sensor
    ? sensorQuestion(call)
    : briefing
      ? `${driverIntro(call)} ${briefing} ${call.language === 'es-MX' ? '¿De acuerdo?' : 'Okay?'}`
      : greetingFor(ctx, call);
  say(ctx, call, 'linea', greeting);
  const s: Session = { system: systemFor(ctx, call, greeting, briefing, sensor), messages: [], silences: 0, startedAt: Date.now(), lastLine: greeting, briefing, sensor };
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
  if (Date.now() - s.startedAt > CAP_MS[call.kind]) return end(ctx, call, closingFor(call), 'Time limit reached.');

  const text = speech.trim();
  if (!text) {
    s.silences++;
    if (s.silences >= MAX_SILENCES) {
      return end(ctx, call, closingFor(call), s.briefing ? `Instruction delivered to ${call.personName} (no reply): ${s.briefing}` : `${call.personName} went quiet.`);
    }
    // They may have answered while Linea was still talking (bargeIn=false drops that): repeat, don't interrogate.
    const again = s.briefing ? `${s.briefing} ${es ? '¿De acuerdo?' : 'Okay?'}` : lastQuestion(s.lastLine);
    return listen(base, call, es ? `Perdón, no te escuché. ${again}` : `Sorry, I didn't catch that. ${again}`);
  }
  s.silences = 0;
  say(ctx, call, 'human', text);
  pushUserText(s, text);
  const r = await runTurn(ctx, call, s);
  if (r.spoken) say(ctx, call, 'linea', r.spoken);
  if (r.end) return end(ctx, call, r.spoken || closingFor(call), r.end);
  // A queue question gets one answer: thank them and hang up, whatever they said.
  if (s.sensor) return end(ctx, call, r.spoken || closingFor(call), `${call.personName}: "${text}"`);
  return listen(base, call, r.spoken || (es ? 'Perdón, ¿me repites?' : 'Sorry, could you say that again?'));
}

/** Last sentence of what Linea said (the question to repeat after a silence). */
function lastQuestion(line: string): string {
  const parts = line.split(/(?<=[.!?¿])\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? line;
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
        max_tokens: 300,
        system: s.system,
        tools: [SPEAK_TOOL, ...(c.kind === 'driver' ? DRIVER_TOOLS : DISPATCHER_TOOLS)],
        tool_choice: { type: 'any' },
        messages: s.messages,
        ...(thinking ? { thinking } : {}),
      });
      const costUsd = claudeCost(model, msg.usage);
      c.claudeCostUsd += costUsd;
      ctx.hooks.onCost(costUsd);
      ctx.world.bus.emit('agent.usage', { requestId: ulid(), purpose: 'voice', model, ...usageTokens(msg.usage), costUsd });
      s.messages.push({ role: 'assistant', content: msg.content });
      // Text blocks are the model thinking out loud — never spoken. Only speak.text reaches the caller.

      // Every tool_use must get a tool_result, whatever the stop_reason, or the next request is rejected.
      const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (!uses.length) break;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        const input = (u.input ?? {}) as Record<string, unknown>;
        if (u.name === 'speak') {
          const line = String(input.text ?? '').trim();
          if (line) spoken += (spoken ? ' ' : '') + line;
          results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Said.' });
          continue;
        }
        const { result, end } = runVoiceTool(ctx, c, u.name, input);
        if (end) endSummary = end;
        ctx.world.bus.emit('call.tool', { callId: c.callId, tool: u.name, args: input, result });
        results.push({ type: 'tool_result', tool_use_id: u.id, content: result });
      }
      s.messages.push({ role: 'user', content: results });
      // One Claude round-trip per turn: if the reply already has words, speak them now instead of asking again
      // (the second hop doubled latency and made Linea repeat itself). Only re-ask when it called tools silently.
      if (spoken.trim() || msg.stop_reason !== 'tool_use') break;
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
    case 'confirm_instruction': {
      // The instruction was the whole point of the call: once the driver answers, hang up after the goodbye.
      const note = a.note ? ` (${String(a.note)})` : '';
      return {
        result: a.accepted ? 'Driver accepted' : 'Driver did not accept',
        end: `${c.personName} ${a.accepted ? 'accepted' : 'pushed back on'} the instruction${note}.`,
      };
    }
    case 'dispatcher_decision': {
      const ids = Array.isArray(a.trip_ids) ? (a.trip_ids as unknown[]).map(String).filter(Boolean) : [];
      const allowed = ['keep_current', 'approve_linea_plan', 'raise_budget', 'custom'] as const;
      const decision = allowed.find((d) => d === a.decision) ?? 'custom';
      const d = { tripIds: ids.length ? ids : c.tripIds, decision, note: String(a.note ?? '') };
      c.decision = d;
      ctx.hooks.onDispatcherDecision(d);
      // Ana's decision is what the call was for: hang up after the confirmation line.
      return { result: 'Applied', end: `Ana: ${d.decision.replace(/_/g, ' ')}${d.note ? ` (${d.note})` : ''}.` };
    }
    case 'end_call':
      return { result: 'Ending call', end: String(a.summary_en ?? `Call with ${c.personName} completed.`) };
    default:
      return { result: `Unknown tool ${name}` };
  }
}

const PHONE_STYLE: Record<CallRecord['language'], string> = {
  'en-US':
    'The person hears ONLY what you pass to the speak tool; anything else you write is never heard. Every reply calls speak (second person, directly to them) in the same message as any other tools. Phone style: at most two short sentences per reply (under 25 words total); end with at most one short question. When you call a tool, put your spoken reply in the same message as the tool call; you will not get another chance to speak before the caller answers. Never repeat what you already said. The transcription can be wrong: if an answer makes no sense, ask once, briefly, to repeat. Queue questions: accept whatever they give (trucks, cars, minutes, kilometers, or something vague), turn it into a best estimate (about 50 trucks per km; "a lot" or "long" ≈ 2 km), call report_queue_position right away, then wrap up. Ask at most one follow-up in the whole call.',
  'es-MX':
    'La persona SOLO escucha lo que pasas a la herramienta speak; nada más de lo que escribas se oye. Cada respuesta llama speak (de tú, directo a la persona) en el mismo mensaje que las demás herramientas. Estilo telefónico: máximo dos frases cortas por respuesta (menos de 25 palabras), con a lo más una pregunta corta al final. Cuando llames una herramienta, di tu respuesta hablada en el mismo mensaje; no tendrás otra oportunidad de hablar antes de que conteste. No repitas lo que ya dijiste. La transcripción puede fallar: si algo no tiene sentido, pide una vez, brevemente, que lo repita. Preguntas de fila: acepta lo que diga (camiones, carros, minutos, kilómetros o algo vago), conviértelo en tu mejor estimación (unos 50 camiones por km; "mucho" ≈ 2 km), llama report_queue_position de inmediato y despídete. Máximo una pregunta de seguimiento en toda la llamada.',
};

const BRIEFING_RULES: Record<CallRecord['language'], string> = {
  'en-US':
    'The person hears ONLY what you pass to the speak tool; anything else you write is never heard. Every reply calls speak (second person, directly to them) in the same message as any other tools. This call only delivers the dispatcher\'s instruction, which you already said in your greeting. Do NOT ask the driver any questions. If they agree (okay, yes, got it, sure): call confirm_instruction with accepted=true and end_call, saying only a short goodbye (under 8 words). If they mention where they are, a delay or a problem: record it with report_queue_position or report_status, acknowledge in one short sentence, then end_call. If they push back: say you will pass it to the dispatcher, call confirm_instruction with accepted=false, then end_call. If you did not understand them, repeat the instruction once in one short sentence. Never more than two short sentences.',
  'es-MX':
    'La persona SOLO escucha lo que pasas a la herramienta speak; nada más de lo que escribas se oye. Cada respuesta llama speak (de tú, directo a la persona) en el mismo mensaje que las demás herramientas. Esta llamada solo entrega la instrucción del despachador, que ya dijiste en tu saludo. NO le hagas preguntas al chofer. Si acepta (sí, va, de acuerdo, órale): llama confirm_instruction con accepted=true y end_call, con una despedida corta (menos de 8 palabras). Si menciona dónde está, un retraso o un problema: regístralo con report_queue_position o report_status, reconócelo en una frase corta y llama end_call. Si no está de acuerdo: di que se lo pasas al despachador, llama confirm_instruction con accepted=false y end_call. Si no le entendiste, repite la instrucción una vez en una frase corta. Nunca más de dos frases cortas.',
};

const SENSOR_RULES: Record<CallRecord['language'], string> = {
  'en-US':
    'The person hears ONLY what you pass to the speak tool. You asked the driver one question: are they in the Otay line, and how far back on the Mexican side. Whatever they answer (kilometers, trucks, minutes, or something vague), call report_queue_position right away with your best estimate (about 30 extra minutes per km on the Mexican side, about 50 trucks per km, "long" or "a lot" ≈ 2 km), then call speak with one short thank-you that says you are updating the plan, and call end_call. If they are not in line yet, just thank them and call end_call. Never ask another question.',
  'es-MX':
    'La persona SOLO escucha lo que pasas a la herramienta speak. Le hiciste una sola pregunta al chofer: si ya está en la fila de Otay y qué tan atrás va del lado mexicano. Conteste lo que conteste (kilómetros, camiones, minutos o algo vago), llama report_queue_position de inmediato con tu mejor estimación (unos 30 minutos extra por km del lado mexicano, unos 50 camiones por km, "mucho" ≈ 2 km), luego llama speak con un agradecimiento corto que diga que ya ajustas el plan, y llama end_call. Si todavía no está en la fila, solo agradécele y llama end_call. Nunca hagas otra pregunta.',
};

/** The one question a sensor call asks (the line the demo video keeps). */
function sensorQuestion(c: CallRecord): string {
  return c.language === 'es-MX'
    ? `Hola ${c.personName}, soy Linea, una inteligencia artificial. ¿Ya estás en la fila de Otay?`
    : `Hi ${c.personName}, it's Linea, an AI. Are you in the Otay line yet?`;
}

function systemFor(ctx: VoiceCtx, c: CallRecord, greeting: string, briefing: string | null, sensor = false): Anthropic.TextBlockParam[] {
  if (c.kind === 'driver' && sensor) {
    return [
      { type: 'text', text: c.language === 'en-US' ? DRIVER_RULES_EN : DRIVER_RULES },
      {
        type: 'text',
        text: driverCallData({ goal: 'learn_queue', truckBrief: truckBrief(ctx, c), greeting, lang: c.language }),
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: SENSOR_RULES[c.language] },
    ];
  }
  if (c.kind === 'driver' && briefing) {
    return [
      { type: 'text', text: c.language === 'en-US' ? DRIVER_RULES_EN : DRIVER_RULES },
      {
        type: 'text',
        text: driverCallData({ goal: 'give_instruction', truckBrief: truckBrief(ctx, c), instruction: briefing, greeting, lang: c.language }),
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: BRIEFING_RULES[c.language] },
    ];
  }
  return [...baseSystem(ctx, c, greeting), { type: 'text', text: PHONE_STYLE[c.language] }];
}

function driverIntro(c: CallRecord): string {
  return c.language === 'es-MX'
    ? `Hola ${c.personName}, habla Linea, el despachador con inteligencia artificial de Transportes Mesa.`
    : `Hi ${c.personName}, this is Linea, Transportes Mesa's AI dispatcher.`;
}

const looksSpanish = (t: string) => /[áéíóúñ¿¡]|\b(el|la|los|las|de|por|para|hasta|quédate|sigue|espera)\b/i.test(t);

/** "about two hours" / "25 minutes" — how a dispatcher would say a wait on the phone. */
function dur(min: number, es: boolean): string {
  if (min < 55) return es ? `${Math.max(5, Math.round(min / 5) * 5)} minutos` : `${Math.max(5, Math.round(min / 5) * 5)} minutes`;
  if (min < 75) return es ? 'una hora' : 'an hour';
  if (min < 105) return es ? 'hora y media' : 'an hour and a half';
  const h = Math.round(min / 60);
  return es ? `${h} horas` : `${h} hours`;
}

/**
 * What the dispatcher wants this driver to do and why, in two or three short sentences: the border situation (CBP wait +
 * any driver-reported Mexican-side extra), then the instruction — the agent's own give_instruction text when it's in the
 * call's language, otherwise the truck's current plan in the world (which reflects the dispatcher's decisions) — then
 * what it buys them.
 */
function driverBriefing(ctx: VoiceCtx, c: CallRecord): string | null {
  const es = c.language === 'es-MX';
  const instr = c.instruction?.trim();
  const instrOk = instr && es === looksSpanish(instr) ? instr.replace(/[.!\s]*$/, '.') : null;
  const t = c.truckId ? ctx.world.getTruck(c.truckId) : undefined;
  if (!t) return instrOk ?? instr ?? null;

  const ports = ctx.world.view('linea').ports;
  const lineMin = (id: string | null, ln: string | null): number | null => {
    const ps = ports.find((x) => x.id === id);
    if (!ps) return null;
    const l = ln === 'fast' && ps.fast.waitMin != null ? ps.fast : ps.standard;
    return l.waitMin == null ? null : l.waitMin + ps.mxSideExtraMin;
  };
  const otay = lineMin('otay_mesa', 'standard');
  const tec = lineMin('tecate', 'standard');
  const busy = otay != null && otay >= 60;
  const port = portLabel(t.port);
  const lane = (l: string | null) => (l === 'fast' ? 'FAST' : es ? 'estándar' : 'standard');
  const issue = otay == null
    ? ''
    : busy
      ? es
        ? `Otay Mesa está muy cargado, como ${dur(otay, es)} de fila${tec != null ? `, y Tecate está en ${dur(tec, es)}` : ''}.`
        : `Otay Mesa is backed up, about ${dur(otay, es)} in line${tec != null ? `, and Tecate is only ${dur(tec, es)}` : ''}.`
      : es
        ? `Las filas van bien, Otay Mesa está como en ${dur(otay, es)}.`
        : `Lines are moving well, Otay Mesa is about ${dur(otay, es)}.`;

  const nextDay = ms(t.deadline) - ms(ctx.world.now()) > 12 * 3600_000;
  const due = nextDay ? (es ? `mañana a las ${fmtClock(t.deadline)}` : `tomorrow's ${fmtClock(t.deadline)}`) : fmtClock(t.deadline);
  const late = t.etaDelivery ? Math.round((ms(t.etaDelivery) - ms(t.deadline)) / 60_000) : 0;
  const timing = !t.etaDelivery
    ? es ? `Tu entrega es antes de las ${due}.` : `Your delivery is due by ${due}.`
    : late > 0
      ? es ? `Vas unos ${late} minutos tarde para tu entrega de las ${due}.` : `You're running about ${late} minutes late for your ${due} delivery.`
      : es
        ? `Así entregas como a las ${fmtClock(t.etaDelivery)}, ${nextDay ? `mucho antes de ${due}` : `antes de las ${due}`}.`
        : `That gets you there around ${fmtClock(t.etaDelivery)}, ${nextDay ? `well ahead of ${due} deadline` : `before your ${due} deadline`}.`;
  const join = (...parts: string[]) => parts.filter(Boolean).join(' ');

  if (instrOk) return join(issue, instrOk, timing);
  switch (t.state) {
    case 'in_queue_mx':
    case 'in_queue_us':
      return busy && t.port === 'otay_mesa'
        ? es
          ? join(issue, `Como ya estás en la fila, quédate en el carril ${lane(t.lane)} de Otay Mesa; cambiarte ahora te costaría más tiempo.`, timing)
          : join(issue, `Since you're already in line, stay in the Otay Mesa ${lane(t.lane)} lane; switching now would cost you more time.`, timing)
        : es
          ? join(`Quédate en la fila de ${port}, carril ${lane(t.lane)}.`, timing)
          : join(`Stay in the ${port} ${lane(t.lane)} line.`, timing);
    case 'en_route':
      if (t.port === 'tecate' && busy) {
        return es ? join(issue, 'Para que llegues más rápido, sigue hacia Tecate, carril estándar.', timing) : join(issue, 'To get you there faster, head to Tecate, standard lane.', timing);
      }
      return busy
        ? es
          ? join(issue, `Sigue hacia ${port}, carril ${lane(t.lane)}; sigue siendo tu opción más rápida.`, timing)
          : join(issue, `Keep heading to ${port}, ${lane(t.lane)} lane; it's still your fastest option.`, timing)
        : es
          ? join(`Sigue hacia ${port}, carril ${lane(t.lane)}.`, timing)
          : join(`Keep heading to ${port}, ${lane(t.lane)} lane.`, timing);
    case 'held': {
      const until = t.heldUntil ? fmtClock(t.heldUntil) : '';
      return es
        ? join(issue, `Para que no te quedes atorado en esa fila, espera en el patio hasta las ${until}. Te llamo cuando sea hora de salir.`)
        : join(issue, `To keep you out of that line, hold at the yard until ${until}. I'll call you when it's time to go.`);
    }
    case 'at_yard': {
      const best = ctx.world.scoreOptions(t.id)[0];
      if (!best) return es ? 'Espera en el patio, te llamo cuando sea hora de salir.' : "Stand by at the yard, I'll call you when it's time to go.";
      const loadedLater = ms(best.departAt) - ms(ctx.world.now()) > 60_000;
      if (best.option === 'go_now' && loadedLater) {
        return es
          ? join(issue, `En cuanto te carguen, a las ${fmtClock(best.departAt)}, sal hacia ${portLabel(best.port)}, carril ${lane(best.lane)}.`)
          : join(issue, `As soon as you're loaded at ${fmtClock(best.departAt)}, head to ${portLabel(best.port)}, ${lane(best.lane)} lane.`);
      }
      if (best.option === 'go_now') {
        if (best.port === 'tecate' && busy) {
          return es ? join(issue, 'Para que llegues más rápido, sal ahora hacia Tecate, carril estándar.') : join(issue, 'To get you there faster, head out now to Tecate, standard lane.');
        }
        return es
          ? join(issue, `Sal ahora hacia ${portLabel(best.port)}, carril ${lane(best.lane)}.`)
          : join(issue, `Head out now to ${portLabel(best.port)}, ${lane(best.lane)} lane.`);
      }
      return es
        ? join(issue, `Para que no te quedes atorado en la fila, espera en el patio hasta las ${fmtClock(best.departAt)} y luego sal hacia ${portLabel(best.port)}.`)
        : join(issue, `To keep you out of that line, wait at the yard until ${fmtClock(best.departAt)}, then head to ${portLabel(best.port)}.`);
    }
    case 'crossed':
      return es ? `Ya cruzaste. Sigue directo a ${t.destination.name}.` : `You're across. Head straight to ${t.destination.name}.`;
    default:
      return instrOk ?? instr ?? null;
  }
}

function baseSystem(ctx: VoiceCtx, c: CallRecord, greeting: string): Anthropic.TextBlockParam[] {
  return c.kind === 'driver'
    ? [
        { type: 'text', text: c.language === 'en-US' ? DRIVER_RULES_EN : DRIVER_RULES },
        {
          type: 'text',
          text: driverCallData({ goal: c.goal ?? 'check_status', truckBrief: truckBrief(ctx, c), instruction: c.instruction, greeting, lang: c.language }),
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
  if (c.language === 'en-US') {
    if (!t) return 'no truck data';
    const whereEn =
      t.state === 'in_queue_mx' || t.state === 'in_queue_us'
        ? `in the ${portLabel(t.port)} line (${t.lane === 'fast' ? 'FAST' : 'standard'})`
        : t.state === 'en_route'
          ? `driving to ${portLabel(t.port)}`
          : 'at the yard';
    return `${truckLabel(t.id)}, driver ${t.driverName}, cargo ${t.cargo}, ${whereEn}, deliver by ${fmtClock(t.deadline)}`;
  }
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

// Words the caller is likely to say — biases Twilio's recognizer ("no" was heard as "I think", "stuck" as "Stock").
const HINTS: Record<CallRecord['language'], string> = {
  'en-US':
    'yes, no, not yet, yeah, nope, kilometer, kilometers, one, two, three, four, five, ten, miles, minutes, hour, stuck, stopped, moving, Mexican side, US side, Otay, Otay Mesa, Tecate, line, trucks, FAST lane, Pedro, keep, approve',
  'es-MX': 'sí, no, todavía no, kilómetro, kilómetros, uno, dos, tres, cuatro, cinco, minutos, hora, parado, avanzando, lado mexicano, Otay, Tecate, fila, camiones',
};

function listen(base: string, c: CallRecord, line: string): string {
  const s = sessions.get(c.callId);
  if (s) s.lastLine = line;
  const action = `${base}/voice/gather?callId=${encodeURIComponent(c.callId)}`;
  // phone_call + enhanced: Twilio's most accurate model for phone audio. A fixed pause (not "auto", which ended turns
  // mid-sentence) and bargeIn=false so echo or background noise can't cut Linea off mid-word.
  const pause = Math.max(1, Math.min(5, Number(process.env.GATHER_SPEECH_TIMEOUT) || 1));
  const model = c.language === 'en-US' ? ' speechModel="phone_call" enhanced="true"' : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" language="${c.language}"${model} hints="${xml(HINTS[c.language])}" speechTimeout="${pause}" timeout="6" bargeIn="false" actionOnEmptyResult="true" method="POST" action="${xml(action)}">${sayXml(line, c.language)}</Gather></Response>`;
}

function sayXml(text: string, lang: CallRecord['language']): string {
  const voice = lang === 'es-MX' ? process.env.GATHER_VOICE_ES || 'Polly.Mia-Neural' : process.env.GATHER_VOICE_EN || 'Polly.Joanna-Neural';
  return `<Say language="${lang}" voice="${voice}">${xml(text)}</Say>`;
}

function hangupXml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
