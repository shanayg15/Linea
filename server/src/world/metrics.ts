// §A7: per-policy metrics from world state; linea-only counters from the bus.
import type { Metrics, Truck, LineaEvent } from '../../../shared/types';
import type { EventBus } from './api';
import { parseIso } from './clock';

export interface Counters { costUsd: number; decisions: number; calls: number; humanTouches: number }

export const zeroCounters = (): Counters => ({ costUsd: 0, decisions: 0, calls: 0, humanTouches: 0 });

export function computeMetrics(trucks: Truck[], counters: Counters = zeroCounters()): Metrics {
  let minutes = 0, onTime = 0, late = 0, jitAtRisk = 0, produce = 0;
  for (const t of trucks) {
    minutes += t.minutesInLine;
    if (t.state === 'delivered' && t.deliveredAt) {
      if (parseIso(t.deliveredAt) <= parseIso(t.deadline)) onTime++; else late++;
    } else if (t.priority === 'jit' && t.etaDelivery && parseIso(t.etaDelivery) > parseIso(t.deadline)) {
      jitAtRisk++;
    }
    if (t.cargo === 'produce') produce += t.minutesInLine;
  }
  return {
    truckHoursInLine: Math.round((minutes / 60) * 100) / 100,
    deliveredOnTime: onTime,
    deliveredLate: late,
    deliveriesTotal: trucks.length,
    jitAtRisk,
    produceMinutesInLine: Math.round(produce),
    costUsd: Math.round(counters.costUsd * 10000) / 10000,
    humanTouches: counters.humanTouches,
    decisions: counters.decisions,
    calls: counters.calls,
  };
}

/** Linea-only counters accumulated from bus events. */
export class LineaCounters {
  c: Counters = zeroCounters();

  attach(bus: EventBus): () => void {
    return bus.on((e: LineaEvent) => {
      switch (e.type) {
        case 'agent.usage': this.c.costUsd += e.payload.costUsd || 0; break;
        case 'call.ended':
          this.c.costUsd += e.payload.costUsd || 0;
          if (e.payload.kind === 'dispatcher' && e.payload.outcome === 'completed') this.c.humanTouches++;
          break;
        case 'agent.decision': if (e.payload.action !== 'no_action') this.c.decisions++; break;
        case 'call.started': this.c.calls++; break;
        default: break;
      }
    });
  }

  reset(): void {
    this.c = zeroCounters();
  }
}
