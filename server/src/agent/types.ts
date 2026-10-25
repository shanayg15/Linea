// Track B internal types (agent ↔ watchdog ↔ voice). Not part of the shared contract.
import type { Lane, PortId, TripKind } from '../../../shared/types';

export type Origin = 'agent' | 'mock' | 'chaos';
export type CallGoal = 'learn_queue' | 'give_instruction' | 'check_status';

export type ToolName =
  | 'hold_truck'
  | 'dispatch_truck'
  | 'reassign_truck'
  | 'call_driver'
  | 'escalate_to_dispatcher'
  | 'no_action';

export interface ProposedAction {
  toolCallId: string;
  tool: ToolName;
  args: Record<string, unknown>; // raw tool input (shown in tool.gate)
  truckId: string | null;
  port?: PortId;
  lane?: Lane;
  until?: string; // ISO
  goal?: CallGoal;
  sourceIds: string[];
  origin: Origin;
}

export interface GateResult {
  verdict: 'allowed' | 'blocked' | 'deduped';
  reason?: string;
  tripKind?: TripKind;
  idempotencyKey: string;
}

export type BudgetState = 'ok' | 'warn' | 'critical' | 'stopped';

export interface DispatcherDecision {
  tripIds: string[];
  decision: 'keep_current' | 'approve_linea_plan' | 'raise_budget' | 'custom';
  note: string;
}

// Hooks the voice layer calls back into (watchdog + dispatcher). Keeps voice → agent imports one-way.
export interface VoiceHooks {
  onNoAnswer(truckId: string): void;
  onAnswered(truckId: string): void;
  onCost(usd: number): void; // Claude voice/translate usage + Twilio minutes
  onDispatcherDecision(d: DispatcherDecision): void;
}

export interface StartDriverCall {
  truckId: string;
  goal: CallGoal;
  /** Asked for by the operator (hotkey C). With LIVE_DRIVER_CALLS=request (default) only these ring a real phone. */
  operator?: boolean;
  instruction?: string;
}

export interface StartDispatcherCall {
  summary: string;
  questions: string[];
  tripIds: string[];
}

export interface Voice {
  startDriverCall(c: StartDriverCall): Promise<string>; // returns callId
  startDispatcherCall(c: StartDispatcherCall): Promise<string>;
}
