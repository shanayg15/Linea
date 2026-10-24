import type { Agent, WorldApi } from '../world/api';
import { getVoice } from '../voice';
import { runChaos } from './chaos';
import { assertPricesFilled, MODELS } from './cost';
import { createDispatcher } from './dispatcher';
import { createWatchdog } from './watchdog';

export function createAgent(world: WorldApi): Agent {
  assertPricesFilled([MODELS.dispatch, MODELS.degraded, MODELS.voice]);
  const watchdog = createWatchdog(world);
  const voice = getVoice(world, {
    onNoAnswer: (truckId) => watchdog.noAnswer(truckId),
    onAnswered: (truckId) => watchdog.answered(truckId),
    onCost: (usd) => watchdog.addCost(usd),
    onDispatcherDecision: (d) => watchdog.resolve(d),
  });
  watchdog.attachVoice(voice);
  const dispatcher = createDispatcher(world, watchdog, voice);
  watchdog.attachDispatcher(dispatcher);
  watchdog.emitStatus();

  return {
    trigger: dispatcher.trigger,
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
      }
    },
    stop() {
      dispatcher.stop();
      watchdog.stop();
    },
  };
}
