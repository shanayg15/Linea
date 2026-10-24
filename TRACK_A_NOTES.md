# Track A notes for B and C

Everything in `shared/types.ts` and `server/src/world/api.ts` is unchanged from SPEC §4 and §4.1. These are the behaviors that aren't obvious from the types.

## Running

```bash
npm install
AGENT_MODE=mock npm run dev                                # sim + rule-based mock agent, no API calls
npm run dev                                                # AGENT_MODE=claude (B's agent + voice)
MODE=replay RUN_FILE=runs/demo.jsonl npm run start         # replay a recording
```

- `.env` is read from the repo root (see `.env.example`).
- `START_PAUSED=1` boots, and resets, with the clock paused, so the presenter can press Space to play.

## For B (agent + voice)

- `index.ts` dynamically imports `./agent/index` and `./voice/index`.
  - If `createAgent()` throws, the server logs the error and falls back to the mock agent, so the demo never dies.
  - If `mountVoice()` throws, the server logs it and continues without voice.
- `express.json()` and `express.urlencoded()` are mounted globally before `mountVoice`, so Twilio form posts are already parsed. CORS is open.
- `agent.handleControl` receives `budget_squeeze`, `chaos_flip` and `request_queue_report`, as in the spec, plus `reset` (wrapped in try/catch, so it's safe to ignore).
- Triggers are fired after each sim step, never mid-step. `trigger()` is wrapped in try/catch. Reasons:
  - `truck_ready`, `hold_expired` (with `{truckId}`)
  - `port_change` (with `{portId, lane, waitMin, prevWaitMin, sourceId}`)
  - `queue_report`, `call_ended`, `trip_resolved`
  - `heartbeat` (every 20 sim-min)
- **Timeout fallback:** if a linea truck sits `at_yard` (ready) for 10 sim-min with no action, the sim applies `scoreOptions()[0]` itself. It then emits `agent.decision` with `origin:'mock'` and `model:'fallback'`. If you see this during a Claude run, the agent is too slow or ignored the truck.
- **`applyAction` validation messages** (useful for the watchdog):
  - `Truck is already in line`
  - `Truck already crossed`
  - `Truck already left the yard`: hold or dispatch on a moving truck
  - `Truck N is not loaded until 3:10 PM`: dispatch before `readyAt`
  - `Tecate has no FAST lane`
  - `Truck N is not FAST-eligible`
  - `Hold time is in the past`
  - `No change`: a reassign to the same port and lane, returned with `ok:true`
- `reassign` works on `at_yard`, `held` and `en_route`. On a yard truck it only changes the planned port and lane; it doesn't dispatch.
- `scoreOptions(id)` returns the top 6, best first, for `at_yard`, `held` and `en_route` trucks.
  - A truck that isn't loaded yet gets `departAt = max(now + hold, readyAt)`.
  - En-route trucks only get `go_now` options, scored from their current position.
  - No hold may depart after 6:30 PM.
- `sources()` ids look like these:
  - `cbp:otay_mesa:standard:14:55`
  - `driver:T4:14:57`
  - `schedule:T3`
  - `optimizer:T3`, which only exists after `scoreOptions('T3')` has been called
- `reportQueue({portId, lengthKm, extraWaitMin, reportedBy})`:
  - `reportedBy` should contain the truck id, e.g. `'T4'` or `'Carlos (T4)'`.
  - It sets linea's MX-side extra for 60 sim-min, emits `queue.report`, and fires `queue_report`.
- `setClockSpeed(1)` / `restoreClockSpeed()` emit `sim.control`.
- Oscillation (`inject_oscillation`) flaps the **reported** Tecate CBP value 15↔95 every 2 sim-min for 12 sim-min, with a `port.update` and a `port_change` on every flip. The actual Tecate line time is not affected; it's a data glitch.

## For C (UI)

- **SSE** (`GET /events`):
  - On connect you get `retry: 2000`, then up to 200 ring events newer than `Last-Event-ID`, then the latest `world.tick`.
  - `world.tick` arrives at 4 Hz, including while paused.
- `GET /snapshot` fields are `null` until the first tick or metrics event. `series` is cumulative truck-hours in line, one point every 5 sim-min.
- On `reset`, a `sim.control` event with `note: 'reset'` arrives, the ring buffer is cleared, and the sim time jumps back to 1:30 PM. Clear the feed when you see it.
- `sim.control.note` is also used for:
  - scenario changes: `scenario: spike`, `scenario: oscillation`, …
  - speed changes during a live call: `clock 1× (live call)`, `clock restored to 60×`
  - recording: `recording → <file>`, `recording stopped`
  - end of shift: `shift complete`
- In replay mode, `clock.mode` is `'replay'` on every tick and `sim.control`.
- `PortStatus.queuePath` has about 32 points and ends at the port. In MX-side line, trucks sit on the first 70% of it; in US-side line, on the last 30%.
- The mock agent scripts the demo beats with `mode:'simulated'` calls:
  - the driver-as-sensor call on the spike
  - T6 no-answer ×2, then a `watchdog.trip` of kind `no_answer`
  - the oscillation guard: the 3rd flip is blocked, followed by a trip, an escalation, a call to Ana and `watchdog.resolved`
  - a budget trip on `budget_squeeze`
- `fixtures/server-sample.jsonl` is about 60 s of a real recorded mock run (2:45–3:45 PM sim: spike, Carlos call, missed call, oscillation, escalation, budget). Each line is a `LineaEvent` plus a `wallMs` field.
