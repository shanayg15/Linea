import type Anthropic from '@anthropic-ai/sdk';
import type { Lane, PortId } from '../../../shared/types';
import { parseClock } from './time';
import type { CallGoal, Origin, ProposedAction, ToolName } from './types';

const common = {
  title: { type: 'string', description: 'Notification-style title, sentence case, ≤ 60 chars.' },
  reasoning: { type: 'string', description: 'Max 2 short sentences, include the number that drove the decision.' },
  source_ids: {
    type: 'array',
    items: { type: 'string' },
    description: 'Ids from citeableSourceIds that justify this action.',
  },
} as const;
const commonRequired = ['title', 'reasoning', 'source_ids'];

const truckId = { type: 'string', description: 'Truck id, e.g. "T8".' } as const;
const port = { type: 'string', enum: ['otay_mesa', 'tecate'] } as const;
const lane = { type: 'string', enum: ['standard', 'fast'], description: 'Tecate has no FAST lane.' } as const;

function tool(name: ToolName, description: string, props: Record<string, unknown>, required: string[]): Anthropic.Tool {
  return {
    name,
    description,
    input_schema: {
      type: 'object',
      properties: { ...props, ...common },
      required: [...required, ...commonRequired],
    },
  };
}

// Static and deterministic → cached (cache_control on the last tool).
export const DISPATCH_TOOLS: Anthropic.Tool[] = [
  tool('hold_truck', 'Keep a truck at the yard until a given time.', { truck_id: truckId, until: { type: 'string', description: 'Clock time, e.g. "6:30 PM".' } }, ['truck_id', 'until']),
  tool('dispatch_truck', 'Send a waiting or held truck to a port and lane now.', { truck_id: truckId, port, lane }, ['truck_id', 'port', 'lane']),
  tool('reassign_truck', 'Change the port/lane of a truck that is already en route or held. Not possible once it is in line.', { truck_id: truckId, port, lane }, ['truck_id', 'port', 'lane']),
  tool(
    'call_driver',
    'Phone a driver (Spanish). learn_queue: ask a driver already in line how long the Mexican-side queue really is. give_instruction: tell a driving truck about a change. check_status: ask where they are.',
    {
      truck_id: truckId,
      goal: { type: 'string', enum: ['learn_queue', 'give_instruction', 'check_status'] },
      instruction: { type: 'string', description: 'Plain text instruction, Spanish-ready (only for give_instruction).' },
    },
    ['truck_id', 'goal'],
  ),
  tool(
    'escalate_to_dispatcher',
    'Phone Ana, the human dispatcher, with a batched summary of what needs her judgment.',
    {
      summary: { type: 'string', description: '≤ 2 sentences, English.' },
      questions: { type: 'array', items: { type: 'string' }, maxItems: 2 },
      truck_ids: { type: 'array', items: { type: 'string' } },
    },
    ['summary', 'questions', 'truck_ids'],
  ),
  tool('no_action', 'Nothing should change right now. source_ids may be empty.', {}, []),
];
DISPATCH_TOOLS[DISPATCH_TOOLS.length - 1]!.cache_control = { type: 'ephemeral' };

export const ACTION_OF: Record<ToolName, 'hold' | 'dispatch' | 'reassign' | 'call_driver' | 'escalate' | 'no_action'> = {
  hold_truck: 'hold',
  dispatch_truck: 'dispatch',
  reassign_truck: 'reassign',
  call_driver: 'call_driver',
  escalate_to_dispatcher: 'escalate',
  no_action: 'no_action',
};

const TOOL_NAMES = new Set<string>(Object.keys(ACTION_OF));

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** tool_use block → ProposedAction. Returns null for unknown tools. Validation of values is the gate's / world's job. */
export function toProposal(
  toolCallId: string,
  name: string,
  input: unknown,
  nowIso: string,
  origin: Origin = 'agent',
): ProposedAction | null {
  if (!TOOL_NAMES.has(name)) return null;
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const sourceIds = Array.isArray(a.source_ids) ? a.source_ids.filter((s): s is string => typeof s === 'string') : [];
  const truckIds = Array.isArray(a.truck_ids) ? a.truck_ids.filter((s): s is string => typeof s === 'string') : [];
  const untilRaw = str(a.until);
  return {
    toolCallId,
    tool: name as ToolName,
    args: a,
    truckId: str(a.truck_id) ?? truckIds[0] ?? null,
    port: str(a.port) as PortId | undefined,
    lane: str(a.lane) as Lane | undefined,
    until: untilRaw ? parseClock(untilRaw, nowIso) ?? undefined : undefined,
    goal: str(a.goal) as CallGoal | undefined,
    sourceIds,
    origin,
  };
}
