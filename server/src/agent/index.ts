import { ulid } from 'ulid';
import type { Agent, WorldApi } from '../world/api';
import type { ProposedAction } from './types';
import { getVoice } from '../voice';
import { runChaos } from './chaos';
import { assertPricesFilled, MODELS } from './cost';
import { createDispatcher, type Dispatcher } from './dispatcher';
import { createWatchdog, type Watchdog } from './watchdog';

export function createAgent(world: WorldApi): Agent {
  assertPricesFilled([MODELS.dispatch, MODELS.degraded, MODELS.voice]);
  let watchdog: Watchdog;
  let dispatcher: Dispatcher;
  // Hooks look up the current watchdog so they survive a reset.
  const voice = getVoice(world, {
    onNoAnswer: (truckId) => watchdog.noAnswer(truckId),
    onAnswered: (truckId) => watchdog.answered(truckId),
    onCost: (usd) => watchdog.addCost(usd),
    onDispatcherDecision: (d) => watchdog.resolve(d),
  });

  function build() {
    watchdog = createWatchdog(world);
    watchdog.attachVoice(voice);
    dispatcher = createDispatcher(world, watchdog, voice);
    watchdog.attachDispatcher(dispatcher);
    watchdog.emitStatus();
  }
  build();

  /**
   * Hotkey C: phone the driver already in the Otay Mesa line (the live phone, Carlos/T4, when he's there) and ask how
   * long the Mexican-side queue is. Goes through the watchdog gate like any agent action; falls back to letting the
   * dispatcher pick a driver when nobody is in line at Otay.
   */
  function requestQueueReport() {
    const trucks = world.view().trucks;
    const inLine = trucks.filter((t) => t.port === 'otay_mesa' && (t.state === 'in_queue_mx' || t.state === 'in_queue_us'));
    const target = inLine.find((t) => t.phoneMode === 'live') ?? inLine[0];
    if (!target) {
      dispatcher.trigger('operator: ask a driver in line at Otay Mesa for the real queue length');
      return;
    }
    const src = world.view().ports.find((p) => p.id === 'otay_mesa')?.standard.source.id;
    const p: ProposedAction = {
      toolCallId: ulid(),
      tool: 'call_driver',
      args: {
        truck_id: target.id,
        goal: 'learn_queue',
        operator: true,
        title: `Calling ${target.driverName} for the Mexican-side line`,
        reasoning: `CBP only measures the US side. ${target.driverName} is already in the Otay Mesa line and can see the Mexican side.`,
        source_ids: src ? [src] : [],
      },
      truckId: target.id,
      goal: 'learn_queue',
      sourceIds: src ? [src] : [],
      origin: 'agent',
    };
    void dispatcher
      .gateAndExecute(p, MODELS.dispatch)
      .then((d) => d && world.bus.emit('agent.decision', d))
      .catch((err) => console.error('[agent] queue report call failed', err));
  }

  return {
    trigger: (reason, detail) => dispatcher.trigger(reason, detail),
    handleControl(c) {
      switch (c.cmd) {
        case 'budget_squeeze':
          watchdog.squeezeBudget();
          break;
        case 'chaos_flip':
          void runChaos(world, watchdog, dispatcher);
          break;
        case 'request_queue_report':
          requestQueueReport();
          break;
        case 'reset':
          // The world restarts at 1:30 PM: drop budget, histories, freezes and timers from the old run.
          dispatcher.stop();
          watchdog.stop();
          build();
          break;
      }
    },
    stop() {
      dispatcher.stop();
      watchdog.stop();
    },
  };
}
