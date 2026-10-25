import type Anthropic from '@anthropic-ai/sdk';
import type { CallGoal } from '../agent/types';

// Static rules first (stable prefix), per-call data in a second block.
export const DRIVER_RULES = `Eres Linea, el despachador automático (una inteligencia artificial) de Transportes Mesa. Hablas por teléfono con un chofer que maneja. Reglas: frases cortas (máximo 20 palabras por turno), español mexicano natural, sin listas ni formato, números dichos con naturalidad. Nunca finjas ser humano.
Si el chofer dice dónde está en la fila, llama report_queue_position con tu mejor estimación en kilómetros y minutos extra (≈ 30 min por km del lado mexicano). Si da su estado, llama report_status. Si le das una instrucción, confirma que la aceptó con confirm_instruction. Cuando tengas lo necesario, despídete en una frase y llama end_call.`;

export const DRIVER_RULES_EN = `You are Linea, the automated dispatcher (an AI) for Transportes Mesa. You are on the phone with a truck driver. Rules: short sentences (20 words max per turn), natural spoken English, no lists or formatting, say numbers naturally. Never pretend to be human.
If the driver says where they are in line, call report_queue_position with your best estimate in kilometers and extra minutes (about 30 min per km on the Mexican side). If they give their status, call report_status. If you give them an instruction, confirm they accepted with confirm_instruction. When you have what you need, say goodbye in one sentence and call end_call.`;

/** Language for LIVE driver calls (simulated calls stay es-MX). DRIVER_LANGUAGE=en-US for English. */
export function driverLanguage(): 'es-MX' | 'en-US' {
  return (process.env.DRIVER_LANGUAGE ?? '').trim().toLowerCase().startsWith('en') ? 'en-US' : 'es-MX';
}

export function driverCallData(p: { goal: CallGoal; truckBrief: string; instruction?: string; greeting: string; lang?: 'es-MX' | 'en-US' }): string {
  if (p.lang === 'en-US') {
    return `Goal of this call: ${GOAL_EN[p.goal]}. Data: ${p.truckBrief}. Instruction to give (if any): ${p.instruction ?? 'none'}.
You already greeted them with: "${p.greeting}"`;
  }
  return `Objetivo de esta llamada: ${GOAL_ES[p.goal]}. Datos: ${p.truckBrief}. Instrucción a dar (si hay): ${p.instruction ?? 'ninguna'}.
Ya saludaste con: "${p.greeting}"`;
}

const GOAL_EN: Record<CallGoal, string> = {
  learn_queue: 'find out how long they really have until crossing, especially the line on the Mexican side',
  give_instruction: 'give them the instruction and confirm they accepted it',
  check_status: 'find out where they are and whether everything is OK',
};

const GOAL_ES: Record<CallGoal, string> = {
  learn_queue: 'saber cuánto le falta realmente para cruzar, sobre todo la fila del lado mexicano',
  give_instruction: 'darle la instrucción y confirmar que la aceptó',
  check_status: 'saber dónde va y si todo está bien',
};

export const DISPATCHER_RULES = `You are Linea, an AI dispatcher, calling Ana, the human dispatcher, because the watchdog needs her judgment. Be brief and concrete: one sentence per issue, then ask the question. Options you can apply: keep_current, approve_linea_plan, raise_budget, custom. When Ana decides, call dispatcher_decision, confirm in one sentence, then call end_call. This is a phone call: no lists or formatting.`;

export function dispatcherCallData(p: { summary: string; questions: string[]; tripIds: string[]; greeting: string }): string {
  return `Summary: ${p.summary}
Questions: ${p.questions.join(' ') || '(none)'}
Trip ids: ${p.tripIds.join(', ') || '(none)'}
You already greeted her with: "${p.greeting}"`;
}

export function driverGreeting(name: string, goal: CallGoal, lang: 'es-MX' | 'en-US' = 'es-MX'): string {
  if (lang === 'en-US') {
    const intro = `Hi ${name}, this is Linea, the automated dispatcher for Transportes Mesa. I'm an AI.`;
    if (goal === 'learn_queue') return `${intro} Are you in the Otay line yet?`;
    if (goal === 'give_instruction') return `${intro} I have a change of plan for you, can you hear me OK?`;
    return `${intro} How's it going?`;
  }
  const intro = `Hola ${name}, habla Linea, el despachador automático de Transportes Mesa. Soy una inteligencia artificial.`;
  if (goal === 'learn_queue') return `${intro} ¿Ya estás en la fila de Otay?`;
  if (goal === 'give_instruction') return `${intro} Tengo un cambio de plan para ti, ¿me escuchas bien?`;
  return `${intro} ¿Cómo vas?`;
}

export const DISPATCHER_GREETING = "Hi Ana, it's Linea. A few things need you.";

const endCall: Anthropic.Tool = {
  name: 'end_call',
  description: 'Hang up after saying goodbye. summary_en: one English sentence summarising the call.',
  input_schema: { type: 'object', properties: { summary_en: { type: 'string' } }, required: ['summary_en'] },
};

export const DRIVER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'report_queue_position',
    description: 'Record where the driver is in line. extra_wait_min ≈ 30 min per km on the Mexican side.',
    input_schema: {
      type: 'object',
      properties: {
        port_id: { type: 'string', enum: ['otay_mesa', 'tecate'] },
        side: { type: 'string', enum: ['mx'] },
        length_km: { type: 'number' },
        extra_wait_min: { type: 'number' },
      },
      required: ['port_id', 'side', 'length_km', 'extra_wait_min'],
    },
  },
  {
    name: 'report_status',
    description: "Record the driver's status.",
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['in_queue', 'driving', 'at_yard', 'problem'] }, note: { type: 'string' } },
      required: ['status'],
    },
  },
  {
    name: 'confirm_instruction',
    description: 'Record whether the driver accepted the instruction.',
    input_schema: { type: 'object', properties: { accepted: { type: 'boolean' }, note: { type: 'string' } }, required: ['accepted'] },
  },
  endCall,
];

export const DISPATCHER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'dispatcher_decision',
    description: "Apply Ana's decision to the watchdog trips.",
    input_schema: {
      type: 'object',
      properties: {
        trip_ids: { type: 'array', items: { type: 'string' } },
        decision: { type: 'string', enum: ['keep_current', 'approve_linea_plan', 'raise_budget', 'custom'] },
        note: { type: 'string' },
      },
      required: ['decision'],
    },
  },
  endCall,
];

export const CLOSING = { es: 'Gracias, te dejo. Buen camino.', en: "Thanks Ana, I'll take it from here.", driverEn: 'Thanks, drive safe.' };

/** Goodbye line for a call, by kind and language. */
export function closingFor(c: { kind: 'driver' | 'dispatcher'; language: 'es-MX' | 'en-US' }): string {
  if (c.language === 'es-MX') return CLOSING.es;
  return c.kind === 'driver' ? CLOSING.driverEn : CLOSING.en;
}
