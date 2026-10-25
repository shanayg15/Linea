# Track B — Agent (Claude) & Voice (Twilio)

> **Paste into Claude Code:**
> "Read `SPEC.md` and `TRACK_B_AGENT_VOICE.md` in full. You are building Track B only: `server/src/agent/**` and `server/src/voice/**`. Never edit any other file — dependencies are already installed by Track A. Implement against `server/src/world/api.ts` (`WorldApi`). Until A's world is ready, use the `FakeWorld` described in §B0. Build in order §B1→§B9. Use `@anthropic-ai/sdk` (Messages API, tool use, streaming, prompt caching). TypeScript strict, ESM."

You own: `server/src/agent/**`, `server/src/voice/**`. You export `createAgent(world)` and `mountVoice(app, httpServer, world)` (signatures in SPEC §4.1).

**First 10 minutes (setup, no code):**
1. Anthropic: put `ANTHROPIC_API_KEY` in `.env`. Look up current per-million-token prices for `claude-sonnet-5-5` and `claude-haiku-5-5` (input, output, cache write, cache read) at https://docs.claude.com/en/docs/about-claude/pricing and put them in `cost.ts` (§B3).
2. Twilio: buy a US voice number. **Verify both teammates' phones** (trial accounts can only call verified numbers and play a trial preamble — upgrade the account if you can, it removes the preamble). If Twilio errors on ConversationRelay, enable the Predictive/Generative AI features addendum in the Twilio Console voice settings.
3. Tunnel: `cloudflared tunnel --url http://localhost:8787` (or `ngrok http 8787`). Put the https URL in `PUBLIC_BASE_URL`. Note: URL changes on restart.
4. Look up Twilio per-minute prices (outbound voice + ConversationRelay) and put them in `cost.ts`.

---

## B0. FakeWorld (for the first 40 min, while A builds)

`server/src/agent/__fake.ts` (yours, delete or keep — never imported in prod): a minimal `WorldApi` with 3 trucks, static ports (Otay std 118, FAST 45, Tecate 25), `scoreOptions` returning 3 hardcoded options, `applyAction` that logs, and a bus that `console.log`s events. Write `npx tsx server/src/agent/__dev.ts` that creates the agent on the fake world and fires `trigger('port_change')` so you can iterate on prompts and the watchdog immediately.

---

## B1. Dispatcher loop — `server/src/agent/dispatcher.ts`

**Trigger handling**
- `trigger(reason, detail)` pushes to a pending set. A runner processes **one Claude request at a time**. Debounce: after a request completes, wait until ≥ **3 sim-min** have passed since the last request (except `queue_report`, `request_queue_report`, `call_ended` → immediate). Multiple pending triggers coalesce into one request (pass all reasons).
- If the watchdog is in `paused` state (no-progress trip) skip until it un-pauses.

**Request**
- Model: `MODEL_DISPATCH` (Sonnet), or `MODEL_DEGRADED` (Haiku) when budget state is `warn` (see §B4).
- `max_tokens: 1024`, `temperature: 0.2`.
- `system`: the dispatcher prompt (§B2) as a single text block with `cache_control: { type: 'ephemeral' }`. Tool definitions (§B2) are static → also cached (put `cache_control` on the last tool).
- `messages`: one user message = **state brief** (below). No conversation history across requests (keeps cost flat); include the last 10 decisions inside the brief instead.
- `tool_choice: { type: 'any' }` (must act or call `no_action`).

**State brief (JSON in a `<state>` tag, ≤ ~2.5k tokens):**
```json
{
  "now": "3:02 PM",
  "triggers": ["port_change: otay_mesa standard 35→118", "queue_report: Truck 4"],
  "ports": [{"id":"otay_mesa","standardWaitMin":118,"fastWaitMin":45,"mxSideExtraMin":60,"sources":["cbp:otay_mesa:standard:14:55","driver:T4:14:57"]}, ...],
  "trucks": [{"id":"T8","driver":"Elena","cargo":"produce","priority":"perishable","state":"at_yard","port":null,"lane":null,"deadline":"5:00 PM","minutesInLine":0,
              "canTakeCall": true, "lastCalledAt": null,
              "options":[{"option":"go_now","port":"tecate","lane":"standard","expectedLineMin":25,"lateMin":0,"score":31,"explanation":"...","sourceIds":[...]}, ... top 3]}],
  "recentDecisions": [{"t":"2:58 PM","title":"Holding Truck 9 at the yard until 6:30 PM"}],
  "watchdog": {"budget":{"usedUsd":0.42,"capUsd":3.0},"blockedRecently":["reassign T7 → tecate (oscillation)"]},
  "citeableSourceIds": ["cbp:otay_mesa:standard:14:55", "driver:T4:14:57", "schedule:T8", ...]
}
```
Only include trucks that are not `delivered`. Times formatted `h:mm A` for the model.

**Response handling:** for each `tool_use` block, in order → build a `ProposedAction` → **watchdog gate** (§B4) → if allowed, execute (§B2 table) → emit `agent.decision`. Do **not** send tool_results back (single-shot); end the request. Emit one `agent.usage` per request (cost from `usage`, including `cache_read_input_tokens` / `cache_creation_input_tokens`). Split the request cost evenly over its executed decisions for `agent.decision.costUsd`. If the model wrote any text, emit it as `agent.thinking` (truncate 140 chars).

**Errors:** Anthropic 429/5xx → retry once after 2 s, then fall back to the mock behavior for that trigger (take best option, `origin: 'mock'`) and emit `agent.thinking` "Planner unavailable — used optimizer fallback".

---

## B2. Prompt + tools — `server/src/agent/prompts.ts`, `tools.ts`

**Dispatcher system prompt (use verbatim, edit only to tune):**
```
You are Linea, the autonomous dispatcher for Transportes Mesa, a 10-truck carrier moving loads north from Tijuana through the Otay Mesa commercial port (and Tecate as an alternative). You run unsupervised for a whole shift.

Goal: minimize total truck-hours spent in border lines while delivering every load on time. Priorities: jit auto parts must not be late; produce must not sit in line (heat); medical next; general loads are flexible and are the first to hold.

What you know:
- CBP wait times measure only the US-side queue. The Mexican-side export queue is invisible to CBP. A driver already in line can tell you how long it really is — calling them is how you learn it.
- Each truck comes with optimizer options (scored, lower is better). Prefer the best option unless you have a concrete reason the optimizer can't see; say the reason.
- An hour waiting at the yard is better than an hour in line: the driver isn't burning fuel or hours, and the load isn't cooking.

Rules:
1. Every action must cite source ids from citeableSourceIds that justify it. Actions without valid citations are blocked.
2. Do not flip a truck between ports or lanes repeatedly. If data is flapping, hold steady and escalate.
3. Call a driver only when the call can change a decision (e.g. to learn the real line length, or to give a reroute to a truck already driving). Never call the same driver again within 20 minutes unless something material changed.
4. Escalate to Ana (the human dispatcher) when two or more things need judgment, when data conflicts, or when the watchdog has blocked you. Batch issues into one escalation.
5. If nothing should change, call no_action with a one-line reason.
6. Write titles like an Apple notification: sentence case, ≤ 60 characters, concrete. "Holding Truck 9 at the yard until 6:30 PM". Reasoning: max 2 short sentences, plain language, include the number that drove the decision.
```

**Tools** (Anthropic tool schema `{name, description, input_schema}`; every tool has `title: string`, `reasoning: string`, `source_ids: string[]` required):

| Tool | Extra input | Executes | Emits `agent.decision.action` |
|---|---|---|---|
| `hold_truck` | `truck_id`, `until` ("6:30 PM") | `world.applyAction({kind:'hold', truckId, until: ISO})` | `hold` |
| `dispatch_truck` | `truck_id`, `port` (`otay_mesa`\|`tecate`), `lane` (`standard`\|`fast`) | `applyAction({kind:'dispatch',...})` | `dispatch` |
| `reassign_truck` | `truck_id`, `port`, `lane` | `applyAction({kind:'reassign',...})` | `reassign` |
| `call_driver` | `truck_id`, `goal` (`learn_queue` \| `give_instruction` \| `check_status`), `instruction?` (Spanish-ready plain text) | `voice.startDriverCall(...)` (§B6/§B7) | `call_driver` |
| `escalate_to_dispatcher` | `summary` (≤ 2 sentences, English), `questions` (string[] ≤ 2), `truck_ids` | `voice.startDispatcherCall(...)` + emit `escalation` | `escalate` |
| `no_action` | — (`source_ids` may be empty) | nothing | `no_action` |

Parse `until` like "6:30 PM" to ISO on the sim date (`-07:00`). Resolve `source_ids` → `SourceRef[]` via `world.sources()` for the decision's `sources`. `detail` = e.g. `"Otay Mesa → Tecate · standard lane"`.

---

## B3. Cost — `server/src/agent/cost.ts`

```ts
export const PRICES_PER_MTOK = {               // FILL FROM docs.claude.com pricing page — do not guess
  'claude-sonnet-5-5': { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  'claude-haiku-5-5':  { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
};
export const TWILIO_PER_MIN = { outbound: 0, conversationRelay: 0 }; // FILL from Twilio pricing
export function claudeCost(model: string, u: Usage): number { /* tokens/1e6 × price, sum all four */ }
export function callCost(durationSec: number): number { /* ceil(min) × (outbound + relay) */ }
```
Throw at startup if any Claude price is 0 while `AGENT_MODE=claude` (forces someone to fill it in). Track a running `usedUsd` in the watchdog.

---

## B4. Watchdog gate — `server/src/agent/watchdog.ts` (this is what 6 of 10 judges will grill — make it real)

`gate(p: ProposedAction): { verdict: 'allowed'|'blocked'|'deduped'; reason?: string; tripKind?: TripKind }` runs **before every action**, from the agent, the chaos test, and mock fallbacks alike. Always emit `tool.gate`. Checks in this order; first failure wins:

1. **Cite-or-block (`uncited`)** — every `source_id` must exist in `world.sources()`; at least one required (except `no_action`). Block.
2. **Idempotency (`deduped`)** — key = `sha1(tool + truck_id + port + lane + until + goal)` bucketed by **10 sim-min**. Seen → `deduped` (not a trip, just not executed).
3. **Budget (`budget`)** — `usedUsd / capUsd`:
   - ≥ 0.70 → state `warn`, switch dispatcher model to `MODEL_DEGRADED`, emit `watchdog.trip {kind:'budget', response:'degraded', title:'Budget at 70% — switched to Haiku'}` (once).
   - ≥ 0.90 → block `call_driver` for trucks whose priority is `standard` (`response:'blocked'`).
   - ≥ 1.00 → stop the dispatcher loop (`response:'stopped'`), escalate once, world falls back to timeout auto-dispatch.
4. **Oscillation (`oscillation`)** — per truck keep assignment history `[(port, lane, simMs)]`. Trip if the proposal would make **≥ 3 assignment changes within 15 sim-min**, or recreate an A→B→A pattern within 15 sim-min. Response: **block**, **freeze** the truck (further reassigns blocked until resolved), add to the pending-escalation batch. Evidence lines: `"3:21 PM Otay → Tecate (Tecate 15 min)"`, `"3:23 PM Tecate → Otay (Tecate 95 min)"`, `"3:25 PM Otay → Tecate (blocked)"`.
5. **Repeat tool (`repeat_tool`)** — same tool + same normalized args (ignoring prose) ≥ **3 times in 20 sim-min** even across idempotency buckets → block + trip.
6. **Repeat call (`repeat_call`)** — `call_driver` for a truck called < **20 sim-min** ago with no new `port.update` (Δ ≥ 15) or `queue.report` since → block (trip only on the 2nd block).
7. **Not worth it (`not_worth_it`)** — for `call_driver` with goal `give_instruction`/`check_status`: estimated benefit = (current option score − best option score) minutes × **$1.50/min** (truck idle cost ≈ $90/h, stated as an assumption); if benefit < estimated call cost (`callCost(90s) + ~$0.01`), block. `learn_queue` calls are exempt (information value).
8. **No progress (`no_progress`)** — after each dispatcher request record `world.projectFleetDelayMin()`. If over the last **4** requests the metric hasn't improved by ≥ 5 min while `usedUsd` rose ≥ $0.15 → trip, `response: 'paused'`: dispatcher loop pauses **30 sim-min**, escalate.
9. **No answer (`no_answer`)** — fed by voice: **2 consecutive** no-answers for the same driver → trip, stop calling that driver, add to escalation batch.

**Escalation batching:** trips with `escalated` intent accumulate for **2 sim-min**, then one `escalate_to_dispatcher` is issued by the watchdog itself (not Claude), summary generated from trip titles: *"Two things need you. Pedro's truck keeps flipping between Otay and Tecate because Tecate's feed is flapping, and Iván hasn't answered twice. Should I keep Pedro on Otay?"*

**`watchdog.status`** emitted after every gate decision and every 10 sim-min: budget (usedUsd, capUsd, current model), loops (`ok` / `warn` when any truck has 2 changes in 15 min / `tripped`), progress (`fleetDelayMin`, trend from last 3 samples).

**Resolution:** when the dispatcher call ends with a decision (§B6 tool `dispatcher_decision`, or the simulated equivalent in §B7), apply it (e.g. keep T7 on Otay = unfreeze with current assignment locked 30 sim-min), emit `watchdog.resolved {by:'dispatcher'}` for each batched trip.

**`handleControl`:** `budget_squeeze` → `capUsd = usedUsd + 0.10`. `chaos_flip` → §B9. `request_queue_report` → enqueue a trigger with reason `"operator: ask a driver in line at Otay Mesa for the real queue length"`.

---

## B5. Voice wiring — `server/src/voice/index.ts`

`mountVoice(app, httpServer, world)`:
- `app.post('/voice/twiml', express.urlencoded({extended:false}), handler)` — returns TwiML for a call (callId in query).
- `app.post('/voice/status', ...)` — Twilio status callback → `call.status`; map `no-answer`/`busy`/`failed`/`canceled` → `call.ended {outcome}` and feed watchdog `no_answer`.
- `app.post('/voice/connect-action', ...)` — return `<Response><Hangup/></Response>`.
- WebSocket server on `httpServer` upgrade for path `/voice/relay` (`new WebSocketServer({ noServer: true })`; handle `upgrade` event, check pathname).
- Export a `voice` singleton the agent uses: `startDriverCall({truckId, goal, instruction})`, `startDispatcherCall({summary, questions, tripIds})`.
- **Routing live vs simulated:** live iff (`truckId === 'T4'` and `PHONE_T4_CARLOS` set) or (dispatcher and `PHONE_DISPATCHER_ANA` set) and `PUBLIC_BASE_URL` set. Otherwise simulated (§B7). If a live call is already in progress, queue the next live call.

---

## B6. Live calls — `server/src/voice/calls.ts` + `relay.ts`

**Place the call** (Twilio Node SDK):
```ts
await client.calls.create({
  to, from: process.env.TWILIO_FROM_NUMBER!,
  url: `${PUBLIC_BASE_URL}/voice/twiml?callId=${callId}`,
  statusCallback: `${PUBLIC_BASE_URL}/voice/status?callId=${callId}`,
  statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
  timeout: 20,
});
```
On create: emit `call.started`, `world.setClockSpeed(1)`. On end: `world.restoreClockSpeed()`.

**TwiML** (verify attribute names against https://www.twilio.com/docs/voice/twiml/connect/conversationrelay before shipping):
```xml
<Response>
  <Connect action="{PUBLIC_BASE_URL}/voice/connect-action">
    <ConversationRelay url="wss://{host}/voice/relay?callId={callId}"
                       language="es-MX"                      <!-- en-US for Ana -->
                       welcomeGreeting="Hola Carlos, habla Linea, el despachador automático de Transportes Mesa. Soy una inteligencia artificial. ¿Ya estás en la fila de Otay?"
                       interruptible="true" />
  </Connect>
</Response>
```
Ana's greeting (en-US): `"Hi Ana, it's Linea. Two things need you."` then the first model turn delivers the summary.

**WebSocket protocol** (confirmed from Twilio docs):
- Twilio → you: `{"type":"setup", callSid, customParameters, ...}`, `{"type":"prompt","voicePrompt":"...","lang":"es-MX","last":true}`, `{"type":"interrupt","utteranceUntilInterrupt":"...","durationUntilInterruptMs":460}`, `{"type":"dtmf","digit":"1"}`, `{"type":"error","description":"..."}`.
- You → Twilio: `{"type":"text","token":"...","last":false}` streamed; finish each turn with `{"type":"text","token":"","last":true}`. End the call: `{"type":"end","handoffData":"{\"summary\":\"...\"}"}`.

**Per-connection loop (`relay.ts`):**
1. On `setup`: bind `callId` (from query), store `callSid`, emit `call.status in_progress`, emit the greeting as a `call.transcript` (speaker `linea`).
2. On `prompt` with `last: true`: emit `call.transcript` (speaker `human`, `final: true`), kick off async translation (§B6.1), append to conversation, run a Claude turn:
   - `client.messages.stream({ model: MODEL_VOICE, max_tokens: 200, temperature: 0.3, system: [voice prompt (cached)], tools: voiceTools, messages })`.
   - Forward each text delta to Twilio as `{type:'text', token, last:false}` **immediately** (latency). Accumulate for the transcript.
   - On `tool_use`: execute (below), emit `call.tool`, append `tool_result`, and continue with another stream (loop until `stop_reason === 'end_turn'`, max 3 hops).
   - Send `{type:'text', token:'', last:true}`; emit `call.transcript` (speaker `linea`, final) + translation; emit `agent.usage` (purpose `voice`).
3. On `interrupt`: abort the current stream (`AbortController`); truncate the stored assistant message to `utteranceUntilInterrupt`.
4. When `end_call` tool runs: speak the closing line, wait ~1.5 s, send `{type:'end', handoffData}`; emit `call.ended {outcome:'completed', summary, durationSec, costUsd}`; restore clock.
5. Hard cap: 90 s per driver call, 120 s per dispatcher call → say goodbye and end.

**Driver voice prompt (Spanish, cached):**
```
Eres Linea, el despachador automático (una inteligencia artificial) de Transportes Mesa. Hablas por teléfono con un chofer que maneja. Reglas: frases cortas (máximo 20 palabras por turno), español mexicano natural, sin listas ni formato, números dichos con naturalidad. Nunca finjas ser humano.
Objetivo de esta llamada: {goal_description}. Datos: {truck_brief}. Instrucción a dar (si hay): {instruction}.
Si el chofer dice dónde está en la fila, llama report_queue_position con tu mejor estimación en kilómetros y minutos extra (≈ 30 min por km del lado mexicano). Si da su estado, llama report_status. Si le das una instrucción, confirma que la aceptó con confirm_instruction. Cuando tengas lo necesario, despídete en una frase y llama end_call.
```
**Driver voice tools:** `report_queue_position {port_id, side:'mx', length_km, extra_wait_min}` → `world.reportQueue()` (this emits `queue.report` and triggers the dispatcher); `report_status {status:'in_queue'|'driving'|'at_yard'|'problem', note}`; `confirm_instruction {accepted:boolean, note}`; `end_call {summary_en}`.

**Dispatcher voice prompt (English, cached):**
```
You are Linea, an AI dispatcher, calling Ana, the human dispatcher, because the watchdog needs her judgment. Be brief and concrete: one sentence per issue, then ask the question. Summary: {summary}. Questions: {questions}. Options you can apply: keep_current, approve_linea_plan, raise_budget, custom. When Ana decides, call dispatcher_decision, confirm in one sentence, then call end_call.
```
**Dispatcher tools:** `dispatcher_decision {trip_ids, decision, note}` → watchdog resolution (§B4); `end_call {summary_en}`.

### B6.1 Translation — `server/src/voice/translate.ts`
For every final Spanish utterance (both speakers), call Haiku: system "Translate to natural English. Output only the translation." `max_tokens: 120`. Re-emit `call.transcript` with the **same `utteranceId`** and `textEnglish` filled. Emit `agent.usage` purpose `translate`. Don't block the call loop on it.

---

## B7. Simulated calls — `server/src/voice/simulated.ts`

Same events as live, no Twilio, no clock change, **no Claude** (canned lines — fast and free). Timeline in wall time: `call.started` → `call.status ringing` (0.8 s) → either:
- **No answer** (T6 when `world.isScenarioFlag('missed_call_T6')`, or 0% otherwise): `call.status no_answer` at 3 s → `call.ended {outcome:'no_answer'}` → watchdog `no_answer` counter.
- **Answer:** `in_progress`, then 3–4 `call.transcript` lines 1.2 s apart from a template keyed by goal:
  - `learn_queue`: Linea "Hola {name}, habla Linea, el despachador automático. ¿Cuánto te falta para la garita?" → driver "Voy como a un kilómetro, del lado mexicano." → `report_queue_position` (1 km, +30 min) → Linea "Gracias, ajusto el plan." 
  - `give_instruction`: Linea "{name}, cambio de plan: {instruction}" → driver "Va, entendido." → `confirm_instruction` → Linea "Gracias, buen camino."
  - `check_status`: driver "Todo bien, ya voy en camino."
  Each line with `textEnglish` prefilled (no translation call). `call.ended {outcome:'completed', durationSec: 40, costUsd: 0}`.
- Dispatcher simulated (if Ana's phone not configured): Ana "Keep Pedro on Otay." → `dispatcher_decision keep_current`.

UI labels simulated calls subtly ("Simulated call") — **never present a simulated call as live.**

---

## B8. `server/src/agent/index.ts`

```ts
export function createAgent(world: WorldApi): Agent {
  const watchdog = createWatchdog(world);
  const voice = getVoice(world, watchdog);   // from ../voice (lazy import ok)
  const dispatcher = createDispatcher(world, watchdog, voice);
  return {
    trigger: dispatcher.trigger,
    handleControl: (c) => watchdog.handleControl(c, dispatcher),
    stop: dispatcher.stop,
  };
}
```

---

## B9. Chaos test — `server/src/agent/chaos.ts`

`chaos_flip` submits three `reassign_truck` proposals for **T7** through the **same gate**, 2 sim-min apart: Otay→Tecate, Tecate→Otay, Otay→Tecate, each citing the current Tecate `port.update` source, `origin: 'chaos'`. Expected: first two allowed, third blocked with `oscillation` trip → escalation call to Ana. This is the guaranteed demo path for beat 5 if Claude (sensibly) refuses to flip on `O` alone. Also write `server/src/agent/watchdog.test.ts` (run with `npx tsx`) covering each check — say in the demo "the watchdog has tests".

---

## B10. Definition of done (by 3:25)

- [ ] Against FakeWorld: a `port_change` trigger yields 1–4 cited actions, `agent.usage` with nonzero cost, `tool.gate` events.
- [ ] Watchdog unit checks pass for all 9 checks.
- [ ] One **live** test call to your own phone works end-to-end in Spanish with a tool call mid-call (`report_queue_position`) and clean hang-up.
- [ ] Simulated calls emit the full event sequence; T6 missed-call path trips `no_answer` after 2 attempts.
- [ ] After merge: full shift on A's world with `AGENT_MODE=claude` costs < $2 and ends with ≥ 1 escalation and 1 resolved trip.

**Latency tips:** keep the voice system prompt + tools cached; `max_tokens: 200`; stream tokens to Twilio as they arrive; no translation on the critical path. Target < 1.2 s from end of driver speech to first audio.
