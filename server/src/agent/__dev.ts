// npx tsx server/src/agent/__dev.ts [chaos|squeeze]
// Runs the real agent (Claude + watchdog + simulated calls) against FakeWorld and prints every event.
import 'dotenv/config';
import { createFakeWorld } from './__fake';
import { createAgent } from './index';

const world = createFakeWorld({ autoClock: true, log: true });
const agent = createAgent(world);
const mode = process.argv[2];

world.bus.on((e) => {
  if (e.type === 'call.ended') agent.trigger('call_ended', { callId: e.payload.callId });
  if (e.type === 'queue.report') agent.trigger('queue_report', { truckId: e.payload.reportedBy });
});

if (mode === 'chaos') agent.handleControl({ cmd: 'chaos_flip' });
else if (mode === 'squeeze') {
  agent.handleControl({ cmd: 'budget_squeeze' });
  agent.trigger('port_change', { portId: 'otay_mesa', lane: 'standard', prevWaitMin: 35, waitMin: 118 });
} else {
  agent.trigger('port_change', { portId: 'otay_mesa', lane: 'standard', prevWaitMin: 35, waitMin: 118 });
}

setTimeout(() => {
  agent.stop();
  const cost = world.events.filter((e) => e.type === 'agent.usage').reduce((s, e) => s + (e.type === 'agent.usage' ? e.payload.costUsd : 0), 0);
  console.log(`\nDone. ${world.events.length} events, Claude cost $${cost.toFixed(4)}`);
  process.exit(0);
}, Number(process.env.DEV_SECONDS || 25) * 1000);
