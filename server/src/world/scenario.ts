// SPEC §5 encoded: fleet, truth wait curves, spike gating, oscillation, typical profile.
import type { Cargo, Priority, PortId, Lane } from '../../../shared/types';
import type { PlaceKey } from '../../../shared/geo';
import { atPT, MIN } from './clock';

export interface TruckSpec {
  id: string;
  driverName: string;
  cargo: Cargo;
  priority: Priority;
  fastEligible: boolean;
  readyAt: number;
  deadline: number;
  origin: PlaceKey;
  destination: PlaceKey;
  phoneMode: 'live' | 'simulated';
}

const T = (
  id: string, driverName: string, cargo: Cargo, priority: Priority, fastEligible: boolean,
  ready: string, deadline: number, origin: PlaceKey, destination: PlaceKey,
): TruckSpec => ({
  id, driverName, cargo, priority, fastEligible, readyAt: atPT(ready), deadline, origin, destination,
  phoneMode: id === 'T4' ? 'live' : 'simulated',
});

export const FLEET: TruckSpec[] = [
  T('T1', 'Luis', 'auto_parts', 'jit', true, '13:40', atPT('16:30'), 'yard_nueva_tijuana', 'dest_otay_xdock'),
  T('T2', 'Rosa', 'auto_parts', 'jit', true, '14:10', atPT('17:00'), 'yard_nueva_tijuana', 'dest_otay_xdock'),
  T('T3', 'Jorge', 'auto_parts', 'jit', false, '14:40', atPT('17:30'), 'yard_el_florido', 'dest_chula_vista'),
  T('T4', 'Carlos', 'auto_parts', 'jit', false, '14:15', atPT('17:15'), 'yard_el_florido', 'dest_chula_vista'),
  T('T5', 'Marta', 'medical', 'standard', true, '14:30', atPT('18:30'), 'yard_pacifico', 'dest_kearny_mesa'),
  T('T6', 'Iván', 'medical', 'standard', false, '15:00', atPT('19:00'), 'yard_pacifico', 'dest_kearny_mesa'),
  T('T7', 'Pedro', 'medical', 'standard', false, '15:20', atPT('19:15'), 'yard_el_florido', 'dest_kearny_mesa'),
  T('T8', 'Elena', 'produce', 'perishable', false, '14:50', atPT('17:00'), 'yard_el_florido', 'dest_produce'),
  T('T9', 'Raúl', 'general', 'standard', false, '15:00', atPT('10:00', 1), 'yard_nueva_tijuana', 'dest_otay_xdock'),
  T('T10', 'Sofía', 'general', 'standard', false, '15:10', atPT('10:00', 1), 'yard_pacifico', 'dest_chula_vista'),
];

export type Pt = [string, number];

export const CURVES: {
  otay_mesa: { standard: Pt[]; fast: Pt[]; mxExtra: Pt[] };
  tecate: { standard: Pt[]; fast: null; mxExtra: Pt[] };
} = {
  otay_mesa: {
    standard: [['13:30', 35], ['14:30', 45], ['14:55', 118], ['15:30', 125], ['16:30', 110], ['17:30', 95], ['18:30', 55], ['19:30', 40]],
    fast:     [['13:30', 15], ['14:30', 18], ['14:55', 45], ['15:30', 48], ['16:30', 40], ['17:30', 30], ['18:30', 20], ['19:30', 15]],
    mxExtra:  [['13:30', 10], ['14:30', 15], ['14:55', 60], ['15:30', 60], ['16:30', 45], ['17:30', 35], ['18:30', 15], ['19:30', 10]],
  },
  tecate: {
    standard: [['13:30', 20], ['14:30', 22], ['14:55', 25], ['15:30', 25], ['16:30', 30], ['17:30', 28], ['18:30', 22], ['19:30', 20]],
    fast: null,
    mxExtra:  [['13:30', 0], ['19:30', 0]],
  },
};

export const SPIKE_AT = atPT('14:55');
const PRE_SPIKE_LAST = atPT('14:30');
export const NORMALIZE_AT = atPT('18:30');
export const OSC_DURATION_MS = 12 * MIN;
export const OSC_PERIOD_MS = 2 * MIN;

/** What the optimizer believes about the future (NOT the truth). Hourly Otay std; FAST = 40%; Tecate flat 25. */
export const TYPICAL_PROFILE: { otayStd: Pt[]; fastRatio: number; tecateStd: number } = {
  otayStd: [['13:00', 40], ['14:00', 55], ['15:00', 80], ['16:00', 90], ['17:00', 80], ['18:00', 55], ['19:00', 40]],
  fastRatio: 0.4,
  tecateStd: 25,
};

function interp(pts: Pt[], t: number): number {
  const xs = pts.map(([hm]) => atPT(hm));
  if (t <= xs[0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (t <= xs[i]) {
      const f = (t - xs[i - 1]) / (xs[i] - xs[i - 1]);
      return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f;
    }
  }
  return pts[pts.length - 1][1];
}

/** Spike-gated interpolation: before the spike fires, extend the pre-spike trend; after, jump to the spike curve. */
function gated(pts: Pt[], t: number, spikeFired: boolean): number {
  const pre = pts.filter(([hm]) => atPT(hm) <= PRE_SPIKE_LAST);
  const post = pts.filter(([hm]) => atPT(hm) >= SPIKE_AT);
  if (spikeFired) {
    if (t >= SPIKE_AT) return interp(post, t);
    if (t >= PRE_SPIKE_LAST || post.length === 0) return post.length ? post[0][1] : interp(pre, t);
    // spike injected very early (before 2:30): still jump
    return post[0][1];
  }
  if (t <= PRE_SPIKE_LAST) return interp(pre, t);
  // hold the 1:30→2:30 trend
  const a = pre[pre.length - 2], b = pre[pre.length - 1];
  const slope = (b[1] - a[1]) / (atPT(b[0]) - atPT(a[0]));
  return b[1] + slope * (t - PRE_SPIKE_LAST);
}

export type ScenarioStep = 'calm' | 'spike' | 'oscillation' | 'normalizing' | 'done';

export class Scenario {
  spikeFiredAt: number | null = null;
  oscStartedAt: number | null = null;
  flags = { missed_call_T6: false };

  reset(): void {
    this.spikeFiredAt = null;
    this.oscStartedAt = null;
    this.flags = { missed_call_T6: false };
  }

  get spikeFired(): boolean {
    return this.spikeFiredAt !== null;
  }

  fireSpike(t: number): boolean {
    if (this.spikeFiredAt !== null) return false;
    this.spikeFiredAt = t;
    return true;
  }

  injectOscillation(t: number): void {
    this.oscStartedAt = t;
  }

  oscillating(t: number): boolean {
    return this.oscStartedAt !== null && t >= this.oscStartedAt && t < this.oscStartedAt + OSC_DURATION_MS;
  }

  /** True US-side wait (what a truck arriving now actually waits). Oscillation is a data glitch, not truth. */
  truthUS(port: PortId, lane: Lane, t: number): number {
    if (port === 'tecate') return interp(CURVES.tecate.standard, t);
    const pts = lane === 'fast' ? CURVES.otay_mesa.fast : CURVES.otay_mesa.standard;
    return gated(pts, t, this.spikeFired);
  }

  /** Hidden Mexican-side extra wait. */
  truthMX(port: PortId, t: number): number {
    if (port === 'tecate') return 0;
    return gated(CURVES.otay_mesa.mxExtra, t, this.spikeFired);
  }

  /** What CBP reports for the US side (port.update source). Null for lanes that don't exist. */
  cbpUS(port: PortId, lane: Lane, t: number): number | null {
    if (port === 'tecate') {
      if (lane === 'fast') return null;
      if (this.oscillating(t)) {
        const phase = Math.floor((t - (this.oscStartedAt as number)) / OSC_PERIOD_MS);
        return phase % 2 === 0 ? 15 : 95;
      }
    }
    return this.truthUS(port, lane, t);
  }

  /** Optimizer's prior for wait at time t. */
  typicalUS(port: PortId, lane: Lane, t: number): number {
    if (port === 'tecate') return TYPICAL_PROFILE.tecateStd;
    const std = interp(TYPICAL_PROFILE.otayStd, t);
    return lane === 'fast' ? std * TYPICAL_PROFILE.fastRatio : std;
  }

  step(t: number, done: boolean): ScenarioStep {
    if (done) return 'done';
    if (this.oscillating(t)) return 'oscillation';
    if (t >= NORMALIZE_AT) return 'normalizing';
    if (this.spikeFired) return 'spike';
    return 'calm';
  }
}
