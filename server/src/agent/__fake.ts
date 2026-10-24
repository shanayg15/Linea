// FakeWorld (TRACK_B §B0) — a minimal WorldApi for developing the agent before Track A's sim lands.
// Never imported in prod.
import { ulid } from 'ulid';
import type { Lane, LineaEvent, LineaEventType, PayloadOf, PortId, PortStatus, SourceRef, Truck } from '../../../shared/types';
import type { EventBus, OptionScore, WorldAction, WorldApi } from '../world/api';
import { fmtClock, MIN, ms, toIso } from './time';

export interface FakeWorld extends WorldApi {
  advance(simMs: number): void;
  setWait(port: PortId, lane: Lane, waitMin: number): void;
  setFlag(flag: 'missed_call_T6', v: boolean): void;
  events: LineaEvent[];
  actions: WorldAction[];
  fleetDelay: number; // override for no-progress tests (NaN = computed)
}

export function createFakeWorld(opts: { autoClock?: boolean; log?: boolean } = {}): FakeWorld {
  let simMs = ms('2026-10-22T14:55:00-07:00');
  let speed = 60;
  let savedSpeed = 60;
  let lastWall = Date.now();
  const flags = { missed_call_T6: false };
  const events: LineaEvent[] = [];
  const listeners = new Set<(e: LineaEvent) => void>();
  let seq = 0;

  const nowIso = () => {
    if (opts.autoClock) {
      const w = Date.now();
      simMs += (w - lastWall) * speed;
      lastWall = w;
    }
    return toIso(simMs);
  };

  const bus: EventBus = {
    emit<T extends LineaEventType>(type: T, payload: PayloadOf<T>): LineaEvent {
      const e = { id: ulid(), seq: ++seq, simTime: nowIso(), wallTime: new Date().toISOString(), type, payload } as unknown as LineaEvent;
      events.push(e);
      if (opts.log) console.log(`${fmtClock(e.simTime).padStart(8)}  ${type.padEnd(16)} ${JSON.stringify(payload).slice(0, 220)}`);
      for (const fn of listeners) fn(e);
      return e;
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    recent(n) {
      return events.slice(-n);
    },
  };

  const sources = new Map<string, SourceRef>();
  function cbpSource(port: PortId, lane: Lane, wait: number): SourceRef {
    const hhmm = fmtClock(nowIso()).replace(/ [AP]M$/, '');
    const s: SourceRef = {
      id: `cbp:${port}:${lane}:${hhmm}`,
      kind: 'cbp_replay',
      label: `CBP · ${port === 'otay_mesa' ? 'Otay Mesa' : 'Tecate'} ${lane} · ${wait} min · ${fmtClock(nowIso())}`,
      observedAt: nowIso(),
    };
    sources.set(s.id, s);
    return s;
  }

  const ports: PortStatus[] = [
    port('otay_mesa', 'Otay Mesa', 118, 45),
    port('tecate', 'Tecate', 25, null),
  ];
  function port(id: PortId, name: string, std: number, fast: number | null): PortStatus {
    return {
      id,
      name,
      pos: [-116.94, 32.55],
      standard: { waitMin: std, lanesOpen: 6, source: cbpSource(id, 'standard', std) },
      fast: { waitMin: fast, lanesOpen: fast == null ? 0 : 2, source: cbpSource(id, 'fast', fast ?? 0) },
      mxSideExtraMin: 0,
      mxSideSource: null,
      queuePath: [],
    };
  }

  const trucks: Truck[] = [
    truck('T4', 'Carlos', 'auto_parts', 'jit', false, '17:15', 'in_queue_mx', 'otay_mesa', 'standard', 12),
    truck('T6', 'Iván', 'medical', 'standard', false, '19:00', 'en_route', 'otay_mesa', 'standard', 0),
    truck('T7', 'Pedro', 'medical', 'standard', false, '19:15', 'en_route', 'otay_mesa', 'standard', 0),
    truck('T8', 'Elena', 'produce', 'perishable', false, '17:00', 'at_yard', null, null, 0),
    truck('T9', 'Raúl', 'general', 'standard', false, '10:00', 'at_yard', null, null, 0, true),
  ];
  function truck(
    id: string,
    driverName: string,
    cargo: Truck['cargo'],
    priority: Truck['priority'],
    fastEligible: boolean,
    deadlineHHMM: string,
    state: Truck['state'],
    p: PortId | null,
    lane: Lane | null,
    minutesInLine: number,
    nextDay = false,
  ): Truck {
    const deadline = `2026-10-${nextDay ? 23 : 22}T${deadlineHHMM}:00-07:00`;
    sources.set(`schedule:${id}`, { id: `schedule:${id}`, kind: 'schedule', label: `Schedule · Truck ${id.slice(1)} due ${fmtClock(deadline)}`, observedAt: nowIso() });
    return {
      id,
      driverName,
      cargo,
      priority,
      fastEligible,
      readyAt: '2026-10-22T14:30:00-07:00',
      deadline,
      origin: { name: 'El Florido', pos: [-116.85, 32.47] },
      destination: { name: 'Chula Vista DC', pos: [-117.05, 32.63] },
      state,
      pos: [-116.9, 32.5],
      heading: 0,
      port: p,
      lane,
      heldUntil: null,
      queueEnteredAt: null,
      crossedAt: null,
      deliveredAt: null,
      minutesInLine,
      etaDelivery: null,
      phoneMode: id === 'T4' ? 'live' : 'simulated',
    };
  }

  const getPort = (id: PortId) => ports.find((p) => p.id === id)!;

  function scoreOptions(truckId: string): OptionScore[] {
    const t = trucks.find((x) => x.id === truckId);
    if (!t) return [];
    const otay = getPort('otay_mesa');
    const tec = getPort('tecate');
    const now = ms(nowIso());
    const mk = (option: OptionScore['option'], port: PortId, lane: Lane, line: number, departIn: number, penalty: number): OptionScore => {
      const optId = `optimizer:${truckId}`;
      sources.set(optId, { id: optId, kind: 'optimizer', label: `Optimizer · Truck ${truckId.slice(1)}`, observedAt: nowIso() });
      const p = port === 'otay_mesa' ? otay : tec;
      return {
        option,
        port,
        lane,
        departAt: toIso(now + departIn * MIN),
        expectedLineMin: line,
        expectedDeliveryAt: toIso(now + (departIn + line + 40) * MIN),
        lateMin: 0,
        score: line + penalty,
        explanation: `${port === 'otay_mesa' ? 'Otay' : 'Tecate'} ${lane === 'fast' ? 'FAST' : 'standard'} at ${fmtClock(toIso(now + departIn * MIN))} · ~${line} min line`,
        sourceIds: [p[lane].source.id, `schedule:${truckId}`, optId, ...(p.mxSideSource ? [p.mxSideSource.id] : [])],
      };
    };
    const opts = [
      mk('go_now', 'tecate', 'standard', (tec.standard.waitMin ?? 0) + 6, 0, 6),
      mk('go_now', 'otay_mesa', 'standard', (otay.standard.waitMin ?? 0) + otay.mxSideExtraMin, 0, 0),
      mk('hold_90', 'otay_mesa', 'standard', Math.round((otay.standard.waitMin ?? 0) * 0.6), 90, t.priority === 'standard' ? 5 : 60),
    ];
    if (t.fastEligible) opts.push(mk('go_now', 'otay_mesa', 'fast', (otay.fast.waitMin ?? 0) + otay.mxSideExtraMin, 0, 0));
    return opts.sort((a, b) => a.score - b.score);
  }

  const actions: WorldAction[] = [];

  const world: FakeWorld = {
    bus,
    events,
    actions,
    fleetDelay: NaN,
    now: nowIso,
    view: (policy = 'linea') => ({ policy, simTime: nowIso(), trucks, ports }),
    getTruck: (id) => trucks.find((t) => t.id === id),
    scoreOptions,
    projectFleetDelayMin() {
      if (!Number.isNaN(world.fleetDelay)) return world.fleetDelay;
      return trucks.filter((t) => t.state !== 'delivered').reduce((s, t) => s + t.minutesInLine + (scoreOptions(t.id)[0]?.expectedLineMin ?? 0), 0);
    },
    sources: () => [...sources.values()],
    applyAction(a) {
      actions.push(a);
      const t = trucks.find((x) => x.id === a.truckId);
      if (!t) return { ok: false, message: 'Unknown truck' };
      if (a.kind === 'hold') {
        t.state = 'held';
        t.heldUntil = a.until;
      } else {
        if (a.kind === 'reassign' && (t.state === 'in_queue_mx' || t.state === 'in_queue_us')) return { ok: false, message: 'Truck is already in line' };
        t.state = 'en_route';
        t.port = a.port;
        t.lane = a.lane;
      }
      if (opts.log) console.log(`           [world] applyAction ${JSON.stringify(a)}`);
      return { ok: true, message: 'ok' };
    },
    reportQueue(r) {
      const p = getPort(r.portId);
      const hhmm = fmtClock(nowIso()).replace(/ [AP]M$/, '');
      const src: SourceRef = {
        id: `driver:${r.reportedBy}:${hhmm}`,
        kind: 'driver_report',
        label: `Driver report · Truck ${r.reportedBy.replace(/^T/, '')} · ~${r.lengthKm} km Mexican side · ${fmtClock(nowIso())}`,
        observedAt: nowIso(),
      };
      sources.set(src.id, src);
      p.mxSideExtraMin = r.extraWaitMin;
      p.mxSideSource = src;
      bus.emit('queue.report', { portId: r.portId, side: 'mx', lengthKm: r.lengthKm, extraWaitMin: r.extraWaitMin, reportedBy: r.reportedBy, source: src });
      return src;
    },
    setClockSpeed(s) {
      savedSpeed = speed;
      speed = s;
    },
    restoreClockSpeed() {
      speed = savedSpeed;
    },
    isScenarioFlag: (f) => flags[f],
    advance(d) {
      simMs += d;
    },
    setWait(portId, lane, waitMin) {
      const p = getPort(portId);
      const prev = p[lane].waitMin;
      p[lane] = { ...p[lane], waitMin, source: cbpSource(portId, lane, waitMin) };
      bus.emit('port.update', { portId, lane, waitMin, prevWaitMin: prev, source: p[lane].source });
    },
    setFlag(f, v) {
      flags[f] = v;
    },
  };
  return world;
}
