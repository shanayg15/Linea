// shared/types.ts — THE CONTRACT. After 2:30 PM: additive changes only, announced in chat.

export type PortId = 'otay_mesa' | 'tecate';
export type Lane = 'standard' | 'fast';
export type Policy = 'linea' | 'baseline';
export type Cargo = 'auto_parts' | 'medical' | 'produce' | 'general';
export type Priority = 'jit' | 'perishable' | 'standard';
export type LngLat = [number, number];

export type TruckState =
  | 'at_yard'      // loaded, awaiting dispatch decision
  | 'held'         // deliberately held at yard by Linea
  | 'en_route'     // driving toward assigned port
  | 'in_queue_mx'  // Mexican-side export queue (NOT visible in CBP data)
  | 'in_queue_us'  // US-side primary queue (what CBP measures)
  | 'crossed'      // past the port, driving to destination
  | 'delivered';

export interface SourceRef {
  id: string;        // stable, e.g. "cbp:otay_mesa:standard:14:55" or "driver:T4:14:57"
  kind: 'cbp_replay' | 'cbp_live' | 'driver_report' | 'optimizer' | 'schedule' | 'dispatcher';
  label: string;     // human, sentence case: "CBP · Otay Mesa standard · 118 min · 2:55 PM"
  observedAt: string; // ISO time
}

export interface Truck {
  id: string;               // "T1".."T10"
  driverName: string;
  cargo: Cargo;
  priority: Priority;
  fastEligible: boolean;
  readyAt: string;          // ISO sim time
  deadline: string;         // ISO sim time
  origin: { name: string; pos: LngLat };
  destination: { name: string; pos: LngLat };
  state: TruckState;
  pos: LngLat;
  heading: number;          // degrees, 0 = north, clockwise
  port: PortId | null;
  lane: Lane | null;
  heldUntil: string | null;
  queueEnteredAt: string | null;
  crossedAt: string | null;
  deliveredAt: string | null;
  minutesInLine: number;    // cumulative, MX + US
  etaDelivery: string | null;
  phoneMode: 'live' | 'simulated';
}

export interface LaneStatus { waitMin: number | null; lanesOpen: number | null; source: SourceRef }

export interface PortStatus {
  id: PortId;
  name: string;
  pos: LngLat;
  standard: LaneStatus;
  fast: LaneStatus;              // tecate: waitMin null (no FAST)
  mxSideExtraMin: number;        // learned ONLY from driver reports; 0 if none/expired
  mxSideSource: SourceRef | null;
  queuePath: LngLat[];           // approach polyline ending at the port (for queue rendering)
}

export interface WorldView {
  policy: Policy;
  simTime: string;
  trucks: Truck[];
  ports: PortStatus[];
}

export interface Metrics {
  truckHoursInLine: number;      // cumulative
  deliveredOnTime: number;
  deliveredLate: number;
  deliveriesTotal: number;       // 10
  jitAtRisk: number;             // jit trucks whose eta > deadline
  produceMinutesInLine: number;
  costUsd: number;               // linea only; baseline 0
  humanTouches: number;          // dispatcher interventions
  decisions: number;
  calls: number;
}

export interface MetricsPoint { t: string; linea: number; baseline: number } // cumulative truckHoursInLine

export type WatchdogState = 'ok' | 'warn' | 'tripped';
export interface WatchdogStatus {
  budget: { state: WatchdogState; usedUsd: number; capUsd: number; model: string };
  loops: { state: WatchdogState; detail: string };
  progress: { state: WatchdogState; fleetDelayMin: number; trend: 'improving' | 'flat' | 'worsening' };
}

export type TripKind =
  | 'budget' | 'oscillation' | 'repeat_tool' | 'repeat_call'
  | 'no_progress' | 'no_answer' | 'not_worth_it' | 'uncited';

export type ActionKind = 'hold' | 'dispatch' | 'reassign' | 'call_driver' | 'escalate' | 'no_action';

export interface SimClock {
  simTime: string;
  speed: number;           // sim seconds per wall second: 1 | 20 | 60
  paused: boolean;
  mode: 'live' | 'replay';
  scenarioStep: string;    // e.g. "spike", "oscillation", "normalizing"
}

interface Base<T extends string, P> {
  id: string;       // ulid
  seq: number;      // monotonic per server run
  simTime: string;  // ISO
  wallTime: string; // ISO
  type: T;
  payload: P;
}

export type LineaEvent =
  | Base<'world.tick', { linea: WorldView; baseline: WorldView; clock: SimClock }>
  | Base<'port.update', { portId: PortId; lane: Lane; waitMin: number | null; prevWaitMin: number | null; source: SourceRef }>
  | Base<'queue.report', { portId: PortId; side: 'mx'; lengthKm: number; extraWaitMin: number; reportedBy: string; source: SourceRef }>
  | Base<'live.cbp', { portId: PortId; lane: Lane; waitMin: number | null; lanesOpen: number | null; updateTime: string | null; fetchedAt: string; ok: boolean }>
  | Base<'agent.thinking', { text: string; trigger: string }>
  | Base<'agent.usage', { requestId: string; purpose: 'dispatch' | 'voice' | 'translate'; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }>
  | Base<'agent.decision', { decisionId: string; action: ActionKind; truckIds: string[]; title: string; detail: string; reasoning: string; sources: SourceRef[]; costUsd: number; model: string; origin: 'agent' | 'mock' | 'chaos' }>
  | Base<'tool.gate', { toolCallId: string; tool: string; args: Record<string, unknown>; idempotencyKey: string; verdict: 'allowed' | 'blocked' | 'deduped'; reason?: string; tripKind?: TripKind; origin: 'agent' | 'mock' | 'chaos' }>
  | Base<'call.started', { callId: string; kind: 'driver' | 'dispatcher'; truckId: string | null; personName: string; mode: 'live' | 'simulated'; language: 'es-MX' | 'en-US'; purpose: string }>
  | Base<'call.status', { callId: string; status: 'ringing' | 'in_progress' | 'no_answer' | 'busy' | 'failed' | 'completed' }>
  | Base<'call.transcript', { callId: string; utteranceId: string; speaker: 'linea' | 'human'; text: string; lang: string; textEnglish: string | null; final: boolean }>
  | Base<'call.tool', { callId: string; tool: string; args: Record<string, unknown>; result: string }>
  | Base<'call.ended', { callId: string; kind: 'driver' | 'dispatcher'; outcome: 'completed' | 'no_answer' | 'failed' | 'handoff'; durationSec: number; summary: string; costUsd: number }>
  | Base<'watchdog.status', WatchdogStatus>
  | Base<'watchdog.trip', { tripId: string; kind: TripKind; truckId: string | null; title: string; detail: string; evidence: string[]; response: 'blocked' | 'degraded' | 'paused' | 'escalated' | 'stopped' }>
  | Base<'watchdog.resolved', { tripId: string; resolution: string; by: 'dispatcher' | 'auto' }>
  | Base<'escalation', { escalationId: string; to: string; tripIds: string[]; summary: string; callId: string | null }>
  | Base<'metrics.update', { linea: Metrics; baseline: Metrics; point: MetricsPoint }>
  | Base<'sim.control', SimClock & { note?: string }>;

export type LineaEventType = LineaEvent['type'];
export type PayloadOf<T extends LineaEventType> = Extract<LineaEvent, { type: T }>['payload'];

export type ControlCmd =
  | { cmd: 'pause' } | { cmd: 'play' }
  | { cmd: 'speed'; value: 1 | 20 | 60 }
  | { cmd: 'inject_spike' }          // fire the 2:55 PM Otay spike now
  | { cmd: 'inject_missed_call' }    // next T6 call = no answer ×2
  | { cmd: 'inject_oscillation' }    // Tecate wait flaps 15↔95 every 2 sim-min for 12 sim-min
  | { cmd: 'chaos_flip' }            // B's chaos test: submit T7 flip proposals through the gate
  | { cmd: 'request_queue_report' }  // force agent trigger asking for a driver queue report
  | { cmd: 'budget_squeeze' }        // cap = used + $0.10 → degrade path
  | { cmd: 'reset' }
  | { cmd: 'start_recording' } | { cmd: 'stop_recording' };
