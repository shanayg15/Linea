// §A6: score go/hold × port × lane options for a truck. Uses CBP (port.update) + driver reports + a typical
// profile — never the hidden truth.
import type { Truck, PortId, Lane, Priority } from '../../../shared/types';
import type { OptionScore } from './api';
import type { Scenario } from './scenario';
import { NORMALIZE_AT } from './scenario';
import { MIN, SIM_END, clockLabel, toIsoPT, parseIso } from './clock';

export const W: Record<Priority, number> = { jit: 8, perishable: 6, standard: 1 };
export const PRODUCE_LINE_WEIGHT = 2.0;
export const TECATE_DRIVE_WEIGHT = 0.5;
export const HOLD_PENALTY = 0.15;
/** No holds that depart after this (the shift ends at 7:30 PM). */
const LAST_HOLD_DEPART = SIM_END - 60 * MIN;

export interface OptimizerCtx {
  now: number;
  scenario: Scenario;
  /** Last emitted CBP value for a port/lane, with its source id. */
  cbp(port: PortId, lane: Lane): { value: number; sourceId: string };
  /** MX-side extra learned from driver reports (0 if none). */
  knownMx(port: PortId): { min: number; sourceId: string | null };
  /** Drive minutes from the truck's current position (yard if not moving) to the port's queue tail. */
  driveToPortMin(truckId: string, port: PortId): number;
  /** Drive minutes from the port to the truck's destination. */
  postPortMin(truckId: string, port: PortId): number;
}

const PORT_NAME: Record<PortId, string> = { otay_mesa: 'Otay', tecate: 'Tecate' };
const laneName = (l: Lane) => (l === 'fast' ? 'FAST' : 'standard');

export function forecastUS(ctx: OptimizerCtx, port: PortId, lane: Lane, arrive: number): number {
  const current = ctx.cbp(port, lane).value;
  const leadMin = (arrive - ctx.now) / MIN;
  if (leadMin <= 30) return current;
  const w = Math.min(1, (leadMin - 30) / 90);
  return (1 - w) * current + w * ctx.scenario.typicalUS(port, lane, arrive);
}

export function scoreOptionsFor(ctx: OptimizerCtx, truck: Truck): OptionScore[] {
  if (truck.state !== 'at_yard' && truck.state !== 'held' && truck.state !== 'en_route') return [];
  const now = ctx.now;
  const readyAt = parseIso(truck.readyAt);
  const deadline = parseIso(truck.deadline);
  const enRoute = truck.state === 'en_route';

  const holds: [OptionScore['option'], number][] = [['go_now', 0]];
  if (!enRoute) {
    holds.push(['hold_30', 30], ['hold_60', 60], ['hold_90', 90]);
    const untilNormal = (NORMALIZE_AT - now) / MIN;
    if (untilNormal > 0) holds.push(['hold_until_1830', untilNormal]);
  }

  const combos: [PortId, Lane][] = [['otay_mesa', 'standard'], ['tecate', 'standard']];
  if (truck.fastEligible) combos.push(['otay_mesa', 'fast']);

  const driveOtay = ctx.driveToPortMin(truck.id, 'otay_mesa') + ctx.postPortMin(truck.id, 'otay_mesa');
  const driveTecate = ctx.driveToPortMin(truck.id, 'tecate') + ctx.postPortMin(truck.id, 'tecate');
  const extraDriveMin = Math.max(0, driveTecate - driveOtay);

  const out: OptionScore[] = [];
  for (const [option, holdMin] of holds) {
    const departAt = enRoute ? now : Math.max(now + holdMin * MIN, readyAt);
    if (option !== 'go_now' && departAt > LAST_HOLD_DEPART) continue;
    for (const [port, lane] of combos) {
      const arrive = departAt + ctx.driveToPortMin(truck.id, port) * MIN;
      const us = forecastUS(ctx, port, lane, arrive);
      const mx = ctx.knownMx(port);
      const expectedLineMin = us + mx.min;
      const deliverAt = arrive + (expectedLineMin + ctx.postPortMin(truck.id, port)) * MIN;
      const lateMin = Math.max(0, (deliverAt - deadline) / MIN);
      const score =
        expectedLineMin * 1.0 +
        lateMin * W[truck.priority] +
        (truck.cargo === 'produce' ? expectedLineMin * PRODUCE_LINE_WEIGHT : 0) +
        (port === 'tecate' ? extraDriveMin * TECATE_DRIVE_WEIGHT : 0) +
        holdMin * HOLD_PENALTY;
      const when = enRoute ? 'from current position' : `leave ${clockLabel(departAt)}`;
      const timing = lateMin >= 1 ? `${Math.round(lateMin)} min late` : 'on time';
      const sourceIds = [ctx.cbp(port, lane).sourceId];
      if (mx.min > 0 && mx.sourceId) sourceIds.push(mx.sourceId);
      sourceIds.push(`schedule:${truck.id}`);
      out.push({
        option,
        port,
        lane,
        departAt: toIsoPT(departAt),
        expectedLineMin: Math.round(expectedLineMin),
        expectedDeliveryAt: toIsoPT(deliverAt),
        lateMin: Math.round(lateMin),
        score: Math.round(score * 10) / 10,
        explanation: `${PORT_NAME[port]} ${laneName(lane)} · ${when} · ~${Math.round(expectedLineMin)} min line · arrives ${clockLabel(deliverAt)} (${timing})`,
        sourceIds,
      });
    }
  }
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, 6);
}
