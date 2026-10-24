import { useEffect } from 'react';
import type { ControlCmd, LineaEvent } from '@shared/types';
import { useStore, type Snapshot } from './store';

export const IS_MOCK = import.meta.env.VITE_MOCK === '1';
export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

type MockLine = LineaEvent & { wallMs: number };

/** Local replay of fixtures/mock-events.jsonl with original wall-clock gaps. */
class MockPlayer {
  private lines: MockLine[] = [];
  private i = 0;
  private cursorMs = 0; // position in the recording
  private lastFrame = 0;
  private raf = 0;
  paused = false;
  speed = 1;

  async load() {
    const text = await (await fetch('/fixtures/mock-events.jsonl')).text();
    this.lines = text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as MockLine);
  }

  start() {
    // ?seek=90 jumps 90 s into the recording (handy for rehearsing a beat)
    this.cursorMs = Number(new URLSearchParams(location.search).get('seek') ?? 0) * 1000;
    this.lastFrame = performance.now();
    const step = (t: number) => {
      const dt = t - this.lastFrame;
      this.lastFrame = t;
      if (!this.paused) this.cursorMs += dt * this.speed;
      const ingest = useStore.getState().ingest;
      while (this.i < this.lines.length && this.lines[this.i]!.wallMs <= this.cursorMs) {
        const { wallMs: _w, ...e } = this.lines[this.i++]!;
        ingest(e as LineaEvent);
      }
      // Hold the final state at the end (the end card reads it); Shift+R restarts.
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  restart() {
    this.i = 0;
    this.cursorMs = 0;
    useStore.getState().reset();
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }
}

let mock: MockPlayer | null = null;

export function useLineaStream(): void {
  useEffect(() => {
    const { ingest, hydrate, setConn } = useStore.getState();

    if (IS_MOCK) {
      setConn('mock');
      const player = new MockPlayer();
      mock = player;
      let cancelled = false;
      player
        .load()
        .then(() => !cancelled && player.start())
        .catch((err) => console.error('[mock] failed to load fixtures/mock-events.jsonl', err));
      return () => {
        cancelled = true;
        player.stop();
        mock = null;
      };
    }

    setConn('connecting');
    const es = new EventSource(`${API_URL}/events`);
    es.onopen = () => {
      setConn('open');
      fetch(`${API_URL}/snapshot`)
        .then((r) => r.json() as Promise<Snapshot>)
        .then(hydrate)
        .catch((err) => console.error('[stream] snapshot failed', err));
    };
    es.onmessage = (m) => {
      try {
        ingest(JSON.parse(m.data) as LineaEvent);
      } catch (err) {
        console.error('[stream] bad event', err);
      }
    };
    es.onerror = () => setConn('error'); // EventSource reconnects on its own
    return () => es.close();
  }, []);
}

export async function control(cmd: ControlCmd): Promise<void> {
  if (cmd.cmd === 'reset') useStore.getState().reset();
  if (IS_MOCK) {
    if (!mock) return;
    if (cmd.cmd === 'pause') mock.paused = true;
    else if (cmd.cmd === 'play') mock.paused = false;
    else if (cmd.cmd === 'speed') mock.speed = cmd.value === 1 ? 0.25 : cmd.value === 20 ? 0.5 : 1;
    else if (cmd.cmd === 'reset') mock.restart();
    return;
  }
  try {
    await fetch(`${API_URL}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  } catch (err) {
    console.error('[control] failed', err);
  }
}

export function isMockPaused(): boolean {
  return mock?.paused ?? false;
}
