import type { Agent, WorldApi } from '../world/api';
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
          dispatcher.trigger('operator: ask a driver in line at Otay Mesa for the real queue length');
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
