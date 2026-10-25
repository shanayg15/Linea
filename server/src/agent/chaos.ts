// Chaos test (TRACK_B §B9): flip T7 Otay → Tecate → Otay → Tecate through the real gate, 2 sim-min apart.
// Expected: first two allowed, third blocked with an oscillation trip → escalation call to Ana.
import { ulid } from 'ulid';
import type { PortId } from '../../../shared/types';
import type { WorldApi } from '../world/api';
import type { Dispatcher } from './dispatcher';
import { MIN, ms, portLabel } from './time';
import type { ProposedAction } from './types';
import type { Watchdog } from './watchdog';

const TRUCK = 'T7';
const FLIPS: PortId[] = ['tecate', 'otay_mesa', 'tecate'];

let running = false;

export async function runChaos(world: WorldApi, watchdog: Watchdog, dispatcher: Dispatcher): Promise<void> {
  if (running) return;
  running = true;
  try {
    watchdog.seedAssignment(TRUCK, 'otay_mesa', 'standard');
    let from: PortId = 'otay_mesa';
    for (let i = 0; i < FLIPS.length; i++) {
      if (i > 0) await waitSim(world, 2 * MIN);
      const to = FLIPS[i]!;
      const tecate = world.view().ports.find((p) => p.id === 'tecate');
      const sourceId = tecate?.standard.source.id;
      const p: ProposedAction = {
        toolCallId: ulid(),
        tool: 'reassign_truck',
        args: {
          truck_id: TRUCK,
          port: to,
          lane: 'standard',
          title: `Rerouting Truck 7 to ${portLabel(to)}`,
          reasoning: `Chaos test flip ${i + 1}/3: Tecate shows ${tecate?.standard.waitMin ?? '?'} min.`,
          source_ids: sourceId ? [sourceId] : [],
        },
        truckId: TRUCK,
        port: to,
        lane: 'standard',
        sourceIds: sourceId ? [sourceId] : [],
        origin: 'chaos',
      };
      const d = await dispatcher.gateAndExecute(p, 'chaos');
      if (d) world.bus.emit('agent.decision', { ...d, detail: `${portLabel(from)} → ${portLabel(to)} · standard lane` });
      from = to;
    }
  } finally {
    running = false;
  }
}

function waitSim(world: WorldApi, simMs: number): Promise<void> {
  const target = ms(world.now()) + simMs;
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (ms(world.now()) >= target) {
        clearInterval(t);
        resolve();
      }
    }, 100);
  });
}
