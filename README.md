# Linea

**An autonomous AI dispatcher for cross-border trucking.** Linea runs a small Tijuana carrier's afternoon shift through the Otay Mesa commercial port on its own. It reads live border-wait data and decides truck by truck whether to go now, take the FAST lane, divert to Tecate or wait at the yard. It talks to drivers only by phone, and calls the human dispatcher only when it actually needs her.

Built in one afternoon at **c0mpiled-16 (UCSD)** for the **Dispatch** track.

> Nearly a million trucks a year (990,111 in 2025) cross north through Otay Mesa, California's busiest commercial port. Waits swing from thirty minutes to six hours, and border delays cost the San Diego–Baja region **$3.4 billion and 88,000 jobs** in a single year. A dispatcher's tools today are a government website and texting drivers who are driving.

---

## What it does

- **Decides with Claude.** Claude Sonnet makes every dispatch decision through tool calls (dispatch, hold, reassign, call a driver, escalate). It is triggered by trucks becoming ready, border-wait changes, driver reports, finished calls and a heartbeat. Every decision cites the exact records it used.
- **Talks by phone, in Spanish.** Drivers never see a screen. Linea phones them through Twilio, with Claude Haiku on the line. It identifies itself as an AI, either asks a single question or gives the dispatcher's instruction with the reason, and hangs up.
- **Turns drivers into sensors.** CBP only measures the US-side queue. A driver already in line reports the Mexican-side queue ("como a dos kilómetros, del lado mexicano"), and the whole fleet is re-planned around data no feed has.
- **Guards itself.** A watchdog gates every action: budget caps with model degradation, idempotency, loop and oscillation detection, repeated calls, unanswered drivers, no-progress detection, and cite-or-block. It batches what needs human judgment into one phone call to Ana, the dispatcher.
- **Shows its work.** The glass-box dashboard shows the map, the live call with translation, every decision and gate verdict, and a with-vs-without impact card. Nobody using Linea needs it; it's there so judges can watch it think.
- **Lights Ana's desk.** An ESP32-S3 beacon sits on Ana's desk: breathing green while Linea has it, white while re-planning, red when her phone is about to ring, three green flashes once she decides.

## How it works

```
                 ┌────────────────────────── server (Node 20 · TypeScript · Express · :8787) ──────────────────────────┐
 CBP live feed ─▶│ world/cbp.ts ─────────────▶ live.cbp (LIVE badge)                                                   │
                 │ world/sim.ts   seeded 4 Hz simulator, two worlds from one scenario: LINEA vs BASELINE               │
                 │ world/optimizer.ts  scores go/hold × port × lane from CBP + driver reports (never the hidden truth) │
                 │        │ triggers: truck_ready · port_change · queue_report · hold_expired · call_ended · heartbeat │
                 │        ▼                                                                                            │
                 │ agent/dispatcher.ts ── Claude Sonnet (tools) ──▶ agent/watchdog.ts (gate) ──▶ world.applyAction()  │
                 │        │ call_driver / escalate                                                                     │
                 │        ▼                                                                                            │
 Twilio  ◀── REST│ voice/  gather.ts: <Gather> speech ⇄ Claude Haiku (free-tier)  ·  relay.ts: ConversationRelay      │
 phones  ──────▶ │         /voice/twiml · /voice/gather · /voice/status · WS /voice/relay                             │
                 │ server/bus.ts  event bus + ring buffer + JSONL recorder  ·  http.ts  /events (SSE) /snapshot /control│
                 └──────────────────────────────────────┬───────────────────────────────────────┬─────────────────────┘
                                                        │ SSE                                   │ SSE
                                       web/ (Vite · React · MapLibre · deck.gl)     hardware/bridge.ts ──USB──▶ ESP32 beacon
```

Everything the dashboard and the beacon show comes from one typed event stream ([`shared/types.ts`](shared/types.ts)). The same stream is recorded to JSONL and can be replayed with its original timing, so the demo also works with no Wi-Fi.

## Quick start

Requirements: Node 20+ and npm.

```bash
npm install
cp .env.example .env
```

**1. Mock mode: no API keys, deterministic.** A rule-based agent stands in for Claude, and calls are simulated with transcripts.

```bash
npm run mock        # server on :8787
npm run web         # dashboard on http://localhost:5173
```

**2. Claude mode.** Set `ANTHROPIC_API_KEY` in `.env`, then:

```bash
npm start
npm run web
```

**3. Live phone calls.** Fill the `TWILIO_*` and `PHONE_*` values, expose port 8787 publicly and set `PUBLIC_BASE_URL` to that address. Restart the server after changing `.env`.

```bash
npx localtunnel --port 8787         # or: cloudflared tunnel --url http://localhost:8787
```

Twilio trial accounts work: the default `VOICE_TRANSPORT=gather` uses Twilio speech recognition and `<Say>` instead of ConversationRelay, which needs a paid account. Trial calls play a short Twilio message first; press any key.

**4. Replay a recorded run.**

```bash
curl -XPOST localhost:8787/control -H 'content-type: application/json' -d '{"cmd":"start_recording"}'
# ...run the shift...
curl -XPOST localhost:8787/control -H 'content-type: application/json' -d '{"cmd":"stop_recording"}'
MODE=replay RUN_FILE=runs/demo.jsonl npm start
```

**5. Desk beacon** (optional): see [`hardware/README.md`](hardware/README.md).

```bash
cd hardware && npm install && npm start
```

## Demo controls

The dashboard's hotkeys drive the scenario through `POST /control`.

| Key | Action |
|---|---|
| <kbd>Space</kbd> | Play / pause |
| <kbd>S</kbd> | Fire the Otay Mesa spike (35 → 118 min) |
| <kbd>C</kbd> | Call the driver already in the Otay line for a Mexican-side queue report |
| <kbd>Shift</kbd>+<kbd>O</kbd> | Chaos test: Tecate's feed flaps, a truck flips ports, the watchdog blocks the third flip and calls Ana |
| <kbd>O</kbd> | Tecate feed flaps 15 ↔ 95 min only |
| <kbd>M</kbd> | Next Truck 6 call goes unanswered (no-answer trip) |
| <kbd>B</kbd> | Squeeze the budget (model degrades, non-priority calls blocked) |
| <kbd>L</kbd> | Toggle with / without Linea |
| <kbd>F</kbd> | End card |
| <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> | Speed 1× / 20× / 60× |
| <kbd>Shift</kbd>+<kbd>R</kbd> | Reset to 1:30 PM |

The full two-minute walkthrough is in [`docs/DEMO.md`](docs/DEMO.md).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MODE` | `live` | `live` runs the simulator; `replay` streams `RUN_FILE` |
| `AGENT_MODE` | `claude` | `claude` or `mock` (no API calls) |
| `SIM_SPEED` / `SIM_SEED` | `60` / `1022` | Sim seconds per wall second; RNG seed (same seed gives the same mock run) |
| `START_PAUSED` | unset | `1` boots and resets with the clock paused |
| `MODEL_DISPATCH` / `MODEL_VOICE` | `claude-sonnet-5-5` / `claude-haiku-5-5` | Models for dispatch and phone calls |
| `BUDGET_CAP_USD` | `3.00` | Watchdog spend cap per shift |
| `VOICE_TRANSPORT` | `gather` | `gather` (works on Twilio trial) or `relay` (ConversationRelay) |
| `DRIVER_LANGUAGE` | `es-MX` | Language of live driver calls (`es-MX` or `en-US`) |
| `LIVE_DRIVER_CALLS` | `request` | `request`: only hotkey C rings the real driver phone; `all`: the agent's own calls ring too |
| `PHONE_T4_CARLOS` / `PHONE_DISPATCHER_ANA` | | Real phones for Carlos (Truck 4) and Ana; empty means simulated |
| `PUBLIC_BASE_URL` | | Public HTTPS address of port 8787, for Twilio webhooks |

## Repository layout

```
shared/        Event contract (types.ts), places and OSRM road routes
server/src/
  world/       Simulator, scenario, optimizer, metrics, live CBP poller, mock agent
  agent/       Claude dispatcher, tools, watchdog, cost meter, chaos test
  voice/       Twilio calls: <Gather> speech loop, ConversationRelay, simulated calls, translation
  server/      Event bus, HTTP + SSE, recorder, replay
web/           Glass-box dashboard (React, MapLibre, deck.gl, Framer Motion)
hardware/      ESP32-S3 desk beacon firmware and event bridge
fixtures/      Recorded event streams for UI development
docs/          Spec, per-track build docs, demo walkthrough
```

## About the scenario

- **The afternoon is a replay.** It's Thursday, October 22, 1:30–7:30 PM, a weekday seeded with realistic Otay Mesa and Tecate wait curves. CBP publishes hourly; the simulator compresses time (60×, so a shift takes six minutes).
- **The LIVE badge is real.** It shows the current CBP Border Wait Times feed for the Otay Mesa and Tecate commercial crossings.
- **Two people are real.** Carlos (Truck 4) and Ana are live phone calls. The other nine drivers get simulated calls, shown with transcripts.
- **The comparison is fair.** Both worlds run from the same scenario and the same randomness. The baseline sends every truck to Otay Mesa the moment it's loaded and never adapts. In the deterministic mock run (seed 1022) Linea delivers 10/10 on time against the baseline's 7/10, with produce spending 25 minutes in line instead of three hours.

## Team

| Track | Owner |
|---|---|
| A · World, simulator, server | Shanay Gaitonde |
| B · Claude agent, watchdog, voice | Aayan Singh |
| C · Dashboard | Akshith Vattem |
| D · Desk beacon hardware | Paresh Prabhu Raj |

## Sources

- U.S. Bureau of Transportation Statistics, Border Crossing Entry Data, 2025: 990,111 incoming trucks at Otay Mesa.
- SANDAG / Caltrans border wait-time economic impact study (2016 data): $3.4B in lost output and 88,000 jobs.
- U.S. Customs and Border Protection, Border Wait Times ([bwt.cbp.gov](https://bwt.cbp.gov)).

## License

[MIT](LICENSE)
