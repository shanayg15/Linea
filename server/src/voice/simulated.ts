// Simulated calls (TRACK_B §B7): same events as live, canned lines, no Twilio, no Claude, no clock change.
import { ulid } from 'ulid';
import { finishCall, setStatus, type CallRecord, type VoiceCtx } from './calls';

const sleep = (msec: number) => new Promise((r) => setTimeout(r, msec));

interface Line {
  speaker: 'linea' | 'human';
  text: string;
  en: string;
}

function say(ctx: VoiceCtx, call: CallRecord, l: Line) {
  ctx.world.bus.emit('call.transcript', {
    callId: call.callId,
    utteranceId: ulid(),
    speaker: l.speaker,
    text: l.text,
    lang: call.language,
    textEnglish: call.language === 'en-US' ? l.text : l.en,
    final: true,
  });
}

function tool(ctx: VoiceCtx, call: CallRecord, name: string, args: Record<string, unknown>, result: string) {
  ctx.world.bus.emit('call.tool', { callId: call.callId, tool: name, args, result });
}

export async function runSimulatedDriverCall(ctx: VoiceCtx, call: CallRecord): Promise<void> {
  const { world } = ctx;
  const truckId = call.truckId!;
  const name = call.personName;
  await sleep(800);
  setStatus(ctx, call, 'ringing');

  if (truckId === 'T6' && world.isScenarioFlag('missed_call_T6')) {
    await sleep(2200);
    setStatus(ctx, call, 'no_answer');
    finishCall(ctx, call, 'no_answer', `${name} did not answer.`);
    return;
  }

  await sleep(800);
  setStatus(ctx, call, 'in_progress');
  const intro = `Hola ${name}, habla Linea, el despachador automático.`;
  const introEn = `Hi ${name}, this is Linea, the automated dispatcher.`;
  let summary = '';

  switch (call.goal) {
    case 'learn_queue': {
      const portId = world.getTruck(truckId)?.port ?? 'otay_mesa';
      say(ctx, call, { speaker: 'linea', text: `${intro} ¿Cuánto te falta para la garita?`, en: `${introEn} How far are you from the port?` });
      await sleep(1200);
      say(ctx, call, { speaker: 'human', text: 'Voy como a un kilómetro, del lado mexicano.', en: "I'm about one kilometer back, on the Mexican side." });
      await sleep(1200);
      const args = { port_id: portId, side: 'mx', length_km: 1, extra_wait_min: 30 };
      const src = world.reportQueue({ portId, lengthKm: 1, extraWaitMin: 30, reportedBy: truckId });
      tool(ctx, call, 'report_queue_position', args, `Recorded: ${src.label}`);
      say(ctx, call, { speaker: 'linea', text: 'Gracias, ajusto el plan.', en: "Thanks, I'm adjusting the plan." });
      summary = `${name} is ~1 km back on the Mexican side (+30 min).`;
      break;
    }
    case 'give_instruction': {
      const instr = call.instruction ?? 'sigue con el plan actual';
      say(ctx, call, { speaker: 'linea', text: `${intro} ${name}, cambio de plan: ${instr}`, en: `${introEn} Change of plan: ${instr}` });
      await sleep(1200);
      say(ctx, call, { speaker: 'human', text: 'Va, entendido.', en: 'Okay, got it.' });
      await sleep(1200);
      tool(ctx, call, 'confirm_instruction', { accepted: true }, 'Driver accepted');
      say(ctx, call, { speaker: 'linea', text: 'Gracias, buen camino.', en: 'Thanks, safe travels.' });
      summary = `${name} accepted the new instruction.`;
      break;
    }
    default: {
      say(ctx, call, { speaker: 'linea', text: `${intro} ¿Cómo vas?`, en: `${introEn} How's it going?` });
      await sleep(1200);
      say(ctx, call, { speaker: 'human', text: 'Todo bien, ya voy en camino.', en: "All good, I'm on my way." });
      await sleep(1200);
      tool(ctx, call, 'report_status', { status: 'driving', note: 'Todo bien' }, 'Status recorded');
      say(ctx, call, { speaker: 'linea', text: 'Perfecto, gracias.', en: 'Perfect, thanks.' });
      summary = `${name} is driving, all good.`;
    }
  }
  await sleep(1000);
  setStatus(ctx, call, 'completed');
  finishCall(ctx, call, 'completed', summary);
}

export async function runSimulatedDispatcherCall(ctx: VoiceCtx, call: CallRecord): Promise<void> {
  await sleep(800);
  setStatus(ctx, call, 'ringing');
  await sleep(1200);
  setStatus(ctx, call, 'in_progress');
  say(ctx, call, { speaker: 'linea', text: `Hi Ana, it's Linea. ${call.summary ?? ''}`.trim(), en: '' });
  await sleep(1500);

  const q = (call.questions ?? []).map((x) => /keep (\w+) on ([\w ]+?)\?/i.exec(x)).find(Boolean);
  const answer = q ? `Keep ${q[1]} on ${q[2]!.replace(/ Mesa$/, '')}.` : 'Go with your plan.';
  const decision = q ? 'keep_current' : 'approve_linea_plan';
  say(ctx, call, { speaker: 'human', text: answer, en: '' });
  await sleep(1200);
  const d = { tripIds: call.tripIds, decision, note: answer } as const;
  call.decision = d;
  ctx.hooks.onDispatcherDecision(d);
  ctx.world.bus.emit('call.tool', { callId: call.callId, tool: 'dispatcher_decision', args: { trip_ids: d.tripIds, decision, note: answer }, result: 'Applied' });
  say(ctx, call, { speaker: 'linea', text: q ? "Got it — I'll keep things as they are." : "Got it — I'll go ahead.", en: '' });
  await sleep(1000);
  setStatus(ctx, call, 'completed');
  finishCall(ctx, call, 'completed', `Ana: ${answer}`);
}
