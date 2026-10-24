// Bus-derived state for GET /snapshot — identical in live and replay modes.
import type { LineaEvent, Metrics, MetricsPoint, WatchdogStatus, WorldView, SimClock } from '../../../shared/types';
import type { Bus } from './bus';

export interface Snapshot {
  linea: WorldView | null;
  baseline: WorldView | null;
  clock: SimClock | null;
  metrics: { linea: Metrics; baseline: Metrics } | null;
  series: MetricsPoint[];
  watchdog: WatchdogStatus | null;
  recent: LineaEvent[];
}

export class SnapshotStore {
  private metrics: { linea: Metrics; baseline: Metrics } | null = null;
  private series: MetricsPoint[] = [];
  private watchdog: WatchdogStatus | null = null;
  private clock: SimClock | null = null;

  constructor(private readonly bus: Bus) {
    bus.on((e) => {
      switch (e.type) {
        case 'metrics.update':
          this.metrics = { linea: e.payload.linea, baseline: e.payload.baseline };
          this.series.push(e.payload.point);
          break;
        case 'watchdog.status': this.watchdog = e.payload; break;
        case 'world.tick': this.clock = e.payload.clock; break;
        case 'sim.control':
          if (e.payload.note === 'reset') { this.series = []; this.metrics = null; this.watchdog = null; }
          break;
        default: break;
      }
    });
  }

  get(): Snapshot {
    const tick = this.bus.latestTick;
    const p = tick && tick.type === 'world.tick' ? tick.payload : null;
    return {
      linea: p?.linea ?? null,
      baseline: p?.baseline ?? null,
      clock: p?.clock ?? this.clock,
      metrics: this.metrics,
      series: this.series,
      watchdog: this.watchdog,
      recent: this.bus.recent(100),
    };
  }
}
