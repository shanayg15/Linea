import type { WorldView, Truck, PortId, Lane, Policy, SourceRef, LineaEventType, PayloadOf, LineaEvent } from '../../../shared/types';

export interface EventBus {
  emit<T extends LineaEventType>(type: T, payload: PayloadOf<T>): LineaEvent;
  on(fn: (e: LineaEvent) => void): () => void;
  recent(n: number): LineaEvent[];
}

export type WorldAction =
  | { kind: 'hold'; truckId: string; until: string }
  | { kind: 'dispatch'; truckId: string; port: PortId; lane: Lane }
  | { kind: 'reassign'; truckId: string; port: PortId; lane: Lane };

export interface OptionScore {
  option: 'go_now' | 'hold_30' | 'hold_60' | 'hold_90' | 'hold_until_1830';
  port: PortId;
  lane: Lane;
  departAt: string;
  expectedLineMin: number;     // forecast US wait + known MX extra
  expectedDeliveryAt: string;
  lateMin: number;
  score: number;               // lower is better
  explanation: string;         // "Otay FAST at 3:10 PM · ~45 min line · on time"
  sourceIds: string[];         // sources the forecast used
}

export interface WorldApi {
  bus: EventBus;
  now(): string;                                   // sim time ISO
  view(policy?: Policy): WorldView;                // default 'linea'
  getTruck(id: string): Truck | undefined;
  scoreOptions(truckId: string): OptionScore[];    // sorted best-first
  projectFleetDelayMin(): number;                  // progress metric (linea)
  sources(): SourceRef[];                          // currently citeable sources
  applyAction(a: WorldAction): { ok: boolean; message: string };
  reportQueue(r: { portId: PortId; lengthKm: number; extraWaitMin: number; reportedBy: string }): SourceRef;
  setClockSpeed(speed: 1 | 20 | 60): void;
  restoreClockSpeed(): void;
  isScenarioFlag(flag: 'missed_call_T6'): boolean; // set by inject_missed_call
}

// B implements and exports from server/src/agent/index.ts:
export interface Agent {
  trigger(reason: string, detail?: Record<string, unknown>): void; // debounced inside B
  handleControl(cmd: { cmd: string }): void;                       // budget_squeeze, chaos_flip, request_queue_report
  stop(): void;
}
// export function createAgent(world: WorldApi): Agent
// export function mountVoice(app: import('express').Express, server: import('http').Server, world: WorldApi): void
