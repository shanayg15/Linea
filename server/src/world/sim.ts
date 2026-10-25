// §A5: two independent worlds (linea, baseline) driven by the same scenario, 4 Hz wall ticks.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';
import type {
  Truck, PortId, Lane, Policy, SourceRef, WorldView, PortStatus, SimClock, LngLat, ControlCmd, MetricsPoint, Metrics,
} from '../../../shared/types';
import { PLACES, routeKey, type PlaceKey, type RoutesFile } from '../../../shared/geo';
import type { WorldApi, WorldAction, OptionScore, Agent } from './api';
import type { Bus } from '../server/bus';
import { Clock, MIN, SIM_START, SIM_END, TICK_MS, toIsoPT, parseIso, hhmm, clockLabel, mulberry32, asSpeed, atPT, type Speed } from './clock';
import { FLEET, Scenario, SPIKE_AT, type TruckSpec, type ScenarioStep } from './scenario';
import { lengthKm, pointAlong, slicePath, lastKm, nearestIndex, haversineKm, downsample, roundPos } from './geo';
import { scoreOptionsFor, type OptimizerCtx } from './optimizer';
import { computeMetrics, LineaCounters, zeroCounters } from './metrics';

/** Trucks are slower than OSRM's car profile. */
export const TRUCK_FACTOR = 1.15;
const DECISION_TIMEOUT_MS = 10 * MIN;
const HEARTBEAT_MS = 20 * MIN;
const METRICS_MS = 5 * MIN;
const MX_REPORT_TTL_MS = 60 * MIN;
const PORT_UPDATE_DELTA = 5;
const PORT_CHANGE_TRIGGER = 15;

const PORT_KEY: Record<PortId, PlaceKey> = { otay_mesa: 'port_otay_mesa', tecate: 'port_tecate' };
const PORT_LABEL: Record<PortId, string> = { otay_mesa: 'Otay Mesa', tecate: 'Tecate' };
const LANES_OPEN: Record<PortId, Record<Lane, number | null>> = {
  otay_mesa: { standard: 8, fast: 3 },
  tecate: { standard: 3, fast: null },
};
const PORT_LANES: [PortId, Lane][] = [['otay_mesa', 'standard'], ['otay_mesa', 'fast'], ['tecate', 'standard']];

// ---------- static geometry ----------
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROUTES = JSON.parse(readFileSync(join(ROOT, 'shared', 'routes.json'), 'utf8')) as RoutesFile;

function route(from: PlaceKey, to: PlaceKey) {
  const r = ROUTES[routeKey(from, to)];
  if (!r) throw new Error(`missing route ${from} → ${to}`);
  return r;
}

interface Leg { path: LngLat[]; km: number; durMin: number }

const QUEUE: Record<PortId, { path: LngLat[]; mx: LngLat[]; us: LngLat[]; render: LngLat[] }> = (() => {
  const mk = (path: LngLat[]) => ({
    path,
    mx: slicePath(path, 0, 0.7),
    us: slicePath(path, 0.7, 1),
    render: downsample(path, 32).map(roundPos),
  });
  return {
    otay_mesa: mk(lastKm(route('yard_el_florido', 'port_otay_mesa').coords, 3.0)),
    tecate: mk(lastKm(route('yard_el_florido', 'port_tecate').coords, 1.5)),
  };
})();

const approachCache = new Map<string, Leg>();
/** origin → queue tail of port (route trimmed where it meets the queue, then joined to the tail). */
function approach(origin: PlaceKey, port: PortId): Leg {
  const key = `${origin}|${port}`;
  let leg = approachCache.get(key);
  if (!leg) {
    const r = route(origin, PORT_KEY[port]);
    const tail = QUEUE[port].path[0];
    const idx = nearestIndex(r.coords, tail);
    const path = [...r.coords.slice(0, Math.max(1, idx)), tail];
    // Full route duration even though the path stops at the queue tail: the last stretch is a crawl.
    leg = { path, km: lengthKm(path), durMin: Math.max(1, (r.durationS / 60) * TRUCK_FACTOR) };
    approachCache.set(key, leg);
  }
  return leg;
}

function post(port: PortId, dest: PlaceKey): Leg {
  const r = route(PORT_KEY[port], dest);
  return { path: r.coords, km: lengthKm(r.coords), durMin: (r.durationS / 60) * TRUCK_FACTOR };
}

// ---------- per-truck sim state ----------
interface SimTruck {
  t: Truck;
  spec: TruckSpec;
  jitter: number;
  path: LngLat[];
  pathKm: number;
  progKm: number;
  kmPerMin: number;
  queueStart: number;
  mxEnd: number;
  usEnd: number;
  readyFired: boolean;
  awaitingSince: number | null;
}

interface MxKnowledge { min: number; source: SourceRef | null; expiresAt: number }

class PolicyWorld {
  trucks: SimTruck[];
  mx: Record<PortId, MxKnowledge> = {
    otay_mesa: { min: 0, source: null, expiresAt: 0 },
    tecate: { min: 0, source: null, expiresAt: 0 },
  };
  constructor(readonly policy: Policy, jitters: number[]) {
    this.trucks = FLEET.map((spec, i) => makeTruck(spec, jitters[i]));
  }
  get(id: string): SimTruck | undefined {
    return this.trucks.find((s) => s.t.id === id);
  }
}

function makeTruck(spec: TruckSpec, jitter: number): SimTruck {
  const o = PLACES[spec.origin], d = PLACES[spec.destination];
  return {
    spec,
    jitter,
    path: [],
    pathKm: 0,
    progKm: 0,
    kmPerMin: 0,
    queueStart: 0,
    mxEnd: 0,
    usEnd: 0,
    readyFired: false,
    awaitingSince: null,
    t: {
      id: spec.id,
      driverName: spec.driverName,
      cargo: spec.cargo,
      priority: spec.priority,
      fastEligible: spec.fastEligible,
      readyAt: toIsoPT(spec.readyAt),
      deadline: toIsoPT(spec.deadline),
      origin: { name: o.name, pos: o.pos },
      destination: { name: d.name, pos: d.pos },
      state: 'at_yard',
      pos: o.pos,
      heading: 0,
      port: null,
      lane: null,
      heldUntil: null,
      queueEnteredAt: null,
      crossedAt: null,
      deliveredAt: null,
      minutesInLine: 0,
      etaDelivery: null,
      phoneMode: spec.phoneMode,
    },
  };
}

const truckNum = (id: string) => id.replace(/^T/, '');

// ---------- the world ----------
export class World implements WorldApi {
  readonly clock: Clock;
  readonly scenario = new Scenario();
  private agent: Agent | null = null;
  private worlds!: Record<Policy, PolicyWorld>;
  private cbpState!: Record<PortId, Record<Lane, { value: number | null; source: SourceRef }>>;
  private optimizerSources = new Map<string, SourceRef>();
  /** Every CBP reading and driver report this run, so older ids the agent cites still resolve. */
  private sourceHistory = new Map<string, SourceRef>();
  private readonly counters = new LineaCounters();
  series: MetricsPoint[] = [];
  done = false;
  private timer: NodeJS.Timeout | null = null;
  private inStep = false;
  /** True during jumpTo(): agent triggers are skipped and ready trucks take the optimizer's best option directly. */
  private fastForwarding = false;
  private pendingTriggers: [string, Record<string, unknown> | undefined][] = [];
  private lastHeartbeatSlot = 0;
  private lastMetricsSlot = 0;
  private lastStep: ScenarioStep = 'calm';

  constructor(readonly bus: Bus, private readonly seed: number, speed: Speed) {
    this.clock = new Clock(speed);
    this.counters.attach(bus);
    bus.on((e) => {
      if (e.type === 'call.ended') this.fire('call_ended', { callId: e.payload.callId, kind: e.payload.kind, outcome: e.payload.outcome, summary: e.payload.summary });
      else if (e.type === 'watchdog.resolved') this.fire('trip_resolved', { tripId: e.payload.tripId, resolution: e.payload.resolution, by: e.payload.by });
    });
    this.build();
  }

  private build(): void {
    const rng = mulberry32(this.seed);
    const jitters = FLEET.map(() => 1 + (rng() * 2 - 1) * 0.05);
    this.worlds = { linea: new PolicyWorld('linea', jitters), baseline: new PolicyWorld('baseline', jitters) };
    const t0 = this.clock.simMs;
    const src = (port: PortId, lane: Lane, v: number | null): SourceRef =>
      v === null
        ? { id: `cbp:${port}:${lane}:none`, kind: 'cbp_replay', label: `CBP · ${PORT_LABEL[port]} · no FAST lane`, observedAt: toIsoPT(t0) }
        : this.cbpSource(port, lane, v, t0);
    this.cbpState = {
      otay_mesa: {
        standard: { value: null, source: src('otay_mesa', 'standard', 0) },
        fast: { value: null, source: src('otay_mesa', 'fast', 0) },
      },
      tecate: {
        standard: { value: null, source: src('tecate', 'standard', 0) },
        fast: { value: null, source: src('tecate', 'fast', null) },
      },
    };
    this.optimizerSources.clear();
    this.sourceHistory.clear();
    this.series = [];
    this.done = false;
    this.lastHeartbeatSlot = 0;
    this.lastMetricsSlot = 0;
    this.lastStep = 'calm';
  }

  setAgent(agent: Agent): void {
    this.agent = agent;
  }

  // ---------- lifecycle ----------
  start(): void {
    this.emitPortUpdates(this.clock.simMs, true);
    this.emitMetrics();
    this.emitControl('start');
    this.timer = setInterval(() => this.tickOnce(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tickOnce(): void {
    try {
      const dt = this.clock.stepMs();
      if (dt > 0 && !this.done) this.step(Math.min(SIM_END, this.clock.simMs + dt));
    } catch (err) {
      console.error('[sim] step error', err);
    }
    try {
      this.bus.emit('world.tick', { linea: this.view('linea'), baseline: this.view('baseline'), clock: this.clockState() });
    } catch (err) {
      console.error('[sim] tick emit error', err);
    }
  }

  private step(t1: number): void {
    const t0 = this.clock.simMs;
    this.inStep = true;
    try {
      this.clock.simMs = t1;
      if (!this.scenario.spikeFired && t1 >= SPIKE_AT) this.scenario.fireSpike(SPIKE_AT);
      this.emitPortUpdates(t1, false);
      this.expireReports(t1);
      for (const w of [this.worlds.baseline, this.worlds.linea]) {
        for (const s of w.trucks) {
          try {
            this.stepTruck(w, s, t0, t1);
          } catch (err) {
            console.error(`[sim] truck ${s.t.id} (${w.policy}) error`, err);
          }
        }
      }
      const hb = Math.floor((t1 - SIM_START) / HEARTBEAT_MS);
      if (hb > this.lastHeartbeatSlot) {
        this.lastHeartbeatSlot = hb;
        this.fire('heartbeat', { simTime: toIsoPT(t1) });
      }
      const ms = Math.floor((t1 - SIM_START) / METRICS_MS);
      if (ms > this.lastMetricsSlot) {
        this.lastMetricsSlot = ms;
        this.emitMetrics();
      }
      const stepName = this.scenario.step(t1, false);
      if (stepName !== this.lastStep) {
        this.lastStep = stepName;
        this.emitControl(`scenario: ${stepName}`);
      }
    } finally {
      this.inStep = false;
    }
    this.flushTriggers();
    if (t1 >= SIM_END && !this.done) {
      this.done = true;
      this.clock.paused = true;
      this.lastStep = 'done';
      this.emitMetrics();
      this.emitControl('shift complete');
    }
  }

  private stepTruck(w: PolicyWorld, s: SimTruck, t0: number, t1: number): void {
    const tr = s.t;
    if (tr.state === 'held' && tr.heldUntil && t1 >= parseIso(tr.heldUntil)) {
      tr.state = 'at_yard';
      tr.heldUntil = null;
      if (s.readyFired && w.policy === 'linea') {
        if (this.fastForwarding) this.autoPlan(s);
        else {
          s.awaitingSince = t1;
          this.fire('hold_expired', { truckId: tr.id });
        }
      }
    }
    if (tr.state === 'at_yard' && !s.readyFired && t1 >= s.spec.readyAt) {
      s.readyFired = true;
      if (w.policy === 'baseline') {
        this.dispatch(s, 'otay_mesa', tr.fastEligible ? 'fast' : 'standard');
      } else if (this.fastForwarding) {
        this.autoPlan(s);
      } else {
        s.awaitingSince = t1;
        this.fire('truck_ready', { truckId: tr.id });
      }
    }
    if (w.policy === 'linea' && tr.state === 'at_yard' && s.awaitingSince !== null && t1 >= s.awaitingSince + DECISION_TIMEOUT_MS) {
      this.timeoutFallback(s);
    }
    this.advance(w, s, t0, t1);
    this.place(s, t1);
    tr.etaDelivery = this.eta(w, s, t1);
  }

  /** Move a truck from t0 to t1, handling state transitions at their exact times. */
  private advance(w: PolicyWorld, s: SimTruck, t0: number, t1: number): void {
    const tr = s.t;
    let t = t0;
    for (let guard = 0; guard < 10 && t < t1; guard++) {
      if (tr.state === 'en_route' || tr.state === 'crossed') {
        const remain = s.pathKm - s.progKm;
        const tArrive = s.kmPerMin > 0 ? t + (remain / s.kmPerMin) * MIN : t;
        if (tArrive <= t1) {
          s.progKm = s.pathKm;
          t = Math.max(t, tArrive);
          if (tr.state === 'en_route') this.enterQueue(s, t);
          else {
            tr.state = 'delivered';
            tr.deliveredAt = toIsoPT(t);
          }
        } else {
          s.progKm += (s.kmPerMin * (t1 - t)) / MIN;
          t = t1;
        }
      } else if (tr.state === 'in_queue_mx') {
        if (s.mxEnd <= t1) { tr.state = 'in_queue_us'; t = Math.max(t, s.mxEnd); } else t = t1;
      } else if (tr.state === 'in_queue_us') {
        if (s.usEnd <= t1) { this.cross(s, Math.max(t, s.usEnd)); t = Math.max(t, s.usEnd); } else t = t1;
      } else break;
    }
    if (tr.state === 'in_queue_mx' || tr.state === 'in_queue_us') {
      tr.minutesInLine = round1((t1 - s.queueStart) / MIN);
    } else if (tr.queueEnteredAt) {
      tr.minutesInLine = round1((s.usEnd - s.queueStart) / MIN);
    }
    void w;
  }

  private enterQueue(s: SimTruck, t: number): void {
    const tr = s.t;
    const port = tr.port as PortId;
    const lane = (tr.lane ?? 'standard') as Lane;
    const usMin = this.scenario.truthUS(port, lane, t);
    const mxMin = this.scenario.truthMX(port, t);
    s.queueStart = t;
    s.mxEnd = t + mxMin * MIN;
    s.usEnd = s.mxEnd + usMin * MIN;
    tr.queueEnteredAt = toIsoPT(t);
    tr.state = mxMin > 0 ? 'in_queue_mx' : 'in_queue_us';
  }

  private cross(s: SimTruck, t: number): void {
    const tr = s.t;
    const leg = post(tr.port as PortId, s.spec.destination);
    tr.state = 'crossed';
    tr.crossedAt = toIsoPT(t);
    s.path = leg.path;
    s.pathKm = leg.km;
    s.progKm = 0;
    s.kmPerMin = leg.km / (leg.durMin * s.jitter);
  }

  private place(s: SimTruck, t: number): void {
    const tr = s.t;
    let p: { pos: LngLat; heading: number };
    switch (tr.state) {
      case 'en_route':
      case 'crossed':
        p = pointAlong(s.path, s.pathKm > 0 ? s.progKm / s.pathKm : 1);
        break;
      case 'in_queue_mx': {
        const q = QUEUE[tr.port as PortId];
        p = pointAlong(q.mx, s.mxEnd > s.queueStart ? (t - s.queueStart) / (s.mxEnd - s.queueStart) : 1);
        break;
      }
      case 'in_queue_us': {
        const q = QUEUE[tr.port as PortId];
        p = pointAlong(q.us, s.usEnd > s.mxEnd ? (t - s.mxEnd) / (s.usEnd - s.mxEnd) : 1);
        break;
      }
      case 'delivered':
        p = { pos: PLACES[s.spec.destination].pos, heading: tr.heading };
        break;
      default:
        p = { pos: PLACES[s.spec.origin].pos, heading: 0 };
    }
    tr.pos = roundPos(p.pos);
    tr.heading = Math.round(p.heading);
  }

  /** Point estimate of delivery time (CBP + known MX for linea; CBP only for baseline). */
  private eta(w: PolicyWorld, s: SimTruck, t: number): string | null {
    const tr = s.t;
    switch (tr.state) {
      case 'delivered': return tr.deliveredAt;
      case 'crossed': return toIsoPT(t + ((s.pathKm - s.progKm) / s.kmPerMin) * MIN);
      case 'in_queue_mx':
      case 'in_queue_us': return toIsoPT(s.usEnd + post(tr.port as PortId, s.spec.destination).durMin * s.jitter * MIN);
      default: {
        const port: PortId = tr.port ?? 'otay_mesa';
        const lane: Lane = tr.lane ?? (tr.fastEligible && port === 'otay_mesa' ? 'fast' : 'standard');
        const depart = tr.state === 'en_route' ? t : Math.max(t, s.spec.readyAt, tr.heldUntil ? parseIso(tr.heldUntil) : 0);
        const drive = tr.state === 'en_route' ? ((s.pathKm - s.progKm) / s.kmPerMin) : approach(s.spec.origin, port).durMin * s.jitter;
        const line = (this.cbpState[port][lane].value ?? 0) + (w.policy === 'linea' ? w.mx[port].min : 0);
        return toIsoPT(depart + (drive + line + post(port, s.spec.destination).durMin * s.jitter) * MIN);
      }
    }
  }

  private dispatch(s: SimTruck, port: PortId, lane: Lane): void {
    const tr = s.t;
    const leg = approach(s.spec.origin, port);
    tr.state = 'en_route';
    tr.port = port;
    tr.lane = lane;
    tr.heldUntil = null;
    s.awaitingSince = null;
    s.path = leg.path;
    s.pathKm = leg.km;
    s.progKm = 0;
    s.kmPerMin = leg.km / (leg.durMin * s.jitter);
  }

  private reroute(s: SimTruck, port: PortId, lane: Lane): void {
    const tr = s.t;
    const leg = approach(s.spec.origin, port);
    const idx = nearestIndex(leg.path, tr.pos);
    const path: LngLat[] = [tr.pos, ...leg.path.slice(idx)];
    tr.port = port;
    tr.lane = lane;
    s.path = path;
    s.pathKm = lengthKm(path);
    s.progKm = 0;
    s.kmPerMin = leg.km / (leg.durMin * s.jitter);
  }

  /** Fast-forward planning: take the optimizer's best option without asking the agent (no decision events). */
  private autoPlan(s: SimTruck): void {
    const best = this.scoreOptions(s.t.id)[0];
    if (!best) return;
    if (best.option === 'go_now') this.applyAction({ kind: 'dispatch', truckId: s.t.id, port: best.port, lane: best.lane });
    else this.applyAction({ kind: 'hold', truckId: s.t.id, until: best.departAt });
  }

  /** Run the sim straight to `target` (same 15-sim-second steps as 60×), then pause. Used for demo prep. */
  jumpTo(target: number): void {
    if (target <= this.clock.simMs || this.done) return;
    this.fastForwarding = true;
    try {
      const stepMs = 60 * TICK_MS;
      while (this.clock.simMs < target && !this.done) this.step(Math.min(target, this.clock.simMs + stepMs));
    } finally {
      this.fastForwarding = false;
      this.pendingTriggers = [];
    }
    this.clock.paused = true;
    this.emitControl(`jumped to ${clockLabel(this.clock.simMs)}`);
  }

  private timeoutFallback(s: SimTruck): void {
    const best = this.scoreOptions(s.t.id)[0];
    if (!best) return;
    const go = best.option === 'go_now';
    const res = go
      ? this.applyAction({ kind: 'dispatch', truckId: s.t.id, port: best.port, lane: best.lane })
      : this.applyAction({ kind: 'hold', truckId: s.t.id, until: best.departAt });
    if (!res.ok) {
      console.warn(`[sim] timeout fallback for ${s.t.id} failed: ${res.message}`);
      s.awaitingSince = null;
      return;
    }
    const n = truckNum(s.t.id);
    this.bus.emit('agent.decision', {
      decisionId: ulid(),
      action: go ? 'dispatch' : 'hold',
      truckIds: [s.t.id],
      title: go ? `Auto-dispatched Truck ${n} (agent timeout)` : `Auto-held Truck ${n} until ${clockLabel(parseIso(best.departAt))} (agent timeout)`,
      detail: `No agent decision within 10 sim-min. Safety net applied the optimizer's best option.`,
      reasoning: best.explanation,
      sources: this.resolveSources(best.sourceIds),
      costUsd: 0,
      model: 'fallback',
      origin: 'mock',
    });
    console.warn(`[sim] agent timeout fallback fired for ${s.t.id}`);
  }

  // ---------- CBP / port updates ----------
  private cbpSource(port: PortId, lane: Lane, v: number, t: number): SourceRef {
    return {
      id: `cbp:${port}:${lane}:${hhmm(t)}`,
      kind: 'cbp_replay',
      label: `CBP · ${PORT_LABEL[port]} ${lane === 'fast' ? 'FAST' : 'standard'} · ${v} min · ${clockLabel(t)}`,
      observedAt: toIsoPT(t),
    };
  }

  private emitPortUpdates(t: number, force: boolean): void {
    for (const [port, lane] of PORT_LANES) {
      const raw = this.scenario.cbpUS(port, lane, t);
      if (raw === null) continue;
      const v = Math.round(raw);
      const st = this.cbpState[port][lane];
      const prev = st.value;
      const spikeNow = port === 'otay_mesa' && this.scenario.spikeFiredAt !== null && st.source.observedAt < toIsoPT(this.scenario.spikeFiredAt) && t >= this.scenario.spikeFiredAt;
      if (!force && !spikeNow && prev !== null && Math.abs(v - prev) < PORT_UPDATE_DELTA) continue;
      st.value = v;
      st.source = this.cbpSource(port, lane, v, t);
      this.sourceHistory.set(st.source.id, st.source);
      this.bus.emit('port.update', { portId: port, lane, waitMin: v, prevWaitMin: prev, source: st.source });
      if (prev !== null && Math.abs(v - prev) >= PORT_CHANGE_TRIGGER) {
        this.fire('port_change', { portId: port, lane, waitMin: v, prevWaitMin: prev, sourceId: st.source.id });
      }
    }
  }

  private expireReports(t: number): void {
    const mx = this.worlds.linea.mx;
    for (const p of ['otay_mesa', 'tecate'] as PortId[]) {
      if (mx[p].min > 0 && t >= mx[p].expiresAt) mx[p] = { min: 0, source: null, expiresAt: 0 };
    }
  }

  // ---------- triggers ----------
  private fire(reason: string, detail?: Record<string, unknown>): void {
    if (this.fastForwarding) return;
    if (this.inStep) {
      this.pendingTriggers.push([reason, detail]);
      return;
    }
    this.callAgent(reason, detail);
  }

  private flushTriggers(): void {
    const list = this.pendingTriggers;
    this.pendingTriggers = [];
    for (const [r, d] of list) this.callAgent(r, d);
  }

  private callAgent(reason: string, detail?: Record<string, unknown>): void {
    if (!this.agent) return;
    try {
      this.agent.trigger(reason, detail);
    } catch (err) {
      console.error(`[sim] agent.trigger(${reason}) threw`, err);
    }
  }

  // ---------- metrics / clock events ----------
  metrics(): { linea: Metrics; baseline: Metrics } {
    return {
      linea: computeMetrics(this.worlds.linea.trucks.map((s) => s.t), this.counters.c),
      baseline: computeMetrics(this.worlds.baseline.trucks.map((s) => s.t), zeroCounters()),
    };
  }

  private emitMetrics(): void {
    const m = this.metrics();
    const point: MetricsPoint = { t: this.now(), linea: m.linea.truckHoursInLine, baseline: m.baseline.truckHoursInLine };
    this.series.push(point);
    this.bus.emit('metrics.update', { linea: m.linea, baseline: m.baseline, point });
  }

  clockState(): SimClock {
    return {
      simTime: this.now(),
      speed: this.clock.speed,
      paused: this.clock.paused,
      mode: 'live',
      scenarioStep: this.done ? 'done' : this.scenario.step(this.clock.simMs, false),
    };
  }

  private emitControl(note?: string): void {
    this.bus.emit('sim.control', { ...this.clockState(), ...(note ? { note } : {}) });
  }

  /** A's half of POST /control. Agent-bound commands are forwarded by the caller. */
  control(cmd: ControlCmd): void {
    const t = this.clock.simMs;
    switch (cmd.cmd) {
      case 'pause': this.clock.paused = true; this.emitControl('paused'); break;
      case 'play':
        if (!this.done) this.clock.paused = false;
        this.emitControl(this.done ? 'shift already complete — reset to replay' : 'playing');
        break;
      case 'speed': this.clock.setSpeed(asSpeed(cmd.value, this.clock.speed)); this.emitControl(`speed ${this.clock.speed}×`); break;
      case 'inject_spike':
        if (this.scenario.fireSpike(t)) {
          this.inStep = true;
          try { this.emitPortUpdates(t, false); } finally { this.inStep = false; }
          this.flushTriggers();
          this.emitControl('spike injected');
        } else this.emitControl('spike already fired');
        break;
      case 'inject_missed_call': this.scenario.flags.missed_call_T6 = true; this.emitControl('missed call armed for Truck 6'); break;
      case 'chaos_flip':
      case 'inject_oscillation':
        // The chaos test (Shift+O) flips Truck 7 through the watchdog; the flapping Tecate feed is why it would.
        this.scenario.injectOscillation(t);
        this.inStep = true;
        try { this.emitPortUpdates(t, false); } finally { this.inStep = false; }
        this.flushTriggers();
        this.emitControl(cmd.cmd === 'chaos_flip' ? 'chaos test: Tecate feed flapping' : 'oscillation injected');
        break;
      case 'jump': {
        const to = /^\d{1,2}:\d{2}$/.test(String(cmd.to)) ? atPT(String(cmd.to).padStart(5, '0')) : NaN;
        if (Number.isFinite(to)) this.jumpTo(to);
        else this.emitControl(`jump: bad time ${String(cmd.to)}`);
        break;
      }
      case 'reset':
        this.clock.reset();
        this.scenario.reset();
        this.counters.reset();
        this.pendingTriggers = [];
        this.build();
        this.bus.clearRing();
        this.emitControl('reset');
        this.emitPortUpdates(this.clock.simMs, true);
        this.emitMetrics();
        break;
      default: this.emitControl(cmd.cmd); break;
    }
  }

  // ---------- WorldApi ----------
  now(): string {
    return toIsoPT(this.clock.simMs);
  }

  view(policy: Policy = 'linea'): WorldView {
    const w = this.worlds[policy];
    return {
      policy,
      simTime: this.now(),
      trucks: w.trucks.map((s) => ({ ...s.t, pos: [s.t.pos[0], s.t.pos[1]] as LngLat })),
      ports: (['otay_mesa', 'tecate'] as PortId[]).map((p) => this.portStatus(w, p)),
    };
  }

  private portStatus(w: PolicyWorld, p: PortId): PortStatus {
    const lane = (l: Lane) => ({
      waitMin: this.cbpState[p][l].value,
      lanesOpen: this.cbpState[p][l].value === null ? null : LANES_OPEN[p][l],
      source: this.cbpState[p][l].source,
    });
    const mx = w.policy === 'linea' ? w.mx[p] : { min: 0, source: null };
    return {
      id: p,
      name: PORT_LABEL[p],
      pos: PLACES[PORT_KEY[p]].pos,
      standard: lane('standard'),
      fast: lane('fast'),
      mxSideExtraMin: mx.min,
      mxSideSource: mx.source,
      queuePath: QUEUE[p].render,
    };
  }

  getTruck(id: string): Truck | undefined {
    const s = this.worlds.linea.get(id);
    return s ? { ...s.t } : undefined;
  }

  private optimizerCtx(): OptimizerCtx {
    const w = this.worlds.linea;
    return {
      now: this.clock.simMs,
      scenario: this.scenario,
      cbp: (port, lane) => {
        const st = this.cbpState[port][lane === 'fast' && port === 'tecate' ? 'standard' : lane];
        return { value: st.value ?? 0, sourceId: st.source.id };
      },
      knownMx: (port) => ({ min: w.mx[port].min, sourceId: w.mx[port].source?.id ?? null }),
      driveToPortMin: (id, port) => this.driveToPortMin(w, id, port),
      postPortMin: (id, port) => {
        const s = w.get(id);
        return s ? post(port, s.spec.destination).durMin : 0;
      },
    };
  }

  /** Nominal (no jitter) drive minutes from the truck's current position to the port's queue tail. */
  private driveToPortMin(w: PolicyWorld, id: string, port: PortId): number {
    const s = w.get(id);
    if (!s) return 0;
    const leg = approach(s.spec.origin, port);
    if (s.t.state !== 'en_route') return leg.durMin;
    const speed = leg.km / leg.durMin;
    if (s.t.port === port) return (s.pathKm - s.progKm) / (s.pathKm > 0 ? s.kmPerMin * s.jitter : speed);
    const idx = nearestIndex(leg.path, s.t.pos);
    const remainKm = haversineKm(s.t.pos, leg.path[idx]) + lengthKm(leg.path.slice(idx));
    return remainKm / speed;
  }

  scoreOptions(truckId: string): OptionScore[] {
    const s = this.worlds.linea.get(truckId);
    if (!s) return [];
    const opts = scoreOptionsFor(this.optimizerCtx(), s.t);
    const best = opts[0];
    if (best) {
      this.optimizerSources.set(truckId, {
        id: `optimizer:${truckId}`,
        kind: 'optimizer',
        label: `Optimizer · Truck ${truckNum(truckId)} · best: ${best.explanation}`,
        observedAt: this.now(),
      });
    }
    return opts;
  }

  projectFleetDelayMin(): number {
    const w = this.worlds.linea;
    const ctx = this.optimizerCtx();
    const t = this.clock.simMs;
    let total = 0;
    for (const s of w.trucks) {
      const tr = s.t;
      if (tr.state === 'delivered') continue;
      if (tr.state === 'in_queue_mx' || tr.state === 'in_queue_us') {
        total += tr.minutesInLine + Math.max(0, (s.usEnd - t) / MIN);
      } else if (tr.state === 'crossed') {
        const late = tr.etaDelivery ? Math.max(0, (parseIso(tr.etaDelivery) - parseIso(tr.deadline)) / MIN) : 0;
        total += tr.minutesInLine + late;
      } else {
        const best = scoreOptionsFor(ctx, tr)[0];
        total += tr.minutesInLine + (best ? best.expectedLineMin + best.lateMin : 0);
      }
    }
    return Math.round(total);
  }

  private resolveSources(ids: string[]): SourceRef[] {
    const all = this.sources();
    return ids.map((id) => all.find((s) => s.id === id)).filter((s): s is SourceRef => !!s);
  }

  sources(): SourceRef[] {
    const out: SourceRef[] = [];
    for (const [port, lane] of PORT_LANES) out.push(this.cbpState[port][lane].source);
    for (const p of ['otay_mesa', 'tecate'] as PortId[]) {
      const src = this.worlds.linea.mx[p].source;
      if (src) out.push(src);
    }
    for (const s of this.worlds.linea.trucks) {
      out.push({
        id: `schedule:${s.t.id}`,
        kind: 'schedule',
        label: `Schedule · Truck ${truckNum(s.t.id)} due ${clockLabel(s.spec.deadline)}`,
        observedAt: toIsoPT(SIM_START),
      });
    }
    out.push(...this.optimizerSources.values());
    const seen = new Set(out.map((s) => s.id));
    for (const s of this.sourceHistory.values()) if (!seen.has(s.id)) out.push(s);
    return out;
  }

  applyAction(a: WorldAction): { ok: boolean; message: string } {
    const s = this.worlds.linea.get(a.truckId);
    if (!s) return { ok: false, message: `Unknown truck ${a.truckId}` };
    const tr = s.t;
    const n = truckNum(tr.id);
    const t = this.clock.simMs;
    const inLine = tr.state === 'in_queue_mx' || tr.state === 'in_queue_us';
    const gone = tr.state === 'crossed' || tr.state === 'delivered';
    if (a.kind !== 'hold') {
      if (a.port !== 'otay_mesa' && a.port !== 'tecate') return { ok: false, message: `Unknown port ${String(a.port)}` };
      if (a.lane === 'fast' && a.port === 'tecate') return { ok: false, message: 'Tecate has no FAST lane' };
      if (a.lane === 'fast' && !tr.fastEligible) return { ok: false, message: `Truck ${n} is not FAST-eligible` };
      if (a.lane !== 'fast' && a.lane !== 'standard') return { ok: false, message: `Unknown lane ${String(a.lane)}` };
    }
    switch (a.kind) {
      case 'hold': {
        const until = parseIso(a.until);
        if (!Number.isFinite(until)) return { ok: false, message: `Bad time ${a.until}` };
        if (until <= t) return { ok: false, message: 'Hold time is in the past' };
        if (tr.state !== 'at_yard' && tr.state !== 'held') return { ok: false, message: inLine ? 'Truck is already in line' : gone ? 'Truck already crossed' : 'Truck already left the yard' };
        tr.state = 'held';
        tr.heldUntil = toIsoPT(until);
        s.awaitingSince = null;
        return { ok: true, message: `Truck ${n} held until ${clockLabel(until)}` };
      }
      case 'dispatch': {
        if (tr.state !== 'at_yard' && tr.state !== 'held') return { ok: false, message: inLine ? 'Truck is already in line' : gone ? 'Truck already crossed' : 'Truck already left the yard' };
        if (t < s.spec.readyAt) return { ok: false, message: `Truck ${n} is not loaded until ${clockLabel(s.spec.readyAt)}` };
        this.dispatch(s, a.port, a.lane);
        this.place(s, t);
        return { ok: true, message: `Truck ${n} dispatched to ${PORT_LABEL[a.port]} ${a.lane}` };
      }
      case 'reassign': {
        if (inLine) return { ok: false, message: 'Truck is already in line' };
        if (gone) return { ok: false, message: 'Truck already crossed' };
        if (tr.port === a.port && tr.lane === a.lane) return { ok: true, message: 'No change' };
        if (tr.state === 'en_route') {
          if (tr.port === a.port) tr.lane = a.lane;
          else this.reroute(s, a.port, a.lane);
        } else {
          tr.port = a.port;
          tr.lane = a.lane;
        }
        return { ok: true, message: `Truck ${n} reassigned to ${PORT_LABEL[a.port]} ${a.lane}` };
      }
      default:
        return { ok: false, message: 'Unknown action' };
    }
  }

  reportQueue(r: { portId: PortId; lengthKm: number; extraWaitMin: number; reportedBy: string }): SourceRef {
    const t = this.clock.simMs;
    const truckId = /T\d+/.exec(r.reportedBy)?.[0] ?? r.reportedBy;
    const km = Math.round(r.lengthKm * 10) / 10;
    const source: SourceRef = {
      id: `driver:${truckId}:${hhmm(t)}`,
      kind: 'driver_report',
      label: `Driver report · Truck ${truckNum(truckId)} · ~${km} km Mexican side · ${clockLabel(t)}`,
      observedAt: toIsoPT(t),
    };
    const port: PortId = r.portId === 'tecate' ? 'tecate' : 'otay_mesa';
    this.worlds.linea.mx[port] = { min: Math.max(0, Math.round(r.extraWaitMin)), source, expiresAt: t + MX_REPORT_TTL_MS };
    this.sourceHistory.set(source.id, source);
    this.bus.emit('queue.report', { portId: port, side: 'mx', lengthKm: km, extraWaitMin: Math.round(r.extraWaitMin), reportedBy: r.reportedBy, source });
    this.fire('queue_report', { portId: port, extraWaitMin: Math.round(r.extraWaitMin), sourceId: source.id });
    return source;
  }

  setClockSpeed(speed: 1 | 20 | 60): void {
    this.clock.setClockSpeed(speed);
    this.emitControl(`clock ${speed}× (live call)`);
  }

  restoreClockSpeed(): void {
    this.clock.restoreClockSpeed();
    this.emitControl(`clock restored to ${this.clock.speed}×`);
  }

  isScenarioFlag(flag: 'missed_call_T6'): boolean {
    return !!this.scenario.flags[flag];
  }

  /** Sim-side truth for the mock agent's scripted calls (what a driver in line would actually see). */
  truthMxNow(port: PortId): number {
    return this.scenario.truthMX(port, this.clock.simMs);
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
