# Linea — Master Spec (read this first, every track)

> c0mpiled-16 @ UCSD · Track: **Dispatch** (pitch also covers No App + Unsupervised)
> Building 2:00 PM → submissions due **7:30 PM**. Submit by **7:15**.
> Three people build in parallel from the contracts below, merge at **3:25 PM**.

---

## 0. One-paragraph pitch

Linea is an autonomous cross-border truck dispatcher for a small Tijuana carrier running loads north through the Otay Mesa commercial port. It watches CBP border wait data, decides per truck when to go, which lane, and whether to divert or hold, and it **talks to drivers only by phone** (Spanish, clearly identifies itself as an AI). Drivers already in line become **sensors** for the Mexican-side queue CBP doesn't measure. A **watchdog gates every action** (budget, idempotency, oscillation/loop detection, no-progress detection, cite-or-block) and phones the human dispatcher (Ana) only when it actually needs her. The screen is a glass box so judges can watch it think — the users themselves never need it.

Claude powers it: **Claude Sonnet 5.5** makes dispatch decisions via tool use; **Claude Haiku 5.5** runs the live phone conversations (latency) and translation.

---

## 1. Who builds what

| Track | Owner | File | Owns directories | Delivers |
|---|---|---|---|---|
| **A — World & Server** | Person A | `TRACK_A_WORLD.md` | `/shared`, `/server/src/world`, `/server/src/server`, `/server/src/index.ts`, `/scripts`, root config files, `/server/package.json` | Repo skeleton, shared contract, simulator (both policies), CBP data, optimizer, metrics, SSE event bus, control endpoints, recorder/replay, mock agent |
| **B — Agent & Voice** | Person B | `TRACK_B_AGENT_VOICE.md` | `/server/src/agent`, `/server/src/voice` | Claude dispatcher loop + tools, watchdog gate, cost meter, Twilio ConversationRelay phone calls (driver + dispatcher), simulated calls, chaos test |
| **C — UI** | Person C | `TRACK_C_UI.md` | `/web`, `/fixtures/mock-events.jsonl` | Apple-grade glass-box dashboard: map, Dynamic-Island status, activity feed, live call card, with-vs-without impact card, segmented control, end card, hotkeys |

**Golden rules**
1. **Never edit files outside your owned directories.** Need a change elsewhere → message the owner.
2. `shared/types.ts` is the contract. Person A commits it verbatim from §4 in the first 10 minutes. **After 2:30 PM, additive changes only**, announced in the team chat.
3. Only Person A edits `package.json` files and lockfiles. All server deps are pre-installed by A (list in §6) so B never needs to.
4. Commit and push every ~20 min to your branch (`track-a`, `track-b`, `track-c`). The repo must be **public** at submission.
5. Everything the UI shows comes from **events** (§4). No side channels.

---

## 2. Timeline (it's ~2:10 now)

| Time | What |
|---|---|
| 2:15–2:25 | **A** creates repo skeleton + `shared/types.ts` + `.env.example`, pushes `main`. **B** sets up Twilio (buy number, verify 2 phones, tunnel) and Anthropic key. **C** scaffolds `/web` on its own (Vite) and starts the design system. |
| 2:25–3:25 | **Parallel build (60 min).** A: sim + optimizer + SSE + mock agent. B: Claude agent + watchdog against a fake world, then voice. C: UI against `fixtures/mock-events.jsonl`. |
| 3:25–3:55 | **Merge** (§8 checklist). Order: A → B → C. |
| 3:55–5:15 | Second pass: scenario tuning, voice reliability, UI polish, watchdog drama. |
| 5:15–6:00 | Full dress rehearsal ×3 on the projector-ish screen. **Record runs** (`runs/*.jsonl`). |
| 6:00–6:45 | Record demo video (replay mode + real call audio). |
| 6:45–7:15 | README, verify public repo + video link, **submit**. |

---

## 3. Architecture

```
                         ┌───────────────────────────── server (Node 20, TS, Express, port 8787) ─────────────────────────────┐
 CBP live feed ─poll 5m─▶│ world/cbp.ts ──▶ live.cbp events (LIVE badge only)                                                   │
                         │                                                                                                      │
                         │ world/sim.ts  (seeded, deterministic, 4 Hz)                                                          │
                         │   ├─ scenario.ts  (weekday replay curves, fleet, scripted beats)                                     │
                         │   ├─ policy BASELINE  (go when ready, Otay Mesa, FAST if eligible, never hold/divert)                │
                         │   └─ policy LINEA     (actions come only from the agent through the watchdog gate)                   │
                         │ world/optimizer.ts  scoreOptions(), projectFleetDelayMin()                                           │
                         │ world/metrics.ts    both policies, MetricsPoint every 5 sim-min                                      │
                         │        │ triggers: truck_ready, port_change, queue_report, hold_expired, call_ended, heartbeat         │
                         │        ▼                                                                                             │
                         │ agent/dispatcher.ts  ──Claude Sonnet 5.5 (tools)──▶ agent/watchdog.ts (gate) ──▶ world.applyAction() │
                         │        │ call_driver / escalate                                                                      │
                         │        ▼                                                                                             │
 Twilio ◀──REST create───│ voice/calls.ts ── TwiML <ConversationRelay> ──▶ wss /voice/relay ◀─▶ voice/relay.ts ◀─▶ Claude Haiku │
 phones  ──status cb────▶│ /voice/status                                                                                        │
                         │                                                                                                      │
                         │ server/bus.ts  (EventEmitter + ring buffer 3000 + JSONL recorder)                                    │
                         │ server/http.ts GET /events (SSE) · GET /snapshot · POST /control · GET /health                       │
                         └──────────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                                                        │ SSE
                                                               web (Vite React, port 5173)
```

**Modes**
- `MODE=live` (default): sim runs, agent runs, real calls possible.
- `MODE=replay RUN_FILE=runs/xxx.jsonl`: server streams a recorded run with original timing. Same `/events` + `/control` (pause/play/speed). **This is the Wi-Fi-proof demo and the video source.**
- `AGENT_MODE=claude` (default) | `mock` (A's rule-based stand-in, no API calls).

---

## 4. The contract — `shared/types.ts` (A commits this verbatim)

```ts
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
```

### 4.1 Server-internal contract between A and B — `server/src/world/api.ts` (A writes, B consumes)

```ts
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
```

A's `index.ts` does:
```ts
const agent = process.env.AGENT_MODE === 'mock' ? createMockAgent(world) : (await import('./agent')).createAgent(world);
if (process.env.AGENT_MODE !== 'mock') (await import('./voice')).mountVoice(app, httpServer, world);
```

---

## 5. Scenario (A implements, everyone must know it)

**Replay day:** Thursday **2026-10-22**, sim **1:30 PM → 7:30 PM** PT (`-07:00`). Default speed **60×** (1 wall sec = 1 sim min → whole shift ≈ 6 wall minutes). During a **live** phone call the clock drops to **1×** and restores after.

**Carrier:** Transportes Mesa (fictional), Tijuana. Dispatcher: **Ana** (live phone). Live driver: **Carlos, Truck 4** (live phone). All other drivers simulated.

| Truck | Driver | Cargo | Priority | FAST | Ready | Deadline | Origin → Destination |
|---|---|---|---|---|---|---|---|
| T1 | Luis | auto_parts | jit | yes | 1:40 PM | 4:30 PM | Nueva Tijuana → Otay Mesa cross-dock |
| T2 | Rosa | auto_parts | jit | yes | 2:10 PM | 5:00 PM | Nueva Tijuana → Otay Mesa cross-dock |
| T3 | Jorge | auto_parts | jit | no | 2:40 PM | 5:30 PM | El Florido → Chula Vista DC |
| T4 | **Carlos** | auto_parts | jit | no | 2:15 PM | 5:15 PM | El Florido → Chula Vista DC |
| T5 | Marta | medical | standard | yes | 2:30 PM | 6:30 PM | Pacífico → Kearny Mesa medical DC |
| T6 | Iván | medical | standard | no | 3:00 PM | 7:00 PM | Pacífico → Kearny Mesa medical DC |
| T7 | Pedro | medical | standard | no | 3:20 PM | 7:15 PM | El Florido → Kearny Mesa medical DC |
| T8 | Elena | produce (San Quintín) | perishable | no | 2:50 PM | 5:00 PM | El Florido → SD produce terminal |
| T9 | Raúl | general | standard | no | 3:00 PM | next day 10:00 AM | Nueva Tijuana → Otay Mesa cross-dock |
| T10 | Sofía | general | standard | no | 3:10 PM | next day 10:00 AM | Pacífico → Chula Vista DC |

**Wait curves (minutes, linear interpolation between points).** Agent sees only `port.update` (US side). Truth MX-side extra is hidden until a driver reports it.

| Sim time | Otay std | Otay FAST | Tecate std | Otay MX-side extra (hidden truth) |
|---|---|---|---|---|
| 1:30 | 35 | 15 | 20 | 10 |
| 2:30 | 45 | 18 | 22 | 15 |
| **2:55 spike** | **118** | **45** | 25 | **60** |
| 3:30 | 125 | 48 | 25 | 60 |
| 4:30 | 110 | 40 | 30 | 45 |
| 5:30 | 95 | 30 | 28 | 35 |
| 6:30 | 55 | 20 | 22 | 15 |
| 7:30 | 40 | 15 | 20 | 10 |

`port.update` events are emitted whenever the interpolated value moves ≥ 5 min from the last emitted value, plus once at 2:55 for the spike (CBP updates hourly in reality; we compress — say so if asked).

**Story beats (auto at these sim times, or fired early by hotkey)**

| Beat | Sim time | Hotkey | What happens | Proves |
|---|---|---|---|---|
| 1. Calm | 1:30–2:55 | — | Trucks dispatched as they're ready. Feed calm. | Baseline sanity |
| 2. Spike | 2:55 | `S` | Otay std 35→118. Agent re-plans: holds T9/T10, pushes T8 produce to Tecate, FAST for T5. | Live data → decision, cited |
| 3. Driver as sensor | ~2:57 | `C` | Agent calls **Carlos (T4, live)**, who is in line: "Estoy como a dos kilómetros, del lado mexicano." → `queue.report` +60 min MX → re-plan for everyone else. | Voice, tool calls mid-call, hidden data |
| 4. Missed call | ~3:15 | `M` | Agent calls T6 (simulated) → no answer ×2 → watchdog `no_answer` trip. | Know when to stop retrying |
| 5. Oscillation | ~3:25 | `O` (data flaps) / `Shift+O` (chaos test) | Tecate flaps 15↔95; agent tries T7 Otay→Tecate→Otay; 3rd flip **blocked**, trip, T7 frozen. | Loop detection that's real |
| 6. Escalation | right after 5 | — | Watchdog batches trips → **calls Ana (live, English)**: "Two things need you…" Ana: "Keep Pedro on Otay." → resolved. humanTouches = 1. | Human only when needed |
| 7. Budget | any time | `B` | Cap squeezed → model degrades Sonnet→Haiku, non-priority calls blocked. | Overspend handling |
| 8. Normalize | 6:30 | — | Wait drops; held trucks released. Final numbers. | Impact |

**Expected outcome (tune scenario until roughly true):** Linea saves **≥ 4 truck-hours in line** vs baseline, **10/10 on time vs ~7/10**, produce in line **< 30 min vs ~2.5 h**, cost **≈ $1–2 per shift**, **1 human touch**.

---

## 6. Repo, stack, env

```
linea/
  SPEC.md  TRACK_A_WORLD.md  TRACK_B_AGENT_VOICE.md  TRACK_C_UI.md  README.md
  package.json            # npm workspaces: ["server", "web"]
  tsconfig.base.json
  .env.example
  shared/types.ts  shared/geo.ts  shared/routes.json
  server/package.json  server/tsconfig.json
  server/src/index.ts
  server/src/server/{bus.ts,http.ts,recorder.ts,replay.ts}
  server/src/world/{api.ts,sim.ts,scenario.ts,optimizer.ts,metrics.ts,cbp.ts,mockAgent.ts,clock.ts,geo.ts}
  server/src/agent/{index.ts,dispatcher.ts,tools.ts,watchdog.ts,cost.ts,prompts.ts,chaos.ts}
  server/src/voice/{index.ts,calls.ts,relay.ts,simulated.ts,prompts.ts,translate.ts}
  web/...                 # Track C
  fixtures/mock-events.jsonl
  runs/                   # recorded runs (gitignored except the best one: runs/demo.jsonl)
  scripts/build-routes.ts
```

**Server deps (A installs all at skeleton time):** `express@4 ws cors dotenv ulid @anthropic-ai/sdk twilio` · dev: `typescript tsx @types/node @types/express @types/ws @types/cors`. Scripts: `"dev": "tsx watch src/index.ts"`, `"replay": "MODE=replay tsx src/index.ts"`.

**Web deps (C installs):** `react react-dom maplibre-gl @deck.gl/core @deck.gl/layers @deck.gl/geo-layers @deck.gl/extensions @deck.gl/mapbox framer-motion zustand lucide-react d3-shape` · dev: `vite @vitejs/plugin-react typescript tailwindcss@3 postcss autoprefixer @types/d3-shape`.

**`.env.example`**
```
PORT=8787
MODE=live                     # live | replay
RUN_FILE=runs/demo.jsonl
AGENT_MODE=claude             # claude | mock
SIM_SPEED=60
SIM_SEED=1022
ANTHROPIC_API_KEY=
MODEL_DISPATCH=claude-sonnet-5-5
MODEL_VOICE=claude-haiku-5-5
MODEL_DEGRADED=claude-haiku-5-5
BUDGET_CAP_USD=3.00
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=           # +1...
PHONE_T4_CARLOS=              # teammate playing Carlos (verified number)
PHONE_DISPATCHER_ANA=         # teammate playing Ana (verified number)
PUBLIC_BASE_URL=              # https://xxxx.trycloudflare.com  (tunnel to :8787)
VITE_API_URL=http://localhost:8787
VITE_MOCK=0
```

---

## 7. HTTP API (A implements)

| Method | Path | Behavior |
|---|---|---|
| GET | `/events` | SSE. `Content-Type: text/event-stream`. Each event: `id: <seq>\nevent: message\ndata: <LineaEvent JSON>\n\n`. On connect: send last **200** events from ring buffer (honor `Last-Event-ID`), then live. Heartbeat comment `: ping` every 15 s. |
| GET | `/snapshot` | `{ linea: WorldView, baseline: WorldView, clock: SimClock, metrics: {linea, baseline}, series: MetricsPoint[], watchdog: WatchdogStatus \| null, recent: LineaEvent[] /* last 100 non-tick */ }` |
| POST | `/control` | Body `ControlCmd`. Returns `{ ok: true }`. Emits `sim.control`. A handles clock/scenario cmds; forwards `budget_squeeze`, `chaos_flip`, `request_queue_report` to `agent.handleControl`. |
| GET | `/health` | `{ ok, mode, agentMode, simTime, clients }` |
| POST | `/voice/twiml` · `/voice/status` · `/voice/connect-action` · WS `/voice/relay` | Mounted by B. |

CORS open (`*`). `world.tick` is emitted at **4 Hz wall** but **not** stored in the ring buffer except the most recent one (keeps reconnect payload small). Recorder writes **all** events incl. ticks.

---

## 8. Merge checklist (3:25 PM)

1. **A alone:** `AGENT_MODE=mock npm run dev -w server` → `curl localhost:8787/health` ok; `curl -N localhost:8787/events` streams ticks; full 6-min shift completes; baseline vs linea metrics diverge.
2. **A + C:** C sets `VITE_MOCK=0`, `VITE_API_URL=http://localhost:8787`. Trucks move on the map, feed shows mock decisions, impact chart grows, hotkeys `S/M/O/B/Space/1/2/3` reach `/control`.
3. **A + B (no phones):** `AGENT_MODE=claude`, set `PHONE_*` empty → all calls simulated. Shift completes. Expect 25–60 Claude requests, cost < $2, ≥ 1 watchdog trip with `O` or `Shift+O`, escalation event emitted.
4. **Phones:** tunnel up, `PUBLIC_BASE_URL` set. Hotkey `C` at 2:57 → Carlos's phone rings, Spanish conversation, `queue.report` lands, clock at 1× during call. Trigger `O` → Ana's phone rings, she answers, trip resolves.
5. **Record:** `/control start_recording` → full shift → `stop_recording` → `MODE=replay RUN_FILE=runs/<file> npm run dev -w server` and the UI replays identically. Copy best run to `runs/demo.jsonl` and commit it.

---

## 9. Demo (2 min) — beat ↔ hotkey map

| t | Say | Do |
|---|---|---|
| 0:00 | "Nearly a million trucks crossed at Otay Mesa last year. Border delays cost this region $3.4B and 88,000 jobs (SANDAG, 2016 data)." | End-card style stat slide or just start on map |
| 0:12 | "Ana dispatches 10 trucks for a Tijuana carrier. Drivers never see a screen. Neither does she — Linea calls her when it needs her. This screen is a glass box." | Space (play) at 60× |
| 0:30 | "2:55 — CBP spikes to two hours. Watch it re-plan, citing the record." | `S` |
| 0:40 | "It calls Carlos, who's already in line." | `C` → phone on speaker. Carlos: "Estoy como a dos kilómetros, del lado mexicano." |
| 1:05 | "CBP can't see the Mexican side. Carlos just became a sensor — the plan changed for the other nine trucks." | point at dashed segment + feed |
| 1:15 | "Now the failure modes." | `O` (or `Shift+O`) → island goes red → Ana's phone rings → "Keep Pedro on Otay." |
| 1:35 | "With versus without." | `L` toggles map to baseline (trucks piled in line), back with `L` |
| 1:45 | "4.6 truck-hours saved on 10 trucks, every load on time, $1.40 in Claude spend, one human touch. 15 minutes per truck at Otay Mesa is 250,000 truck-hours a year." | `F` end card |

Backup: if anything fails live, `MODE=replay RUN_FILE=runs/demo.jsonl` and run the same script (the call audio is in the video).

---

## 10. Submission checklist
- [ ] Repo **public**, README has: one-liner, architecture diagram (§3), how to run (live / mock / replay), honest notes (scenario is a replayed weekday seeded from realistic values; LIVE badge is the real CBP feed; non-Carlos drivers simulated).
- [ ] Demo video link works logged-out.
- [ ] Every commit is after 2:00 PM today.
- [ ] Sources in README: BTS 2025 border crossing data (990,111 Otay Mesa trucks), SANDAG/Caltrans 2016 study ($3.4B, 88k jobs), CBP Border Wait Times.
