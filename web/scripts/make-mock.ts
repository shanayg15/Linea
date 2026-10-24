// Generates fixtures/mock-events.jsonl — a ~3.5-minute story following SPEC §5.
// Run: npx tsx scripts/make-mock.ts   (from /web)
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Cargo,
  Lane,
  LineaEventType,
  Metrics,
  PayloadOf,
  PortId,
  PortStatus,
  Priority,
  SimClock,
  SourceRef,
  Truck,
  TruckState,
  WatchdogStatus,
  WorldView,
} from '../../shared/types';
import { PLACES, lerpPos, slicePath, type LngLat } from '../src/geo';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------- time ----------------
const MIN = 60_000;
const DAY = '2026-10-22';
const t = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00-07:00`);
const START = t('13:30');
const END = t('19:30');
const iso = (ms: number) => new Date(ms - 7 * 3600_000).toISOString().slice(0, 19) + '-07:00';
const clockLabel = (ms: number) => {
  const d = new Date(ms - 7 * 3600_000);
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} PM`;
};
const hm = (ms: number) => {
  const d = new Date(ms - 7 * 3600_000);
  return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

const TICK_WALL_MS = 500; // 2 Hz in the fixture (UI interpolates over the measured interval)
const FAST_SPEED = 120; // sim ms per wall ms (whole shift ≈ 3 wall minutes)
const WALL0 = Date.parse('2026-10-24T22:00:00Z');

// ---------------- curves (SPEC §5) ----------------
type Curve = [number, number][];
const curve = (pts: [string, number][]): Curve => pts.map(([h, v]) => [t(h), v]);
const OTAY_STD = curve([['13:30', 35], ['14:30', 45], ['14:54', 47], ['14:55', 118], ['15:30', 125], ['16:30', 110], ['17:30', 95], ['18:30', 55], ['19:30', 40]]);
const OTAY_FAST = curve([['13:30', 15], ['14:30', 18], ['14:54', 19], ['14:55', 45], ['15:30', 48], ['16:30', 40], ['17:30', 30], ['18:30', 20], ['19:30', 15]]);
const TECATE_STD = curve([['13:30', 20], ['14:30', 22], ['14:55', 25], ['15:30', 25], ['16:30', 30], ['17:30', 28], ['18:30', 22], ['19:30', 20]]);
const OTAY_MX = curve([['13:30', 10], ['14:30', 15], ['14:54', 15], ['14:55', 60], ['15:30', 60], ['16:30', 45], ['17:30', 35], ['18:30', 15], ['19:30', 10]]);
function at(c: Curve, ms: number): number {
  if (ms <= c[0]![0]) return c[0]![1];
  for (let i = 1; i < c.length; i++) {
    const [t1, v1] = c[i]!;
    const [t0, v0] = c[i - 1]!;
    if (ms <= t1) return Math.round(v0 + ((v1 - v0) * (ms - t0)) / (t1 - t0));
  }
  return c.at(-1)![1];
}
// Tecate flaps 15↔95 every 2 sim-min from 3:20 to 3:32 (beat 5)
function tecateWait(ms: number): number {
  if (ms >= t('15:20') && ms < t('15:32')) return Math.floor((ms - t('15:20')) / (2 * MIN)) % 2 === 0 ? 15 : 95;
  return at(TECATE_STD, ms);
}
/** True wait a truck experiences (the Tecate flap is feed noise, not real). */
function wait(port: PortId, lane: Lane, ms: number): number {
  if (port === 'tecate') return at(TECATE_STD, ms);
  return lane === 'fast' ? at(OTAY_FAST, ms) : at(OTAY_STD, ms);
}
/** What CBP reports (port.update / port status). */
function reported(port: PortId, lane: Lane, ms: number): number {
  return port === 'tecate' ? tecateWait(ms) : wait(port, lane, ms);
}

// ---------------- geometry ----------------
const KM_PER_DEG = 111;
function distKm(a: LngLat, b: LngLat) {
  const kx = Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * kx, b[1] - a[1]) * KM_PER_DEG;
}
function bearing(a: LngLat, b: LngLat) {
  const kx = Math.cos((a[1] * Math.PI) / 180);
  return ((Math.atan2((b[0] - a[0]) * kx, b[1] - a[1]) * 180) / Math.PI + 360) % 360;
}
function queuePath(port: LngLat, from: LngLat, km: number): LngLat[] {
  const d = distKm(port, from);
  const f = km / d;
  const start: LngLat = [port[0] + (from[0] - port[0]) * f, port[1] + (from[1] - port[1]) * f];
  // slight bend so it reads as a road
  const mid1 = lerpPos(start, port, 0.35);
  const mid2 = lerpPos(start, port, 0.7);
  return [start, [mid1[0] + 0.002, mid1[1] - 0.001], [mid2[0] + 0.001, mid2[1]], port];
}
const PORT_POS: Record<PortId, LngLat> = { otay_mesa: PLACES.port_otay_mesa.pos, tecate: PLACES.port_tecate.pos };
const QUEUE: Record<PortId, LngLat[]> = {
  otay_mesa: queuePath(PORT_POS.otay_mesa, PLACES.yard_el_florido.pos, 3),
  tecate: queuePath(PORT_POS.tecate, PLACES.yard_el_florido.pos, 1.5),
};
const travelMin = (a: LngLat, b: LngLat) => (distKm(a, b) / 60) * 60 * 1.15; // 60 km/h, 1.15 road factor
const round = (p: LngLat): LngLat => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];

// ---------------- fleet (SPEC §5) ----------------
type Place = keyof typeof PLACES;
const FLEET: [string, string, Cargo, Priority, boolean, string, string, Place, Place][] = [
  ['T1', 'Luis', 'auto_parts', 'jit', true, '13:40', '16:30', 'yard_nueva_tijuana', 'dest_otay_xdock'],
  ['T2', 'Rosa', 'auto_parts', 'jit', true, '14:10', '17:00', 'yard_nueva_tijuana', 'dest_otay_xdock'],
  ['T3', 'Jorge', 'auto_parts', 'jit', false, '14:40', '17:30', 'yard_el_florido', 'dest_chula_vista'],
  ['T4', 'Carlos', 'auto_parts', 'jit', false, '14:15', '17:15', 'yard_el_florido', 'dest_chula_vista'],
  ['T5', 'Marta', 'medical', 'standard', true, '14:30', '18:30', 'yard_pacifico', 'dest_kearny_mesa'],
  ['T6', 'Iván', 'medical', 'standard', false, '15:00', '19:00', 'yard_pacifico', 'dest_kearny_mesa'],
  ['T7', 'Pedro', 'medical', 'standard', false, '15:20', '19:15', 'yard_el_florido', 'dest_kearny_mesa'],
  ['T8', 'Elena', 'produce', 'perishable', false, '14:50', '17:00', 'yard_el_florido', 'dest_produce'],
  ['T9', 'Raúl', 'general', 'standard', false, '15:00', '34:00', 'yard_nueva_tijuana', 'dest_otay_xdock'],
  ['T10', 'Sofía', 'general', 'standard', false, '15:10', '34:00', 'yard_pacifico', 'dest_chula_vista'],
];

interface SimTruck {
  t: Truck;
  departAt: number | null;
  legFrom: LngLat;
  legTo: LngLat;
  legStart: number;
  legEnd: number;
  mxEnd: number;
  usEnd: number;
  firstLeg?: { port: PortId; from: LngLat; to: LngLat; start: number; end: number };
}

function makeFleet(): SimTruck[] {
  return FLEET.map(([id, driverName, cargo, priority, fastEligible, ready, deadline, o, d], i) => {
    const jitter: LngLat = [((i % 3) - 1) * 0.0025, (Math.floor(i / 3) % 3 - 1) * 0.0018];
    const pos: LngLat = round([PLACES[o].pos[0] + jitter[0], PLACES[o].pos[1] + jitter[1]]);
    const dl = deadline === '34:00' ? t('10:00') + 24 * 60 * MIN : t(deadline);
    return {
      t: {
        id,
        driverName,
        cargo,
        priority,
        fastEligible,
        readyAt: iso(t(ready)),
        deadline: iso(dl),
        origin: { name: PLACES[o].name, pos: PLACES[o].pos },
        destination: { name: PLACES[d].name, pos: PLACES[d].pos },
        state: 'at_yard' as TruckState,
        pos,
        heading: 0,
        port: null,
        lane: null,
        heldUntil: null,
        queueEnteredAt: null,
        crossedAt: null,
        deliveredAt: null,
        minutesInLine: 0,
        etaDelivery: null,
        phoneMode: id === 'T4' ? 'live' : 'simulated',
      },
      departAt: null,
      legFrom: pos,
      legTo: pos,
      legStart: 0,
      legEnd: 0,
      mxEnd: 0,
      usEnd: 0,
    };
  });
}

const fleets = { linea: makeFleet(), baseline: makeFleet() };
const get = (policy: 'linea' | 'baseline', id: string) => fleets[policy].find((x) => x.t.id === id)!;

// Baseline: go when ready, Otay, FAST if eligible, never hold/divert.
for (const s of fleets.baseline) {
  s.departAt = Date.parse(s.t.readyAt);
  s.t.port = 'otay_mesa';
  s.t.lane = s.t.fastEligible ? 'fast' : 'standard';
}

function depart(s: SimTruck, now: number) {
  s.t.state = 'en_route';
  s.t.heldUntil = null;
  s.legFrom = s.t.pos;
  s.legTo = QUEUE[s.t.port!][0]!;
  s.legStart = now;
  s.legEnd = now + travelMin(s.legFrom, s.legTo) * MIN;
  s.firstLeg = { port: s.t.port!, from: s.legFrom, to: s.legTo, start: s.legStart, end: s.legEnd };
}

function step(s: SimTruck, now: number, dt: number, mxKnown: boolean) {
  const tr = s.t;
  const prev = tr.pos;
  switch (tr.state) {
    case 'at_yard':
    case 'held':
      if (tr.heldUntil && now < Date.parse(tr.heldUntil)) tr.state = 'held';
      else if (tr.state === 'held') tr.state = 'at_yard';
      if (s.departAt !== null && now >= s.departAt && tr.port) depart(s, now);
      break;
    case 'en_route': {
      const f = Math.min(1, (now - s.legStart) / Math.max(1, s.legEnd - s.legStart));
      tr.pos = lerpPos(s.legFrom, s.legTo, f);
      if (f >= 1) {
        const mx = tr.port === 'otay_mesa' ? at(OTAY_MX, now) : 0;
        const us = wait(tr.port!, tr.lane!, now);
        s.mxEnd = now + mx * MIN;
        s.usEnd = s.mxEnd + us * MIN;
        tr.queueEnteredAt = iso(now);
        tr.state = mx > 0 ? 'in_queue_mx' : 'in_queue_us';
      }
      break;
    }
    case 'in_queue_mx':
    case 'in_queue_us': {
      tr.minutesInLine += dt / MIN;
      const q0 = Date.parse(tr.queueEnteredAt!);
      const path = QUEUE[tr.port!];
      if (now < s.mxEnd) {
        tr.state = 'in_queue_mx';
        tr.pos = slicePath(path, 0, 0.7 * ((now - q0) / Math.max(1, s.mxEnd - q0))).at(-1)!;
      } else if (now < s.usEnd) {
        tr.state = 'in_queue_us';
        tr.pos = slicePath(path, 0, 0.7 + 0.3 * ((now - s.mxEnd) / Math.max(1, s.usEnd - s.mxEnd))).at(-1)!;
      } else {
        tr.state = 'crossed';
        tr.crossedAt = iso(now);
        s.legFrom = PORT_POS[tr.port!];
        s.legTo = tr.destination.pos;
        s.legStart = now;
        s.legEnd = now + travelMin(s.legFrom, s.legTo) * MIN;
      }
      break;
    }
    case 'crossed': {
      const f = Math.min(1, (now - s.legStart) / Math.max(1, s.legEnd - s.legStart));
      tr.pos = lerpPos(s.legFrom, s.legTo, f);
      if (f >= 1) {
        tr.state = 'delivered';
        tr.deliveredAt = iso(now);
      }
      break;
    }
    case 'delivered':
      break;
  }
  tr.pos = round(tr.pos);
  if (prev[0] !== tr.pos[0] || prev[1] !== tr.pos[1]) tr.heading = Math.round(bearing(prev, tr.pos));
  tr.etaDelivery = iso(eta(s, now, mxKnown));
}

function eta(s: SimTruck, now: number, mxKnown: boolean): number {
  const tr = s.t;
  const toDest = (from: LngLat) => travelMin(from, tr.destination.pos) * MIN;
  switch (tr.state) {
    case 'delivered':
      return Date.parse(tr.deliveredAt!);
    case 'crossed':
      return s.legEnd;
    case 'in_queue_mx':
    case 'in_queue_us':
      return s.usEnd + toDest(PORT_POS[tr.port!]);
    case 'en_route': {
      const mx = tr.port === 'otay_mesa' && mxKnown ? at(OTAY_MX, now) : 0;
      return s.legEnd + (mx + wait(tr.port!, tr.lane!, now)) * MIN + toDest(PORT_POS[tr.port!]);
    }
    default: {
      const go = Math.max(now, s.departAt ?? 0, tr.heldUntil ? Date.parse(tr.heldUntil) : 0, Date.parse(tr.readyAt));
      const port = tr.port ?? 'otay_mesa';
      const lane = tr.lane ?? 'standard';
      const mx = port === 'otay_mesa' && mxKnown ? at(OTAY_MX, go) : 0;
      return go + (travelMin(tr.pos, PORT_POS[port]) + mx + wait(port, lane, go)) * MIN + toDest(PORT_POS[port]);
    }
  }
}

// ---------------- event output ----------------
const out: string[] = [];
let seq = 0;
let wall = 0;
let sim = START;
let speed = FAST_SPEED;
let clockSpeed = 60;
let scenarioStep = 'calm';

function emit<T extends LineaEventType>(type: T, payload: PayloadOf<T>) {
  seq += 1;
  out.push(
    JSON.stringify({
      id: `mock-${String(seq).padStart(6, '0')}`,
      seq,
      simTime: iso(sim),
      wallTime: new Date(WALL0 + wall).toISOString(),
      type,
      payload,
      wallMs: Math.round(wall),
    }),
  );
}

// sources
const sources = new Map<string, SourceRef>();
function cbpSource(port: PortId, lane: Lane, ms: number, waitMin: number): SourceRef {
  const s: SourceRef = {
    id: `cbp:${port}:${lane}:${hm(ms)}`,
    kind: 'cbp_replay',
    label: `CBP · ${port === 'otay_mesa' ? 'Otay Mesa' : 'Tecate'} ${lane} · ${waitMin} min · ${clockLabel(ms)}`,
    observedAt: iso(ms),
  };
  sources.set(s.id, s);
  return s;
}
function scheduleSource(id: string): SourceRef {
  const tr = get('linea', id).t;
  const s: SourceRef = { id: `schedule:${id}`, kind: 'schedule', label: `Schedule · ${tr.driverName} · due ${clockLabel(Date.parse(tr.deadline))}`, observedAt: iso(START) };
  sources.set(s.id, s);
  return s;
}
const lastPortSource: Record<string, SourceRef> = {};
const lastEmittedWait: Record<string, number> = {};
let mxReport: { extra: number; source: SourceRef } | null = null;

function portStatus(policy: 'linea' | 'baseline'): PortStatus[] {
  return (['otay_mesa', 'tecate'] as PortId[]).map((id) => {
    const std = lastPortSource[`${id}:standard`]!;
    const fast = lastPortSource[`${id}:fast`] ?? std;
    const mx = policy === 'linea' && id === 'otay_mesa' && mxReport ? mxReport : null;
    return {
      id,
      name: id === 'otay_mesa' ? 'Otay Mesa' : 'Tecate',
      pos: PORT_POS[id],
      standard: { waitMin: lastEmittedWait[`${id}:standard`] ?? null, lanesOpen: id === 'otay_mesa' ? 8 : 2, source: std },
      fast: { waitMin: id === 'tecate' ? null : lastEmittedWait[`${id}:fast`] ?? null, lanesOpen: id === 'tecate' ? null : 2, source: fast },
      mxSideExtraMin: mx ? mx.extra : 0,
      mxSideSource: mx ? mx.source : null,
      queuePath: QUEUE[id].map(round),
    };
  });
}

function updatePorts() {
  for (const [port, lane] of [['otay_mesa', 'standard'], ['otay_mesa', 'fast'], ['tecate', 'standard']] as [PortId, Lane][]) {
    const key = `${port}:${lane}`;
    const w = reported(port, lane, sim);
    const prev = lastEmittedWait[key];
    if (prev === undefined || Math.abs(w - prev) >= 5) {
      const source = cbpSource(port, lane, sim, w);
      lastPortSource[key] = source;
      lastEmittedWait[key] = w;
      if (prev !== undefined) emit('port.update', { portId: port, lane, waitMin: w, prevWaitMin: prev, source });
    }
  }
}

// metrics
let costUsd = 0;
let decisions = 0;
let calls = 0;
let humanTouches = 0;
function metrics(policy: 'linea' | 'baseline'): Metrics {
  const f = fleets[policy];
  const delivered = f.filter((s) => s.t.state === 'delivered');
  const late = delivered.filter((s) => Date.parse(s.t.deliveredAt!) > Date.parse(s.t.deadline));
  return {
    truckHoursInLine: Math.round((f.reduce((a, s) => a + s.t.minutesInLine, 0) / 60) * 100) / 100,
    deliveredOnTime: delivered.length - late.length,
    deliveredLate: late.length,
    deliveriesTotal: 10,
    jitAtRisk: f.filter((s) => s.t.priority === 'jit' && s.t.state !== 'delivered' && Date.parse(s.t.etaDelivery ?? s.t.deadline) > Date.parse(s.t.deadline)).length,
    produceMinutesInLine: Math.round(f.find((s) => s.t.cargo === 'produce')!.t.minutesInLine),
    costUsd: policy === 'linea' ? Math.round(costUsd * 100) / 100 : 0,
    humanTouches: policy === 'linea' ? humanTouches : 0,
    decisions: policy === 'linea' ? decisions : 0,
    calls: policy === 'linea' ? calls : 0,
  };
}

let wd: WatchdogStatus = {
  budget: { state: 'ok', usedUsd: 0, capUsd: 3, model: 'claude-sonnet-5-5' },
  loops: { state: 'ok', detail: 'No loops' },
  progress: { state: 'ok', fleetDelayMin: 0, trend: 'flat' },
};
function status(patch: Partial<WatchdogStatus> = {}) {
  wd = { ...wd, ...patch, budget: { ...wd.budget, usedUsd: Math.round(costUsd * 100) / 100 } };
  emit('watchdog.status', wd);
}

// ---------------- agent helpers ----------------
let callSeq = 0;
function usage(purpose: 'dispatch' | 'voice' | 'translate', cost: number, model = purpose === 'dispatch' ? 'claude-sonnet-5-5' : 'claude-haiku-5-5') {
  costUsd += cost;
  emit('agent.usage', {
    requestId: `req-${seq}`,
    purpose,
    model,
    inputTokens: purpose === 'dispatch' ? 2400 : 900,
    outputTokens: purpose === 'dispatch' ? 380 : 60,
    cacheReadTokens: purpose === 'dispatch' ? 1600 : 700,
    cacheWriteTokens: 0,
    costUsd: cost,
  });
}

type Tool = 'hold_truck' | 'dispatch_truck' | 'reassign_truck' | 'call_driver' | 'escalate_to_dispatcher';
const ACTION = { hold_truck: 'hold', dispatch_truck: 'dispatch', reassign_truck: 'reassign', call_driver: 'call_driver', escalate_to_dispatcher: 'escalate' } as const;

function decide(
  tool: Tool,
  truckIds: string[],
  title: string,
  detail: string,
  reasoning: string,
  src: SourceRef[],
  cost: number,
  args: Record<string, unknown> = {},
  origin: 'agent' | 'mock' | 'chaos' = 'agent',
  model = 'claude-sonnet-5-5',
) {
  emit('tool.gate', {
    toolCallId: `tc-${seq}`,
    tool,
    args: { truck_id: truckIds[0], ...args },
    idempotencyKey: `k${seq.toString(16)}:${Math.floor(sim / (10 * MIN))}`,
    verdict: 'allowed',
    origin,
  });
  decisions += 1;
  emit('agent.decision', { decisionId: `d-${seq}`, action: ACTION[tool], truckIds, title, detail, reasoning, sources: src, costUsd: cost, model, origin });
}

function request(text: string, trigger: string, cost: number) {
  emit('agent.thinking', { text, trigger });
  usage('dispatch', cost * 1.0);
}

// ---------------- calls ----------------
interface CallStep { at: number; run: () => void }
interface ActiveCall { wallStart: number; steps: CallStep[]; live: boolean }
const activeCalls: ActiveCall[] = [];

function utter(callId: string, speaker: 'linea' | 'human', text: string, lang: string, english: string | null, translateDelay = 900): CallStep[] {
  const utteranceId = `${callId}-u${++callSeq}`;
  const steps: CallStep[] = [{ at: 0, run: () => emit('call.transcript', { callId, utteranceId, speaker, text, lang, textEnglish: lang === 'en-US' ? text : null, final: true }) }];
  if (english && lang !== 'en-US') {
    steps.push({
      at: translateDelay,
      run: () => {
        emit('call.transcript', { callId, utteranceId, speaker, text, lang, textEnglish: english, final: true });
        usage('translate', 0.0004);
      },
    });
  }
  return steps;
}
const offset = (base: number, steps: CallStep[]) => steps.map((s) => ({ ...s, at: s.at + base }));

function startCall(steps: CallStep[], live: boolean) {
  calls += 1;
  if (live) {
    speed = 1;
    clockSpeed = 1;
  }
  activeCalls.push({ wallStart: wall, steps: steps.sort((a, b) => a.at - b.at), live });
}

function carlosCall() {
  const callId = 'call-carlos';
  startCall(
    [
      { at: 0, run: () => emit('call.started', { callId, kind: 'driver', truckId: 'T4', personName: 'Carlos', mode: 'live', language: 'es-MX', purpose: 'Learn real queue length at Otay Mesa' }) },
      { at: 900, run: () => emit('call.status', { callId, status: 'ringing' }) },
      { at: 3200, run: () => emit('call.status', { callId, status: 'in_progress' }) },
      ...offset(3300, utter(callId, 'linea', 'Hola Carlos, habla Linea, el despachador automático de Transportes Mesa. Soy una inteligencia artificial. ¿Ya estás en la fila de Otay?', 'es-MX', "Hi Carlos, this is Linea, Transportes Mesa's automated dispatcher. I'm an AI. Are you in the Otay line yet?")),
      ...offset(8800, utter(callId, 'human', 'Sí, estoy como a dos kilómetros, del lado mexicano. Casi no se mueve.', 'es-MX', "Yes, I'm about two kilometers back, on the Mexican side. It's barely moving.")),
      { at: 9900, run: () => usage('voice', 0.0012) },
      {
        at: 10200,
        run: () => {
          emit('call.tool', { callId, tool: 'report_queue_position', args: { port_id: 'otay_mesa', side: 'mx', length_km: 2, extra_wait_min: 60 }, result: 'Queue report saved · +60 min Mexican side' });
          const source: SourceRef = { id: `driver:T4:${hm(sim)}`, kind: 'driver_report', label: `Carlos · Truck 4 · ~2 km Mexican side · ${clockLabel(sim)}`, observedAt: iso(sim) };
          sources.set(source.id, source);
          mxReport = { extra: 60, source };
          emit('queue.report', { portId: 'otay_mesa', side: 'mx', lengthKm: 2, extraWaitMin: 60, reportedBy: 'Truck 4', source });
        },
      },
      ...offset(11200, utter(callId, 'linea', 'Gracias, Carlos. Con eso ajusto el plan para los demás. Buen camino.', 'es-MX', "Thanks, Carlos. I'll adjust the plan for the others with that. Drive safe.")),
      { at: 11300, run: () => usage('voice', 0.0011) },
      {
        at: 15000,
        run: () => {
          emit('call.status', { callId, status: 'completed' });
          emit('call.ended', { callId, kind: 'driver', outcome: 'completed', durationSec: 48, summary: 'Carlos is ~2 km into the Mexican-side queue — about 60 min CBP does not show.', costUsd: 0.09 });
          costUsd += 0.09;
          speed = FAST_SPEED;
          clockSpeed = 60;
          // Re-plan for everyone else with the hidden MX queue now known
          request('Carlos reports ~60 min on the Mexican side — Otay is ~3 h total', 'queue_report: Truck 4', 0.031);
          const drv = mxReport!.source;
          const otay = lastPortSource['otay_mesa:standard']!;
          const tec = lastPortSource['tecate:standard']!;
          get('linea', 'T3').t.port = 'tecate';
          get('linea', 'T3').t.lane = 'standard';
          get('linea', 'T3').departAt = sim;
          decide('dispatch_truck', ['T3'], 'Sending Truck 3 to Tecate now', 'Tecate · standard lane', 'Otay is ~178 min with the Mexican side Carlos reported; Tecate is 25 min. Jorge still makes Chula Vista by 5:30 PM.', [drv, otay, tec, scheduleSource('T3')], 0.016, { port: 'tecate', lane: 'standard' });
        },
      },
    ],
    true,
  );
}

function ivanCall(attempt: number) {
  const callId = `call-ivan-${attempt}`;
  startCall(
    [
      { at: 0, run: () => emit('call.started', { callId, kind: 'driver', truckId: 'T6', personName: 'Iván', mode: 'simulated', language: 'es-MX', purpose: 'Give new departure instruction' }) },
      { at: 800, run: () => emit('call.status', { callId, status: 'ringing' }) },
      { at: 3000, run: () => emit('call.status', { callId, status: 'no_answer' }) },
      {
        at: 3050,
        run: () => {
          emit('call.ended', { callId, kind: 'driver', outcome: 'no_answer', durationSec: 0, summary: 'No answer', costUsd: 0 });
          if (attempt === 2) {
            emit('watchdog.trip', {
              tripId: 'trip-noanswer',
              kind: 'no_answer',
              truckId: 'T6',
              title: "Iván hasn't answered twice",
              detail: '2 missed calls to Truck 6. Stopped calling; asking Ana.',
              evidence: ['3:15 PM no answer', '3:17 PM no answer'],
              response: 'escalated',
            });
          }
        },
      },
    ],
    false,
  );
}

function anaCall() {
  const callId = 'call-ana';
  startCall(
    [
      { at: 0, run: () => emit('call.started', { callId, kind: 'dispatcher', truckId: null, personName: 'Ana', mode: 'live', language: 'en-US', purpose: 'Escalation · 2 issues' }) },
      { at: 900, run: () => emit('call.status', { callId, status: 'ringing' }) },
      { at: 2600, run: () => emit('call.status', { callId, status: 'in_progress' }) },
      ...offset(2700, utter(callId, 'linea', "Hi Ana, it's Linea. Two things need you.", 'en-US', null)),
      ...offset(4800, utter(callId, 'linea', "Pedro's truck keeps flipping between Otay and Tecate because Tecate's feed is flapping, and Iván hasn't answered twice. Should I keep Pedro on Otay?", 'en-US', null)),
      { at: 4900, run: () => usage('voice', 0.0014) },
      ...offset(10200, utter(callId, 'human', "Keep Pedro on Otay. I'll text Iván myself.", 'en-US', null)),
      {
        at: 11200,
        run: () => {
          emit('call.tool', { callId, tool: 'dispatcher_decision', args: { trip_ids: ['trip-osc', 'trip-noanswer'], decision: 'keep_current', note: 'Ana will text Iván' }, result: 'Truck 7 locked on Otay for 30 min' });
          humanTouches = 1;
          emit('watchdog.resolved', { tripId: 'trip-osc', resolution: 'Ana: keep Pedro on Otay — locked until 3:58 PM', by: 'dispatcher' });
          emit('watchdog.resolved', { tripId: 'trip-noanswer', resolution: 'Ana will text Iván herself', by: 'dispatcher' });
          status({ loops: { state: 'ok', detail: 'No loops' } });
        },
      },
      ...offset(12000, utter(callId, 'linea', 'Got it. Pedro stays on Otay, locked for 30 minutes. Thanks, Ana.', 'en-US', null)),
      { at: 12100, run: () => usage('voice', 0.0011) },
      {
        at: 15500,
        run: () => {
          emit('call.status', { callId, status: 'completed' });
          emit('call.ended', { callId, kind: 'dispatcher', outcome: 'completed', durationSec: 42, summary: 'Ana: keep Pedro on Otay; she will text Iván.', costUsd: 0.07 });
          costUsd += 0.07;
          speed = FAST_SPEED;
          clockSpeed = 60;
          scenarioStep = 'normalizing';
        },
      },
    ],
    true,
  );
}

// ---------------- scripted beats (sim time) ----------------
const script: { at: number; run: () => void; done?: boolean }[] = [];
const on = (hhmm: string, run: () => void) => script.push({ at: t(hhmm), run });

function dispatchLinea(id: string, port: PortId, lane: Lane, title: string, reasoning: string, cost: number) {
  const s = get('linea', id);
  s.t.port = port;
  s.t.lane = lane;
  s.departAt = sim;
  decide('dispatch_truck', [id], title, `${port === 'tecate' ? 'Tecate' : 'Otay Mesa'} · ${lane === 'fast' ? 'FAST lane' : 'standard lane'}`, reasoning, [lastPortSource[`${port}:${lane}`]!, scheduleSource(id)], cost, { port, lane });
}
function hold(id: string, until: string, title: string, reasoning: string, cost: number) {
  const s = get('linea', id);
  s.t.heldUntil = iso(t(until));
  s.t.state = 'held';
  s.departAt = t(until);
  s.t.port = 'otay_mesa';
  s.t.lane = 'standard';
  decide('hold_truck', [id], title, `Hold at yard until ${clockLabel(t(until))}`, reasoning, [lastPortSource['otay_mesa:standard']!, ...(mxReport ? [mxReport.source] : []), scheduleSource(id)], cost, { until: clockLabel(t(until)) });
}
function reassign(id: string, port: PortId, title: string, reasoning: string, cost: number, origin: 'agent' | 'chaos' = 'agent') {
  const s = get('linea', id);
  const from = s.t.port === 'tecate' ? 'Tecate' : 'Otay Mesa';
  s.t.port = port;
  s.t.lane = 'standard';
  if (s.t.state === 'en_route' && s.firstLeg?.port === port) {
    // Flipped back to the original port: resume the original leg.
    ({ from: s.legFrom, to: s.legTo, start: s.legStart, end: s.legEnd } = s.firstLeg);
  } else if (s.t.state === 'en_route') {
    s.legFrom = s.t.pos;
    s.legTo = QUEUE[port][0]!;
    s.legStart = sim;
    s.legEnd = sim + travelMin(s.legFrom, s.legTo) * MIN;
  }
  decide('reassign_truck', [id], title, `${from} → ${port === 'tecate' ? 'Tecate' : 'Otay Mesa'} · standard lane`, reasoning, [lastPortSource[`${port}:standard`]!], cost, { port, lane: 'standard' }, origin);
}

on('13:30', () => {
  emit('live.cbp', { portId: 'otay_mesa', lane: 'standard', waitMin: 42, lanesOpen: 6, updateTime: '13:00', fetchedAt: new Date(WALL0).toISOString(), ok: true });
  status();
});
on('13:40', () => {
  request('Truck 1 ready — Otay FAST is 15 min', 'truck_ready: T1', 0.024);
  dispatchLinea('T1', 'otay_mesa', 'fast', 'Sending Truck 1 to Otay Mesa FAST lane', 'FAST is 15 min vs 35 standard. Luis is FAST-eligible with a 4:30 PM jit deadline.', 0.024);
});
on('14:10', () => {
  request('Truck 2 ready — FAST still short', 'truck_ready: T2', 0.021);
  dispatchLinea('T2', 'otay_mesa', 'fast', 'Sending Truck 2 to Otay Mesa FAST lane', 'FAST at 17 min. Rosa is due at the cross-dock by 5:00 PM.', 0.021);
});
on('14:15', () => {
  request('Truck 4 ready', 'truck_ready: T4', 0.02);
  dispatchLinea('T4', 'otay_mesa', 'standard', 'Sending Truck 4 to Otay Mesa standard lane', 'Standard is 45 min and Carlos is not FAST-eligible. Plenty of slack to 5:15 PM.', 0.02);
});
on('14:30', () => {
  request('Truck 5 ready — FAST eligible', 'truck_ready: T5', 0.019);
  dispatchLinea('T5', 'otay_mesa', 'fast', 'Sending Truck 5 to Otay Mesa FAST lane', 'FAST is 18 min vs 45 standard for Marta’s medical load.', 0.019);
});
on('14:50', () => {
  request('Truck 8 produce ready', 'truck_ready: T8', 0.022);
  dispatchLinea('T8', 'otay_mesa', 'standard', 'Sending Truck 8 to Otay Mesa standard lane', 'Standard is 47 min. Produce is due at 5:00 PM, so it should not wait.', 0.022);
});
on('14:55', () => {
  scenarioStep = 'spike';
});
on('14:56', () => {
  request('Otay standard jumped 47 → 118 min — re-planning', 'port_change: otay_mesa standard 47→118', 0.038);
  const share = 0.0095;
  reassign('T8', 'tecate', 'Rerouting Truck 8 produce to Tecate', 'Otay standard jumped to 118 min; Tecate is 25. Produce should not sit in line in the heat.', share);
  hold('T9', '18:30', 'Holding Truck 9 at the yard until 6:30 PM', 'Otay is 118 min now and Raúl’s load is due tomorrow. An hour at the yard beats an hour in line.', share);
  hold('T10', '18:30', 'Holding Truck 10 at the yard until 6:30 PM', 'Same as Truck 9: general load, due tomorrow, Otay at 118 min.', share);
  decide('call_driver', ['T4'], 'Calling Carlos to learn the real line length', 'Call Carlos · learn real queue length', 'CBP shows only the US side. Carlos is already in line and can tell us the Mexican side.', [lastPortSource['otay_mesa:standard']!], share, { goal: 'learn_queue' });
});
on('14:57', () => carlosCall());
on('15:02', () => {
  hold('T6', '15:20', 'Holding Truck 6 at the yard until 3:20 PM', 'Otay is ~178 min with the reported Mexican side. Iván has until 7:00 PM; wait for Tecate to settle.', 0.018);
  request('Holding Truck 6 until Tecate settles', 'truck_ready: T6', 0.018);
});
on('15:15', () => {
  decide('call_driver', ['T6'], 'Calling Iván with a new departure time', 'Call Iván · give new instruction', 'Iván needs to leave at 3:20 PM for Tecate instead of Otay.', [lastPortSource['tecate:standard']!, scheduleSource('T6')], 0.012, { goal: 'give_instruction', instruction: 'Sal a las 3:20 hacia Tecate.' });
  ivanCall(1);
});
on('15:17', () => {
  decide('call_driver', ['T6'], 'Trying Iván again', 'Call Iván · give new instruction', 'First call went unanswered; one retry before escalating.', [lastPortSource['tecate:standard']!, scheduleSource('T6')], 0.011, { goal: 'give_instruction' });
  ivanCall(2);
});
on('15:20', () => {
  scenarioStep = 'oscillation';
  request('Trucks 6 and 7 ready to go', 'hold_expired: T6', 0.026);
  dispatchLinea('T6', 'tecate', 'standard', 'Sending Truck 6 to Tecate', 'Tecate is 15 min vs ~178 at Otay. Iván is due at 7:00 PM.', 0.013);
  dispatchLinea('T7', 'otay_mesa', 'standard', 'Sending Truck 7 to Otay Mesa standard lane', 'Tecate is 95 min on the latest update; Otay 125. Pedro is due at 7:15 PM.', 0.013);
});
on('15:21', () => {
  reassign('T7', 'tecate', 'Moving Truck 7 to Tecate', 'Tecate dropped to 15 min.', 0.017);
  status({ loops: { state: 'ok', detail: 'No loops' } });
});
on('15:23', () => {
  reassign('T7', 'otay_mesa', 'Moving Truck 7 back to Otay Mesa', 'Tecate jumped back to 95 min.', 0.016);
  status({ loops: { state: 'warn', detail: 'Truck 7 changed twice in 15 min' } });
});
on('15:25', () => {
  emit('tool.gate', {
    toolCallId: 'tc-osc-3',
    tool: 'reassign_truck',
    args: { truck_id: 'T7', port: 'tecate', lane: 'standard' },
    idempotencyKey: 'osc3',
    verdict: 'blocked',
    reason: 'Oscillation: 3 changes in 15 min',
    tripKind: 'oscillation',
    origin: 'agent',
  });
  emit('watchdog.trip', {
    tripId: 'trip-osc',
    kind: 'oscillation',
    truckId: 'T7',
    title: 'Truck 7 keeps flipping ports — frozen',
    detail: 'Truck 7 reassigned 3× in 6 min · Blocked · Calling Ana',
    evidence: ['3:21 PM Otay → Tecate (Tecate 15 min)', '3:23 PM Tecate → Otay (Tecate 95 min)', '3:25 PM Otay → Tecate (blocked)'],
    response: 'blocked',
  });
  status({ loops: { state: 'tripped', detail: 'Truck 7 frozen' } });
});
on('15:27', () => {
  decide('escalate_to_dispatcher', ['T7', 'T6'], 'Calling Ana — two things need her', 'Call Ana · 1 question', "Pedro's truck keeps flipping between Otay and Tecate, and Iván hasn't answered twice.", [], 0, {}, 'agent', 'watchdog');
  emit('escalation', { escalationId: 'esc-1', to: 'Ana', tripIds: ['trip-osc', 'trip-noanswer'], summary: "Two things need you. Pedro's truck keeps flipping between Otay and Tecate, and Iván hasn't answered twice. Should I keep Pedro on Otay?", callId: 'call-ana' });
  anaCall();
});
on('18:30', () => {
  request('Otay standard down to 55 min — releasing held trucks', 'hold_expired: T9, T10', 0.03);
  dispatchLinea('T9', 'otay_mesa', 'standard', 'Releasing Truck 9 to Otay Mesa', 'Otay standard is down to 55 min from 125. Raúl’s load is due tomorrow at 10:00 AM.', 0.015);
  dispatchLinea('T10', 'otay_mesa', 'standard', 'Releasing Truck 10 to Otay Mesa', 'Same window as Truck 9: Otay at 55 min.', 0.015);
});

// ---------------- main loop ----------------
let nextMetrics = START;
let nextStatus = START + 10 * MIN;
updatePorts();

while (sim <= END) {
  updatePorts();
  for (const s of script) {
    if (!s.done && sim >= s.at) {
      s.done = true;
      s.run();
    }
  }
  for (const c of activeCalls) {
    while (c.steps.length && wall - c.wallStart >= c.steps[0]!.at) c.steps.shift()!.run();
  }
  for (let i = activeCalls.length - 1; i >= 0; i--) if (!activeCalls[i]!.steps.length) activeCalls.splice(i, 1);

  const dt = TICK_WALL_MS * speed;
  for (const p of ['linea', 'baseline'] as const) for (const s of fleets[p]) step(s, sim, dt, p === 'linea' && !!mxReport);

  const clock: SimClock = { simTime: iso(sim), speed: clockSpeed, paused: false, mode: 'replay', scenarioStep };
  const view = (policy: 'linea' | 'baseline'): WorldView => ({ policy, simTime: iso(sim), trucks: fleets[policy].map((s) => ({ ...s.t })), ports: portStatus(policy) });
  emit('world.tick', { linea: view('linea'), baseline: view('baseline'), clock });

  if (sim >= nextMetrics) {
    nextMetrics += 5 * MIN;
    const linea = metrics('linea');
    const baseline = metrics('baseline');
    emit('metrics.update', { linea, baseline, point: { t: iso(sim), linea: linea.truckHoursInLine, baseline: baseline.truckHoursInLine } });
  }
  if (sim >= nextStatus) {
    nextStatus += 10 * MIN;
    const delay = Math.round(fleets.linea.reduce((a, s) => a + Math.max(0, (Date.parse(s.t.etaDelivery ?? s.t.deadline) - Date.parse(s.t.deadline)) / MIN), 0));
    status({ progress: { state: 'ok', fleetDelayMin: delay, trend: 'improving' } });
  }

  wall += TICK_WALL_MS;
  sim += dt;
}

const text = out.join('\n') + '\n';
// web/public/fixtures is a symlink to /fixtures, so one write serves both the repo and Vite.
const dir = path.resolve(here, '../../fixtures');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'mock-events.jsonl'), text);
const final = { linea: metrics('linea'), baseline: metrics('baseline') };
console.log(`wrote ${out.length} events, ${(text.length / 1e6).toFixed(1)} MB, ${(wall / 1000).toFixed(0)} s`);
console.log('linea', final.linea);
console.log('baseline', final.baseline);
