// npx tsx server/src/agent/watchdog.test.ts — one test per watchdog check (TRACK_B §B4).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ulid } from 'ulid';
import type { Lane, PortId } from '../../../shared/types';
import { createFakeWorld, type FakeWorld } from './__fake';
import { MIN } from './time';
import type { CallGoal, ProposedAction, StartDispatcherCall, ToolName, Voice } from './types';
import { createWatchdog } from './watchdog';

process.env.BUDGET_CAP_USD = '3';
process.env.MODEL_DISPATCH = 'claude-sonnet-5-5';
process.env.MODEL_DEGRADED = 'claude-haiku-5-5';

function setup() {
  const world = createFakeWorld({ autoClock: false });
  const wd = createWatchdog(world, { autoTick: false });
  const escalations: StartDispatcherCall[] = [];
  const voice: Voice = {
    startDriverCall: async () => ulid(),
    startDispatcherCall: async (c) => {
      escalations.push(c);
      return ulid();
    },
  };
  wd.attachVoice(voice);
  return { world, wd, escalations };
}

function cite(world: FakeWorld, port: PortId = 'otay_mesa', lane: Lane = 'standard'): string[] {
  return [world.view().ports.find((p) => p.id === port)![lane].source.id];
}

function p(world: FakeWorld, tool: ToolName, x: Partial<ProposedAction> & { goal?: CallGoal } = {}): ProposedAction {
  return { toolCallId: ulid(), tool, args: {}, truckId: null, sourceIds: cite(world), origin: 'agent', ...x };
}

function trips(world: FakeWorld, kind?: string) {
  return world.events.filter((e) => e.type === 'watchdog.trip' && (!kind || e.payload.kind === kind));
}

test('1. cite-or-block: missing or unknown sources are blocked', () => {
  const { world, wd } = setup();
  assert.equal(wd.gate(p(world, 'hold_truck', { truckId: 'T9', until: world.now(), sourceIds: [] })).tripKind, 'uncited');
  assert.equal(wd.gate(p(world, 'hold_truck', { truckId: 'T9', until: world.now(), sourceIds: ['cbp:made:up'] })).verdict, 'blocked');
  assert.equal(wd.gate(p(world, 'no_action', { sourceIds: [] })).verdict, 'allowed');
  assert.ok(world.events.some((e) => e.type === 'tool.gate' && e.payload.tripKind === 'uncited'));
});

test('2. idempotency: same action in the same 10-min bucket is deduped', () => {
  const { world, wd } = setup();
  const a = () => p(world, 'dispatch_truck', { truckId: 'T8', port: 'tecate', lane: 'standard' });
  assert.equal(wd.gate(a()).verdict, 'allowed');
  assert.equal(wd.gate(a()).verdict, 'deduped');
  assert.equal(trips(world).length, 0);
});

test('3. budget: 70% degrades to Haiku, 90% blocks standard-priority calls, 100% stops', () => {
  const { world, wd } = setup();
  assert.equal(wd.currentModel(), 'claude-sonnet-5-5');
  wd.addCost(2.2);
  assert.equal(wd.currentModel(), 'claude-haiku-5-5');
  assert.equal(trips(world, 'budget').length, 1);
  wd.addCost(0.6); // 93%
  assert.equal(wd.gate(p(world, 'call_driver', { truckId: 'T7', goal: 'learn_queue' })).tripKind, 'budget');
  assert.equal(wd.gate(p(world, 'call_driver', { truckId: 'T4', goal: 'learn_queue' })).verdict, 'allowed'); // jit still allowed
  wd.addCost(0.3);
  assert.ok(wd.isStopped());
  assert.equal(wd.gate(p(world, 'hold_truck', { truckId: 'T9', until: world.now() })).verdict, 'blocked');
  assert.ok(trips(world, 'budget').some((e) => e.type === 'watchdog.trip' && e.payload.response === 'stopped'));
});

test('4. oscillation: third flip in 15 min is blocked, truck frozen, escalation batched', () => {
  const { world, wd, escalations } = setup();
  wd.seedAssignment('T7', 'otay_mesa', 'standard');
  const flip = (port: PortId) => wd.gate(p(world, 'reassign_truck', { truckId: 'T7', port, lane: 'standard', sourceIds: cite(world, 'tecate'), origin: 'chaos' }));
  assert.equal(flip('tecate').verdict, 'allowed');
  world.advance(2 * MIN);
  assert.equal(flip('otay_mesa').verdict, 'allowed');
  assert.equal(wd.status().loops.state, 'warn');
  world.advance(2 * MIN);
  const r = flip('tecate');
  assert.equal(r.verdict, 'blocked');
  assert.equal(r.tripKind, 'oscillation');
  assert.ok(wd.isFrozen('T7'));
  const trip = trips(world, 'oscillation')[0];
  assert.ok(trip && trip.type === 'watchdog.trip' && trip.payload.evidence.length === 3, 'three evidence lines');
  world.advance(1 * MIN);
  assert.equal(wd.gate(p(world, 'reassign_truck', { truckId: 'T7', port: 'otay_mesa', lane: 'fast' })).verdict, 'blocked'); // frozen
  world.advance(1 * MIN);
  wd.tick();
  assert.equal(escalations.length, 1);
  assert.match(escalations[0]!.summary, /Pedro/);
});

test('5. repeat tool: same tool + args 3× in 20 min is blocked across idempotency buckets', () => {
  const { world, wd } = setup();
  const a = () => p(world, 'hold_truck', { truckId: 'T9', until: '2026-10-22T18:30:00-07:00' });
  assert.equal(wd.gate(a()).verdict, 'allowed'); // 2:55
  world.advance(10 * MIN);
  assert.equal(wd.gate(a()).verdict, 'allowed'); // 3:05
  world.advance(10 * MIN);
  assert.equal(wd.gate(a()).tripKind, 'repeat_tool'); // 3:15
  assert.equal(trips(world, 'repeat_tool').length, 1);
});

test('6. repeat call: blocked within 20 min unless something material changed; trips on 2nd block', () => {
  const { world, wd } = setup();
  const call = () => p(world, 'call_driver', { truckId: 'T4', goal: 'learn_queue' });
  assert.equal(wd.gate(call()).verdict, 'allowed');
  world.advance(6 * MIN);
  assert.equal(wd.gate(call()).tripKind, 'repeat_call');
  assert.equal(trips(world, 'repeat_call').length, 0);
  world.advance(1 * MIN);
  assert.equal(wd.gate(call()).tripKind, 'repeat_call');
  assert.equal(trips(world, 'repeat_call').length, 1);
  world.advance(1 * MIN);
  world.setWait('otay_mesa', 'standard', 140); // Δ 22 ≥ 15 → material
  assert.equal(wd.gate(call()).verdict, 'allowed');
});

test('6b. repeat escalation: no second call to Ana about the same truck within 20 min', () => {
  const { world, wd } = setup();
  const esc = () => p(world, 'escalate_to_dispatcher', { truckId: 'T4', args: { truck_ids: ['T4'], summary: 'T4 may be late' } });
  assert.equal(wd.gate(esc()).verdict, 'allowed');
  world.advance(11 * MIN); // new idempotency bucket
  assert.equal(wd.gate(esc()).tripKind, 'repeat_call');
  world.setWait('otay_mesa', 'standard', 140); // material change
  assert.equal(wd.gate(esc()).verdict, 'allowed');
});

test('7. not worth it: instruction calls with no score benefit are blocked; learn_queue exempt', () => {
  const { world, wd } = setup();
  const r = wd.gate(p(world, 'call_driver', { truckId: 'T8', goal: 'check_status' })); // at yard, nothing to gain
  assert.equal(r.tripKind, 'not_worth_it');
  // A reassign that gains score makes the follow-up instruction call worth it.
  assert.equal(wd.gate(p(world, 'reassign_truck', { truckId: 'T6', port: 'tecate', lane: 'standard' })).verdict, 'allowed');
  assert.equal(wd.gate(p(world, 'call_driver', { truckId: 'T6', goal: 'give_instruction' })).verdict, 'allowed');
  assert.equal(wd.gate(p(world, 'call_driver', { truckId: 'T8', goal: 'learn_queue' })).verdict, 'allowed');
});

test('8. no progress: 4 requests without ≥5 min improvement while spending ≥$0.15 pauses 30 min', () => {
  const { world, wd, escalations } = setup();
  world.fleetDelay = 300;
  for (let i = 0; i < 5; i++) {
    wd.addCost(0.05);
    wd.afterRequest();
    world.advance(3 * MIN);
  }
  assert.ok(wd.isPaused());
  assert.equal(trips(world, 'no_progress').length, 1);
  world.advance(2 * MIN);
  wd.tick();
  assert.equal(escalations.length, 1);
  world.advance(30 * MIN);
  wd.tick();
  assert.ok(!wd.isPaused());
  assert.ok(world.events.some((e) => e.type === 'watchdog.resolved' && e.payload.by === 'auto'));
});

test('9. no answer: 2 consecutive no-answers trip, further calls to that driver are blocked', () => {
  const { world, wd } = setup();
  wd.noAnswer('T6');
  assert.equal(trips(world, 'no_answer').length, 0);
  wd.noAnswer('T6');
  assert.equal(trips(world, 'no_answer').length, 1);
  assert.equal(wd.gate(p(world, 'call_driver', { truckId: 'T6', goal: 'learn_queue' })).tripKind, 'no_answer');
});

test('resolution: Ana keeps current → watchdog.resolved, truck unfrozen but locked 30 min', () => {
  const { world, wd, escalations } = setup();
  wd.seedAssignment('T7', 'otay_mesa', 'standard');
  for (const port of ['tecate', 'otay_mesa', 'tecate'] as PortId[]) {
    wd.gate(p(world, 'reassign_truck', { truckId: 'T7', port, lane: 'standard' }));
    world.advance(2 * MIN);
  }
  wd.tick();
  assert.equal(escalations.length, 1);
  wd.resolve({ tripIds: escalations[0]!.tripIds, decision: 'keep_current', note: 'Keep Pedro on Otay.' });
  assert.ok(!wd.isFrozen('T7'));
  assert.ok(world.events.some((e) => e.type === 'watchdog.resolved' && e.payload.by === 'dispatcher'));
  assert.equal(wd.gate(p(world, 'reassign_truck', { truckId: 'T7', port: 'tecate', lane: 'standard' })).verdict, 'blocked');
  world.advance(31 * MIN);
  assert.equal(wd.gate(p(world, 'reassign_truck', { truckId: 'T7', port: 'otay_mesa', lane: 'fast' })).verdict, 'allowed');
});
