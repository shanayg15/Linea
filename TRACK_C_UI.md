# Track C — UI (Apple-grade glass box)

> **Paste into Claude Code:**
> "Read `SPEC.md` and `TRACK_C_UI.md` in full. You are building Track C only: everything in `/web` plus `fixtures/mock-events.jsonl`. Never edit other directories. Build with Vite + React 18 + TypeScript + Tailwind 3 + maplibre-gl + deck.gl + framer-motion + zustand + lucide-react + d3-shape. Import types from `../shared/types.ts` (alias `@shared`). The UI must look like Apple designed it: dark mode system colors, SF Pro, frosted glass over a full-bleed map, spring motion, no gradients, no neon, no purple, no emoji. Build §C1→§C12 in order; make every panel work against the mock stream first."

You own `/web` and `fixtures/mock-events.jsonl`. You never need the server to make progress.

**Design north star:** Apple Maps (full-bleed map, floating glass cards) + Stocks (numbers, one clean line chart) + Dynamic Island (status that springs open on alerts) + iOS Live Activities (the call card). Everything readable on a projector from the back of the room.

---

## C1. Scaffold

- `npm create vite@latest web -- --template react-ts`, then install deps (SPEC §6). Tailwind 3 with `content: ['./index.html','./src/**/*.{ts,tsx}']`.
- `vite.config.ts`: `resolve.alias: { '@shared': path.resolve(__dirname, '../shared') }`; `server.port 5173`.
- `index.html`: `<html class="dark">`, `<body class="bg-black">`, title `Linea`. Load Inter from Google Fonts as fallback only: `https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap`.
- Import `maplibre-gl/dist/maplibre-gl.css`.
- Viewport target: **1920×1080** (projector) and **1440×900** (laptop). Must look perfect at both. No page scroll, `overflow: hidden`.

---

## C2. Design tokens — `src/styles/tokens.css`

```css
:root {
  --bg: #000000;
  --elevated: #1C1C1E;
  --elevated-2: #2C2C2E;
  --fill-segment: rgba(118,118,128,0.24);
  --thumb: #636366;
  --separator: rgba(84,84,88,0.6);
  --hairline: rgba(255,255,255,0.08);

  --label: #FFFFFF;
  --label-2: rgba(235,235,245,0.60);
  --label-3: rgba(235,235,245,0.30);

  --blue:   #0A84FF;  /* en route, "With Linea" line */
  --orange: #FF9F0A;  /* held at yard */
  --yellow: #FFD60A;  /* in line */
  --green:  #30D158;  /* crossed / on time / "saved" area */
  --gray:   #8E8E93;  /* at yard, baseline line */
  --red:    #FF453A;  /* WATCHDOG TRIPS ONLY — nowhere else */

  --glass-bg: rgba(28,28,30,0.72);
  --glass-blur: blur(30px) saturate(180%);
  --glass-border: 1px solid rgba(255,255,255,0.08);
  --glass-shadow: 0 8px 32px rgba(0,0,0,0.40);

  --r-panel: 18px;  --r-row: 12px;  --r-pill: 999px;
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", Inter, system-ui, sans-serif;
}
* { font-family: var(--font); -webkit-font-smoothing: antialiased; }
.num { font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.glass { background: var(--glass-bg); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
         border: var(--glass-border); box-shadow: var(--glass-shadow); border-radius: var(--r-panel); }
```
Add a `?projector=1` URL flag that sets `--glass-bg: rgba(28,28,30,0.88)` (blur washes out on cheap projectors).

**Type scale (only two weights: 400, 600):**
| Token | Size/Line | Weight | Use |
|---|---|---|---|
| display | 48/52 | 600 | Impact hero number |
| title1 | 34/40 | 600 | Impact strip numbers |
| title3 | 20/25 | 600 | Card headers |
| headline | 17/22 | 600 | Section titles, names |
| body | 15/20 | 400/600 | Row titles (600), transcript (400) |
| footnote | 13/18 | 400 | Secondary lines, labels |
| caption | 11/13 | 600 | Pills, axis ticks (minimum size on screen; never smaller) |

**Spacing:** 4, 8, 12, 16, 20, 24, 32. Panel padding 16 (rows) / 20 (cards). Screen inset **24px** everywhere.

**Motion (framer-motion):** default `transition = { type: 'spring', stiffness: 300, damping: 30 }`. Number counters: `useSpring(value, { stiffness: 120, damping: 20 })`. New list rows: `initial {opacity:0, y:-8}` → `animate {opacity:1, y:0}`. Respect `prefers-reduced-motion`.

**Copy rules:** sentence case. "Holding Truck 9 at the yard until 6:30 PM". Times `h:mm PM`. Money `$1.42`. Durations `2 h 41 min` / `22 min`. Never ALL CAPS.

**Banned:** gradients (except the single 12% green area fill), glows, purple, emoji, drop shadows other than `--glass-shadow`, borders thicker than 1px, more than one accent color per element.

---

## C3. Data layer — `src/data/`

**`store.ts` (zustand):**
```ts
interface UiState {
  clock: SimClock | null;
  linea: WorldView | null; baseline: WorldView | null;
  prevTick: { at: number; linea: WorldView; baseline: WorldView } | null; // for interpolation
  lastTickAt: number;
  ports: PortStatus[];
  live: Record<string, PayloadOf<'live.cbp'>>;           // key `${portId}:${lane}`
  feed: FeedItem[];                                       // newest first, max 60
  calls: Record<string, CallState>; activeCallId: string | null;
  watchdog: WatchdogStatus | null;
  activeTrip: PayloadOf<'watchdog.trip'> | null;          // drives the Island alert
  metrics: { linea: Metrics; baseline: Metrics } | null;
  series: MetricsPoint[];
  queueReports: PayloadOf<'queue.report'>[];
  policyView: 'linea' | 'baseline';                       // segmented control
  endCard: boolean; debug: boolean;
  ingest(e: LineaEvent): void;
}
type FeedItem =
  | { kind: 'decision'; e: PayloadOf<'agent.decision'>; simTime: string }
  | { kind: 'blocked';  e: PayloadOf<'tool.gate'>;      simTime: string }
  | { kind: 'trip';     e: PayloadOf<'watchdog.trip'>;  simTime: string }
  | { kind: 'call';     e: PayloadOf<'call.ended'> & { personName: string; truckId: string|null; mode: 'live'|'simulated' }; simTime: string }
  | { kind: 'report';   e: PayloadOf<'queue.report'>;   simTime: string }
  | { kind: 'resolved'; e: PayloadOf<'watchdog.resolved'>; simTime: string };
interface CallState { started: PayloadOf<'call.started'>; status: string; startedAtWall: number;
  utterances: { id: string; speaker: 'linea'|'human'; text: string; textEnglish: string|null }[];
  tools: { tool: string; result: string }[]; ended?: PayloadOf<'call.ended'>; lastSpeaker: 'linea'|'human'|null; lastSpeechAt: number; }
```
`ingest` rules: `world.tick` → shift current to `prevTick`, set new; `agent.decision` (skip `no_action`) / `tool.gate` with verdict `blocked` / `watchdog.trip` / `call.ended` / `queue.report` / `watchdog.resolved` → prepend to `feed`; `call.transcript` → upsert utterance by `utteranceId` (translations arrive as a second event with the same id); `watchdog.trip` → `activeTrip` (clear on `watchdog.resolved` for that trip, or after 12 s if no resolution); `metrics.update` → metrics + append `point` to `series` (dedupe by `t`); `call.ended` → keep the card visible 4 s then `activeCallId = null`.

**`stream.ts`:** `useLineaStream()`:
- If `import.meta.env.VITE_MOCK === '1'` → fetch `/fixtures/mock-events.jsonl` (copy into `web/public/fixtures/` via a vite `publicDir` symlink or copy script), replay with original `wallMs` gaps; support pause/speed locally.
- Else `new EventSource(`${VITE_API_URL}/events`)`, `onmessage → store.ingest(JSON.parse(data))`; on error, auto-reconnect (EventSource does this); on open, `GET /snapshot` to hydrate.
- `control(cmd: ControlCmd)` → `POST ${VITE_API_URL}/control`.

**Interpolation (critical for "Apple smooth"):** ticks arrive at 4 Hz. In the map's `requestAnimationFrame` loop compute `α = clamp((now − lastTickAt) / 250, 0, 1)` and lerp each truck's `pos` between `prevTick` and current (match by id). Heading: shortest-angle lerp.

---

## C4. Mock stream — `fixtures/mock-events.jsonl` (+ `web/scripts/make-mock.ts`)

Write `make-mock.ts` (run with `npx tsx`) that generates a ~3-minute story following SPEC §5 beats using the real types: 10 trucks moving along simple lines between the `PLACES` in `shared/geo.ts` (if A hasn't pushed it yet, copy the `PLACES`/`BORDER_LINE`/`MAP_LABELS` block from TRACK_A_WORLD.md §A2 into a local file and switch the import later), `world.tick` at 4 Hz for both policies (baseline trucks pile into Otay after 2:55; linea holds T9/T10, sends T8 to Tecate), `port.update` spike at 2:55, a T4 `call.started` (mode `live`) with 4 Spanish `call.transcript` utterances + translations + `call.tool report_queue_position`, `queue.report`, 6–10 `agent.decision`s with real-looking titles and sources, a T6 no-answer ×2, an oscillation `tool.gate` blocked + `watchdog.trip`, an `escalation` + Ana call (English) + `watchdog.resolved`, `metrics.update` every 5 sim-min with baseline growing faster, `watchdog.status` updates, and a `live.cbp` event. Each line: `{...LineaEvent, wallMs}`. Replace with A's `fixtures/server-sample.jsonl` / `runs/demo.jsonl` once available.

---

## C5. Layout — `src/App.tsx`

All panels are `position: absolute` over the full-bleed map. Inset 24px.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Status Island]            [ With Linea | Without ]           [Impact strip] │  top: 24
│ [LIVE CBP pill]                                                              │  top: 24+44+8
│                                                                ┌───────────┐ │
│                         MAP (full bleed)                       │ Activity  │ │  right: 24, w: 380
│                                                                │ feed      │ │  top: 24+88+16
│                                                                │           │ │  bottom: 24
│ ┌────────────────┐  ┌───────────────────────────────┐          │           │ │
│ │ Live call card │  │ Impact card (with vs without) │          │           │ │
│ └────────────────┘  └───────────────────────────────┘          └───────────┘ │  bottom: 24
└──────────────────────────────────────────────────────────────────────────────┘
```
- Status Island: top-left, `left 24, top 24`.
- Segmented control: centered horizontally in the space left of the activity feed, `top 28`.
- Impact strip: `right 24, top 24`, width = 380 + 24 + (as needed) — it may span wider than the feed; 4 stats.
- Activity feed: `right 24`, `top 24 + stripHeight + 16`, `bottom 24`, `width 380`.
- Live call card: `left 24, bottom 24, width 380`.
- Impact card: `left 24 + 380 + 16, bottom 24, width 560, height 248`. At 1440 width: width 480.
- Map legend: tiny row above the call card (only when no call active), footnote size: ● En route ● Held ● In line ● Crossed.

---

## C6. Map — `src/map/MapCanvas.tsx`

- MapLibre style: `https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json`. After load, desaturate: set `background` to `#0B0C0E`, water fill `#0A0D12`, road line colors to `rgba(255,255,255,0.10)` (major) / `0.05` (minor) by iterating `map.getStyle().layers` and patching `paint` where layer id includes `road`/`water`/`background`. Hide any remaining symbol layers.
- Initial view: `center [-116.93, 32.63]`, `zoom 10.3`, `pitch 35`, `bearing -12`. `interactive: true` but no controls visible. On load, a 1.6 s `flyTo` from zoom 9.6 → 10.3 (the "Apple Maps arrival").
- deck.gl via `MapboxOverlay` from `@deck.gl/mapbox` with `interleaved: true`.

**Layers (bottom → top):**
1. **Border** — `PathLayer` on `BORDER_LINE`, color `[255,255,255,77]` (30%), `widthMinPixels 1`, dashed (`PathStyleExtension({dash:true})`, `getDashArray [6,4]`).
2. **Routes (subtle)** — `PathLayer` of each active truck's current route, `[255,255,255,20]`, width 2.
3. **Queue** — for each port: `PathLayer` along `queuePath`, width 6, rounded caps, color `--yellow` at alpha scaled by wait (`min(1, waitMin/120)` → 80–230). Draw the US portion solid; the **driver-reported MX portion** (if `mxSideExtraMin > 0`) as a **dashed** yellow segment.
4. **Queue pulse** — `ScatterplotLayer` at each port, radius pixels `8 + waitMin/6`, fill yellow alpha 40, animated: alpha `40 + 25·sin(t·2π/1.6s)`. Stroke none.
5. **Trails** — `TripsLayer` per truck: path = last positions buffer (append interpolated pos every 250 ms, keep 40 points), `getTimestamps` = wall ms, `currentTime` = now, `trailLength 8000`, `widthMinPixels 3`, `capRounded`, `jointRounded`, color = state color, `fadeTrail: true`.
6. **Trucks** — `ScatterplotLayer`, `radiusMinPixels 6`, `stroked true`, `lineWidthMinPixels 2`, line color `[0,0,0,255]`, fill = state color. State colors: `at_yard` gray, `held` orange, `en_route` blue, `in_queue_mx` / `in_queue_us` yellow, `crossed` green, `delivered` green alpha 90. Transition fill color with `transitions: { getFillColor: 400 }`.
7. **Selected/active truck ring** — when a call is active for truck X, `ScatterplotLayer` ring around it, white alpha 200, radius 14, pulsing.
8. **Oscillation flash** — when `activeTrip.kind === 'oscillation'`, draw the flip path for that truck (Otay ↔ Tecate route segments) in `--red` for 3 s, flashing twice.
9. **Labels** — `TextLayer` with `MAP_LABELS`, font `var(--font)` (`fontFamily: '-apple-system, Inter'`), size 13, color `rgba(235,235,245,0.6)`, `fontWeight 600`. Port labels show live wait: "Otay Mesa · 118 min" (from linea view ports, standard lane).

**Callout for driver report** — HTML marker (absolute div projected with `map.project`) at the start of the dashed MX segment: glass pill, caption size: `"~2 km · reported by Truck 4 · 2:57 PM"`, appears with spring scale 0.9→1.

**Policy toggle:** when `policyView === 'baseline'`, render trucks/queues from `baseline` view; all other layers identical. Cross-fade the truck layer opacity 0→1 over 300 ms on switch.

---

## C7. Status Island — `src/ui/StatusIsland.tsx` (signature moment)

A single `motion.div` with `layout` + spring (`stiffness 400, damping 32`), black-ish glass (`background: rgba(0,0,0,0.85)`, same blur/border), radius 999 at rest / 28 when expanded.

- **Rest (≈ 320×44):** left: wordmark "Linea" (headline 600) · separator dot · `Thu 2:58 PM` (`.num`, footnote, label-2) · `60×` (caption, label-3). Right: three 6px dots for budget / loops / progress, colored by `WatchdogState` (`ok` green, `warn` orange, `tripped` red). Hover/tap (debug) shows a tooltip with the numbers.
- **Thinking (≈ 360×44):** when an `agent.thinking` or decision arrived < 1.2 s ago, replace the time with a subtle text "Re-planning" + a 3-dot shimmer (opacity only, no color).
- **Baseline view:** text becomes "Without Linea · simulated" (label-2).
- **Alert (≈ 560×104):** when `activeTrip` is set, the island **springs open**: background `rgba(255,69,58,0.16)` over the black glass, border `rgba(255,69,58,0.5)`. Row 1: `ShieldAlert` icon (red, 18px) + title (headline, white): "Loop detected". Row 2 (footnote, label-2): `"Truck 7 reassigned 3× in 6 min · Blocked · Calling Ana"`. Right side: `"Watchdog"` caption pill. Collapse back with the same spring on resolve: briefly flash green border + "Resolved by Ana" for 1.5 s, then rest.
- Titles per trip kind: `oscillation` "Loop detected", `no_answer` "Driver not answering", `budget` "Budget guard", `no_progress` "No progress — paused", `repeat_call` "Repeat call blocked", `repeat_tool` "Repeated action blocked", `uncited` "Uncited action blocked", `not_worth_it` "Call not worth it".

**LIVE CBP pill** (below island, footnote): green 6px pulsing dot + "Live · CBP Otay Mesa commercial · 42 min · updated 1:00 PM". If `ok:false` or null wait: gray dot + "CBP commercial lanes closed today" (it's Saturday). Never red.

---

## C8. Segmented control — `src/ui/PolicyToggle.tsx`

iOS segmented control: 260×36, background `--fill-segment`, radius 9, padding 2. Thumb: `--thumb`, radius 7, shadow `0 3px 8px rgba(0,0,0,0.12), 0 3px 1px rgba(0,0,0,0.04)`, moves with `layoutId="seg-thumb"` spring. Labels: body 600 13px, white. Options "With Linea" / "Without". Hotkey `L`.

---

## C9. Impact strip — `src/ui/ImpactStrip.tsx`

One glass bar, height 88, 4 equal columns with 1px `--separator` dividers, padding 16/20. Each column: label (footnote, label-2) on top, value (title1 `.num`) below, optional sub (footnote, label-3) to the right of value.
1. **Truck-hours saved** — `baseline.truckHoursInLine − linea.truckHoursInLine`, 1 decimal. Value colored `--green` once > 0.5.
2. **On time** — `linea.deliveredOnTime + (undelivered not at risk)` shown as `10/10`; sub `vs 7 without`.
3. **Claude spend** — `$1.42`; sub `$0.14 per load`.
4. **Human touches** — `1`; sub `52 decisions`.
Numbers animate with `useSpring`. In baseline view the strip stays on linea numbers (it's the comparison).

---

## C10. Activity feed — `src/ui/ActivityFeed.tsx`

Glass panel. Header (padding 20/16): "Activity" (title3) + right-aligned footnote label-3 `"52 decisions"`. Body: scrollable list (hide scrollbar), rows newest first, `AnimatePresence` for inserts.

**Row (min-height 64, padding 12/16, radius 12, hover bg `rgba(255,255,255,0.04)`):**
- Left: 32px circle, background = accent at 16% alpha, lucide icon 16px in accent:
  - hold → `PauseCircle` orange · dispatch → `Truck` blue · reassign → `ArrowLeftRight` blue · FAST lane (detail contains "FAST") → `Zap` blue · call_driver / call ended → `Phone` green · escalate → `UserRound` orange · queue.report → `Radio` yellow · blocked/trip → `ShieldAlert` (orange for blocked, red for trip) · resolved → `CheckCircle2` green.
- Middle: title (body 600, white, 1 line ellipsis). Second line (footnote, label-2, 1 line): primary source label · `2:57 PM` (e.g. `CBP · Otay Mesa standard · 118 min · 2:57 PM`).
- Right: cost (footnote `.num`, label-3) e.g. `$0.03`; for blocked rows a caption pill "Watchdog" (bg `rgba(255,159,10,0.16)`, text orange).
- Click → expands (spring height) to show `reasoning` (footnote, label-2) and all sources as pills (caption, bg `rgba(255,255,255,0.08)`), plus `model` (caption, label-3: "claude-sonnet-5-5").
- Origin `mock` rows show a caption "Optimizer fallback"; `chaos` rows show "Chaos test" pill (gray). Honesty matters.
- In baseline view: list at 40% opacity with an overlay line "The baseline has no agent." (footnote, centered).

---

## C11. Live call card — `src/ui/LiveCallCard.tsx`

- **Idle:** collapsed glass pill 380×44: `Phone` icon label-3 + "No active calls" (footnote label-2) + right: `"3 calls today"`.
- **Active:** springs open to ~380×240.
  - Header row: 40px avatar circle `--elevated-2` with initials (body 600); name (headline) "Carlos"; sub (footnote label-2) "Truck 4 · Auto parts · Live phone call" (or "Simulated call"); right: timer `0:42` (body `.num`) with 8px green dot pulsing (red dot never used here).
  - Waveform: 28 bars, 3px wide, 3px gap, radius 1.5, height spring-animated 4–28px. Bars driven by `lastSpeechAt`: if speech < 1.5 s ago, random target heights every 120 ms; else settle to 4px. Color: white 85% when `linea` is speaking, `--green` 85% when the human is speaking. Label under it (caption label-3): "Linea speaking" / "Carlos speaking".
  - Transcript: last 3 utterances. Each: speaker caption (label-3, "Linea" / "Carlos"), original text (body 400 white), English (footnote label-2) beneath when available. New utterance slides up.
  - Tool pills row: caption pills `report_queue_position ✓` with `Check` icon green, bg `rgba(255,255,255,0.08)`.
  - Ended: show outcome line ("Call ended · 0:58 · Queue report added") for 4 s, then collapse. No-answer: "No answer" in orange.

---

## C12. Impact card — `src/ui/ImpactCard.tsx` (the with-vs-without hero)

Glass card 560×248, padding 20.
- Top row: caption label-3 "Impact so far". Below: hero `4.6` (display 48 `.num`) + inline "truck-hours out of line" (headline 400, label-2), baseline-aligned.
- Sub-stats row (footnote): `Produce in line  22 min  vs  2 h 41 min` · `On time  10/10  vs  7/10`. Linea values white, baseline values label-3.
- **Chart (SVG, 520×112, `d3-shape` `line` + `area`, `curveMonotoneX`):**
  - x: sim time 1:30 → 7:30 PM. Ticks at 2, 3, 4, 5, 6, 7 PM (caption, label-3), no axis line.
  - y: cumulative truck-hours in line, 0 → max(baseline)·1.1. Three hairline gridlines `rgba(255,255,255,0.06)`; no y labels except the max at top-right (caption label-3).
  - **Area between** baseline and linea: fill `--green` at **12%** opacity. Label "Saved" (caption, green) placed at the x where the gap is largest, vertically centered in the gap.
  - **Without line:** `rgba(255,255,255,0.30)`, 2px. **With Linea line:** `--blue`, 2.5px, round caps.
  - Now cursor: 1px vertical `rgba(255,255,255,0.25)` at current sim time + 6px blue dot on the linea line end.
  - Legend (caption, label-2), top-right: ● With Linea (blue) ● Without (gray).
  - Animate path growth by drawing up to current time only; new points ease in (spring on the path's last point).

---

## C13. End card — `src/ui/EndCard.tsx` (hotkey `F`)

Full-screen `#000` overlay, fade 600 ms. Centered:
- `250,000` — 120px, weight 600, `.num`, white.
- `truck-hours a year at Otay Mesa if every truck saved 15 minutes` — 24px 400 label-2.
- 48px gap, then three small stats in a row (footnote label-2): `This shift: 4.6 truck-hours saved on 10 trucks` · `10/10 on time` · `$1.42 in Claude spend · 1 human touch` (live values from store).
- Bottom (caption label-3): `990,111 northbound trucks at Otay Mesa in 2025 (BTS). Border delays cost the region $3.4B and 88,000 jobs (SANDAG, 2016 data).`
`Esc` or `F` closes.

---

## C14. Hotkeys — `src/ui/Hotkeys.tsx`

| Key | Action |
|---|---|
| `Space` | pause/play (`/control`) |
| `1` / `2` / `3` | speed 1× / 20× / 60× |
| `S` | `inject_spike` |
| `C` | `request_queue_report` |
| `M` | `inject_missed_call` |
| `O` | `inject_oscillation` |
| `Shift+O` | `chaos_flip` |
| `B` | `budget_squeeze` |
| `L` | toggle With / Without (local) |
| `F` | end card (local) |
| `D` | debug overlay (local): FPS, last seq, connection state, event counts |
| `R` | `reset` (requires holding `Shift+R` to avoid accidents) |

No on-screen hint of hotkeys (demo stays clean). A tiny toast (caption, glass, bottom-center, 1.2 s) confirms each command: "Spike injected".

---

## C15. Definition of done (by 3:25)

- [ ] `VITE_MOCK=1 npm run dev -w web` plays the full mock story; every panel animates as specified.
- [ ] 60 fps on a MacBook at 1920×1080 with the map pitched (check with `D`).
- [ ] Looks right at 1440×900 and 1920×1080; nothing below 11px; no overlap between panels.
- [ ] Switching to `VITE_MOCK=0` against A's server works with zero code changes.
- [ ] Island alert, oscillation flash, call card, and chart "Saved" area all demonstrably fire in the mock.

## C16. Polish pass (3:55–5:15)

- Check against the real stream: copy that's too long gets truncated with ellipsis, never wraps the Island.
- Run on the actual projector or a TV if available; switch to `?projector=1` if blur is muddy.
- Make the first 5 seconds gorgeous: the flyTo arrival, trucks fading in at their yards, strip numbers at 0.
- Screen-record the replay at 1920×1080, 60 fps, for the video.
