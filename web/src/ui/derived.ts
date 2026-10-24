import type { Metrics, WorldView } from '@shared/types';

/** Delivered on time + undelivered trucks whose ETA still beats the deadline. */
export function onTimeCount(m: Metrics | undefined, view: WorldView | null): number {
  if (!m) return 0;
  if (!view) return m.deliveredOnTime;
  const pending = view.trucks.filter(
    (t) => t.state !== 'delivered' && (!t.etaDelivery || Date.parse(t.etaDelivery) <= Date.parse(t.deadline)),
  ).length;
  return m.deliveredOnTime + pending;
}

export function hoursSaved(m: { linea: Metrics; baseline: Metrics } | null): number {
  return m ? Math.max(0, m.baseline.truckHoursInLine - m.linea.truckHoursInLine) : 0;
}
