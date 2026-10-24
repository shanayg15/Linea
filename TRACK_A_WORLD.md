# Track A — World & Server

> **Paste into Claude Code:**
> "Read `SPEC.md` and `TRACK_A_WORLD.md` in full. You are building Track A only. Create the repo skeleton first (§A1) and push it within 10 minutes, then build §A2–§A9 in order. Never edit `server/src/agent/**`, `server/src/voice/**`, or `web/**`. `shared/types.ts` must match SPEC.md §4 exactly. Use TypeScript strict, Node 20, ESM. Commit after each section."

You own: `/shared`, `/server/src/world`, `/server/src/server`, `/server/src/index.ts`, `/scripts`, root config, all `package.json` files except `web/package.json`.

You are the integration hub. **Your first 10 minutes unblock everyone else.**

---

## A1. Skeleton (first 10 min — push to `main` immediately)

1. Root `package.json`:
   ```json
   { "name": "linea", "private": true, "type": "module",
     "workspaces": ["server", "web"],
     "scripts": { "dev": "npm run dev -w server", "replay": "npm run replay -w server" } }
   ```
2. `tsconfig.base.json`: `strict: true`, `target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`, `resolveJsonModule: true`, `esModuleInterop: true`, `skipLibCheck: true`.
3. `server/package.json` with all deps from SPEC §6 (install now, including `@anthropic-ai/sdk`, `twilio`, `ws` — B must never touch package.json). Scripts: `"dev": "tsx watch src/index.ts"`, `"replay": "MODE=replay tsx src/index.ts"`, `"start": "tsx src/index.ts"`.
4. `shared/types.ts` = SPEC §4 verbatim. `server/src/world/api.ts` = SPEC §4.1 verbatim.
5. Empty stubs so B compiles against them: `server/src/agent/index.ts` exporting `createAgent` that returns `{ trigger(){}, handleControl(){}, stop(){} }` and `server/src/voice/index.ts` exporting `mountVoice(){}`. **Tell B these stubs exist; B overwrites them.**
6. `.env.example` (SPEC §6), `.gitignore` (`node_modules`, `.env`, `runs/*` but `!runs/demo.jsonl`, `dist`).
7. Push `main`. Post in chat: "skeleton up".

---

## A2. Geography — `shared/geo.ts` + `scripts/build-routes.ts`

Coordinates are approximate; adjust by eye on the map if something looks off. Format `[lng, lat]`.

```ts
export const PLACES = {
  yard_nueva_tijuana: { name: 'Ciudad Industrial Nueva Tijuana', pos: [-116.955, 32.540] },
  yard_el_florido:    { name: 'Parque Industrial El Florido',    pos: [-116.862, 32.497] },
  yard_pacifico:      { name: 'Parque Industrial Pacífico',      pos: [-116.925, 32.524] },
  port_otay_mesa:     { name: 'Otay Mesa (commercial)',          pos: [-116.931, 32.551] },
  port_tecate:        { name: 'Tecate',                          pos: [-116.627, 32.576] },
  dest_otay_xdock:    { name: 'Otay Mesa cross-dock',            pos: [-116.975, 32.565] },
  dest_chula_vista:   { name: 'Chula Vista DC',                  pos: [-117.030, 32.620] },
  dest_kearny_mesa:   { name: 'Kearny Mesa medical DC',          pos: [-117.135, 32.828] },
  dest_produce:       { name: 'San Diego produce terminal',      pos: [-117.130, 32.700] },
} as const;

// The California–Baja California border is a straight line from the Pacific to the Colorado River.
export const BORDER_LINE: [number, number][] = [[-117.1240, 32.5343], [-114.7194, 32.7184]];

export const MAP_LABELS = [
  { text: 'Tijuana',   pos: [-117.02, 32.50] },
  { text: 'San Diego', pos: [-117.14, 32.74] },
  { text: 'Otay Mesa', pos: [-116.94, 32.565] },
  { text: 'Tecate',    pos: [-116.63, 32.59] },
];
```

**Routes:** `scripts/build-routes.ts` calls the public OSRM demo server once for every (origin → port) and (port → destination) pair:
`https://router.project-osrm.org/route/v1/driving/{lng1},{lat1};{lng2},{lat2}?overview=full&geometries=geojson`
Save to `shared/routes.json` as `{ "<fromKey>__<toKey>": { coords: [lng,lat][], distanceM, durationS } }`. Commit the JSON (runtime never calls OSRM). **If OSRM fails**, write 4–6 hand waypoints per pair (straight-ish lines that follow the general direction) — good enough.

**Queue paths:** for each port, `queuePath` = the last **3.0 km** of the origin→port route geometry for Otay Mesa (use the El Florido route) and last **1.5 km** for Tecate. Split each into MX part (first 70%) and US part (last 30%).

`server/src/world/geo.ts`: helpers `lengthKm(path)`, `pointAlong(path, fraction) → {pos, heading}`, `slicePath(path, fromFrac, toFrac)`, `haversineKm(a, b)`.

---

## A3. Clock — `server/src/world/clock.ts`

- Sim start `2026-10-22T13:30:00-07:00`, end `2026-10-22T19:30:00-07:00`.
- Wall tick every **250 ms**. Sim advance per tick = `speed × 0.25 s` when not paused.
- `speed` ∈ {1, 20, 60}, default from `SIM_SPEED`. `setClockSpeed(1)` during live calls stores the previous speed; `restoreClockSpeed()` restores it.
- Represent sim time internally as **epoch ms**; format ISO with `-07:00` offset for events (write a `toIsoPT(ms)` helper; don't rely on server TZ).
- At sim end: pause, set `scenarioStep: 'done'`, emit final `metrics.update`.
- Seeded RNG: implement `mulberry32(SIM_SEED)`. Use it for any jitter (truck speed ±5%). **Same seed ⇒ identical run with `AGENT_MODE=mock`.**

---

## A4. Scenario — `server/src/world/scenario.ts`

Encode SPEC §5 exactly:
- `FLEET`: the 10 trucks (map origins/destinations to `PLACES`). `phoneMode: 'live'` only for T4; everything else `'simulated'`.
- `CURVES`: `{ otay_mesa: { standard: Pt[], fast: Pt[] , mxExtra: Pt[] }, tecate: { standard: Pt[], fast: null, mxExtra: Pt[] /* all 0 */ } }` where `Pt = [ 'HH:MM', minutes ]`. Linear interpolation by sim time.
- **Spike gating:** values at/after 2:55 only apply once the spike has fired (auto at 2:55 sim, or earlier via `inject_spike`). Before firing, keep using the pre-spike interpolation (hold at 2:30→2:55 trend).
- `inject_oscillation`: for the next **12 sim-min**, override Tecate std to alternate **15 ↔ 95** every **2 sim-min** (emit `port.update` each flip). Set `scenarioStep: 'oscillation'`.
- `inject_missed_call`: set flag `missed_call_T6 = true` (B reads via `world.isScenarioFlag`).
- `TYPICAL_PROFILE` (what the optimizer believes about the future — **not** the truth): hourly Otay std `{13:40, 14:55, 15:80, 16:90, 17:80, 18:55, 19:40}`, FAST = 40% of std, Tecate std flat 25.
- `scenarioStep` values: `'calm' | 'spike' | 'oscillation' | 'normalizing' | 'done'` (normalizing after 6:30).

---

## A5. Simulator — `server/src/world/sim.ts`

Runs **two independent worlds from the same scenario**: `linea` and `baseline`. Same trucks, same truth curves.

**Truck lifecycle (both policies)**
1. `at_yard` until `readyAt`. Position = origin.
2. **Baseline:** at `readyAt` → `dispatch` to `otay_mesa`, lane `fast` if `fastEligible` else `standard`. Never holds, never reassigns.
   **Linea:** at `readyAt` → stays `at_yard` and fires `agent.trigger('truck_ready', {truckId})`. If no action arrives within **10 sim-min**, auto-dispatch with the optimizer's best option and emit `agent.decision` with `origin: 'mock'` and title `"Auto-dispatched Truck N (agent timeout)"` (safety net — should rarely happen).
3. `held` until `heldUntil` → then fire `agent.trigger('hold_expired', {truckId})`; same 10-min timeout fallback.
4. `en_route`: move along `routes[origin__port]` at `durationS × (1 ± 5% jitter)`. Update `pos` + `heading` each tick via `pointAlong`.
5. Arrive at queue tail → compute line time once, at arrival: `usMin = truthUS(port, lane, t)`, `mxMin = truthMX(port, t)`. State `in_queue_mx` for `mxMin`, then `in_queue_us` for `usMin`. Position along `queuePath`: MX portion during MX phase, US portion during US phase, `fraction = elapsed / phaseDuration`. Accumulate `minutesInLine`.
6. `crossed` → move along `routes[port__destination]`.
7. `delivered` at destination; set `deliveredAt`; on time iff `deliveredAt ≤ deadline`.

**Reassign rules (linea only):** `reassign` is legal for `held`, `at_yard`, `en_route` (re-route from current position: build path = straight segment from current pos to the nearest point on the new origin→port route, then follow it). **Not** legal once `in_queue_*` → `applyAction` returns `{ ok: false, message: 'Truck is already in line' }`.

**`applyAction(a)`** (linea only): validates, mutates, returns `{ok, message}`. Does **not** emit decisions — B emits `agent.decision`. Do emit nothing here except state changes visible in the next `world.tick`.

**Triggers to the agent** (call `agent.trigger(reason, detail)`):
- `truck_ready`, `hold_expired` (per truck)
- `port_change` when an emitted `port.update` differs from previous by ≥ **15 min**
- `queue_report` after `reportQueue()`
- `call_ended` — listen on bus for `call.ended`
- `trip_resolved` — listen for `watchdog.resolved`
- `heartbeat` every **20 sim-min**
- `request_queue_report` via `/control` → forward to `agent.handleControl`

**`reportQueue(r)`**: sets `ports[otay_mesa].mxSideExtraMin = r.extraWaitMin`, `mxSideSource = {id: 'driver:<truck>:<HH:MM>', kind: 'driver_report', label: 'Driver report · Truck 4 · ~2 km Mexican side · 2:57 PM', observedAt}`; expires after **60 sim-min** (set back to 0/null). Emit `queue.report`. Return the SourceRef.

**`sources()`**: current CBP replay SourceRefs for each port/lane (from the last `port.update`), any live `driver_report`, plus `schedule:<truckId>` for each truck's deadline (`label: "Schedule · Truck 3 due 5:30 PM"`), plus `optimizer:<truckId>` refs created by `scoreOptions`.

**Emit cadence**
- `world.tick` @ 4 Hz wall with both `WorldView`s + clock.
- `port.update` per A4 rules (source kind `cbp_replay`, id `cbp:<port>:<lane>:<HH:MM>`, label `"CBP · Otay Mesa standard · 118 min · 2:55 PM"`).
- `metrics.update` every **5 sim-min** and at end.
- `sim.control` on any clock change.

---

## A6. Optimizer — `server/src/world/optimizer.ts`

`scoreOptions(truckId)` for trucks in `at_yard | held | en_route` (others → `[]`):

Options: `go_now`, `hold_30`, `hold_60`, `hold_90`, `hold_until_1830` × ports {otay_mesa, tecate} × lanes {standard, fast (only if `fastEligible` and port = otay_mesa)}.

For each:
- `departAt` = now + hold.
- `arrive` = departAt + route duration (from current pos if en_route).
- `forecastUS` = if `arrive − now ≤ 30 min` → **current** CBP value (last `port.update`); else blend: `w = min(1, (arrive−now−30)/90)`, `forecast = (1−w)·current + w·TYPICAL_PROFILE(arrive)`.
- `knownMx` = `ports[p].mxSideExtraMin` (only from driver reports; **never** the hidden truth).
- `expectedLineMin = forecastUS + knownMx`.
- `expectedDeliveryAt = arrive + expectedLineMin + post-port route duration`.
- `lateMin = max(0, expectedDeliveryAt − deadline)`.
- `score = expectedLineMin × 1.0 + lateMin × W[priority] + (cargo==='produce' ? expectedLineMin × 2.0 : 0) + (port==='tecate' ? extraDriveMin × 0.5 : 0) + holdMin × 0.15`
  with `W = { jit: 8, perishable: 6, standard: 1 }`.
- `explanation`: `"Otay FAST · leave 3:10 PM · ~45 min line · arrives 4:05 PM (on time)"`.
- `sourceIds`: the CBP source id used + driver report id if `knownMx > 0` + `schedule:<truckId>`.

Return top **6**, sorted by `score`.

`projectFleetDelayMin()`: Σ over non-delivered linea trucks of (`minutesInLine` so far + best option's `expectedLineMin + lateMin`; for trucks already in line use remaining line time). This is the watchdog's progress metric.

---

## A7. Metrics — `server/src/world/metrics.ts`

Per policy, computed from world state each sim minute:
- `truckHoursInLine` = Σ `minutesInLine` / 60
- `deliveredOnTime`, `deliveredLate`, `deliveriesTotal = 10`
- `jitAtRisk` = jit trucks not delivered whose `etaDelivery > deadline`
- `produceMinutesInLine` = T8's `minutesInLine`
- **Linea only** (listen on bus): `costUsd` = Σ `agent.usage.costUsd` + Σ `call.ended.costUsd`; `decisions` = count of `agent.decision` with `action !== 'no_action'`; `calls` = count `call.started`; `humanTouches` = count `call.ended` where `kind === 'dispatcher' && outcome === 'completed'`.
- `metrics.update` payload `point = { t: simTime, linea: linea.truckHoursInLine, baseline: baseline.truckHoursInLine }`.
- `/snapshot.series` = all points so far.

---

## A8. Live CBP — `server/src/world/cbp.ts` (LIVE badge only; sim never uses it)

- Poll every **5 wall-min** (and once at boot). Try JSON first: `GET https://bwt.cbp.gov/api/bwtnew` — **log the response shape on first success** and find entries whose port name contains "Otay Mesa" / "Tecate" and read the commercial-vehicle standard + FAST lanes (field names are snake_case-ish in some versions, camelCase in wrappers — handle both: `commercial_vehicle_lanes.standard_lanes.delay_minutes` / `commercialVehicle.standard.delayMinutes`, `lanes_open`, `update_time`).
- Fallback (confirmed working today): `https://bwt.cbp.gov/api/bwtrss/rssbyportnum/HTML/ALL/<portNum>`. `250601` is Otay Mesa **Passenger** (commercial shows N/A there). Find the commercial crossing number by trying `250609`, `250602`–`250610` and Tecate `250501`–`250509`; keep the ones whose page says "Commercial". Parse minutes with regex.
- Emit `live.cbp` per port/lane with `ok: true|false`. Never throw; on failure emit `ok: false`. **It's Saturday — commercial lanes may be closed/N/A; that's fine, UI shows it honestly.**

---

## A9. Bus, HTTP, recorder, replay, mock agent

**`server/src/server/bus.ts`**: `EventEmitter`-based `EventBus` per §4.1. `emit()` stamps `id` (ulid), `seq` (++), `simTime` (clock), `wallTime`. Ring buffer **3000**; `world.tick` stored only as "latest tick" (not in ring). Recorder subscribes.

**`server/src/server/http.ts`**: Express + CORS + JSON. Routes per SPEC §7. SSE: keep a `Set<Response>`; write every event; on connect send latest tick + last 200 ring events with `seq > Last-Event-ID`. `res.flushHeaders()`, disable compression.

**`server/src/server/recorder.ts`**: on `start_recording` open `runs/<YYYYMMDD-HHmmss>.jsonl`, append every event as one JSON line with `wallMs` (ms since recording start). `stop_recording` closes.

**`server/src/server/replay.ts`** (`MODE=replay`): load `RUN_FILE`, emit events through the bus preserving original `wallMs` gaps (scaled by a replay speed, default 1; `speed` cmd 20/60 maps to ×1/×3/×6 replay speed is fine), `pause/play` supported, `reset` restarts from line 1. No sim, no agent, no voice in replay mode.

**`server/src/world/mockAgent.ts`** (`AGENT_MODE=mock`): on each trigger, for the affected truck(s) take `scoreOptions()[0]`, call `applyAction`, emit `agent.decision` with `origin: 'mock'`, title like `"Holding Truck 9 at the yard until 6:30 PM"`, `reasoning = option.explanation`, `sources` resolved from `sourceIds`, `costUsd: 0`, `model: 'mock'`. On `port_change`, re-score all `at_yard|held|en_route` trucks and reassign only if the new best beats current by ≥ 20 score. Also emit a `watchdog.status` every 10 sim-min with all `ok` so the UI has data. This lets C and the merge proceed even if Claude is down.

**`server/src/index.ts`**: load env (`dotenv/config`), build bus → clock → scenario → sim → metrics → cbp → http server; wire agent per SPEC §4.1; `app.listen(PORT)` via `http.createServer(app)` (B needs the `http.Server` for the WS upgrade). Log a banner: mode, agent mode, PORT, PUBLIC_BASE_URL.

---

## A10. Definition of done (by 3:25)

- [ ] `AGENT_MODE=mock npm run dev` runs a full shift in ~6 min at 60×; no crashes.
- [ ] Baseline ends with ~7/10 on time and ≥ 4 more truck-hours in line than linea-mock (tune `W`, hold penalty, curves if not).
- [ ] `S`, `O`, `M`, `B`, `C`, `pause`, `play`, `speed`, `reset` all work via `curl -XPOST localhost:8787/control -H 'content-type: application/json' -d '{"cmd":"inject_spike"}'`.
- [ ] Recording + replay round-trip works.
- [ ] `live.cbp` emits (ok true or false).
- [ ] Post a 60-second recorded mock run to `fixtures/` as `fixtures/server-sample.jsonl` for C.

## A11. After merge (3:55–5:15)
- Tune the scenario so the demo numbers land (SPEC §5 "Expected outcome").
- Make sure the agent-timeout fallback never fires during a Claude run (if it does, tell B).
- Produce `runs/demo.jsonl` from the best full rehearsal.
