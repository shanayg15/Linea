import { useEffect } from 'react';
import type { ControlCmd } from '@shared/types';
import { useStore } from '../data/store';
import { IS_MOCK, control, isMockPaused } from '../data/stream';

const COMMANDS: Record<string, { cmd: ControlCmd; toast: string }> = {
  '1': { cmd: { cmd: 'speed', value: 1 }, toast: 'Speed 1×' },
  '2': { cmd: { cmd: 'speed', value: 20 }, toast: 'Speed 20×' },
  '3': { cmd: { cmd: 'speed', value: 60 }, toast: 'Speed 60×' },
  s: { cmd: { cmd: 'inject_spike' }, toast: 'Spike injected' },
  c: { cmd: { cmd: 'request_queue_report' }, toast: 'Queue report requested' },
  m: { cmd: { cmd: 'inject_missed_call' }, toast: 'Missed call armed' },
  o: { cmd: { cmd: 'inject_oscillation' }, toast: 'Oscillation injected' },
  b: { cmd: { cmd: 'budget_squeeze' }, toast: 'Budget squeezed' },
};

export function Hotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const s = useStore.getState();
      const key = e.key.toLowerCase();
      const send = (cmd: ControlCmd, toast: string) => {
        void control(cmd);
        s.showToast(toast);
      };

      if (e.code === 'Space') {
        e.preventDefault();
        const paused = IS_MOCK ? isMockPaused() : s.clock?.paused ?? false;
        send({ cmd: paused ? 'play' : 'pause' }, paused ? 'Playing' : 'Paused');
      } else if (key === 'o' && e.shiftKey) {
        send({ cmd: 'chaos_flip' }, 'Chaos test started');
      } else if (key === 'r') {
        if (e.shiftKey) send({ cmd: 'reset' }, 'Reset');
      } else if (key === 'l') {
        s.togglePolicyView();
      } else if (key === 'f') {
        s.setEndCard(!s.endCard);
      } else if (key === 'escape') {
        s.setEndCard(false);
      } else if (key === 'd') {
        s.toggleDebug();
      } else if (!e.shiftKey && COMMANDS[key]) {
        send(COMMANDS[key].cmd, COMMANDS[key].toast);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
