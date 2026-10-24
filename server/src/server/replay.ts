// MODE=replay: stream a recorded run through the bus with its original wall timing.
import { readFileSync } from 'node:fs';
import type { LineaEvent, SimClock, ControlCmd } from '../../../shared/types';
import type { Bus } from './bus';

type Rec = LineaEvent & { wallMs: number };
const LOOP_MS = 50;
const SPEED_MULT: Record<number, number> = { 1: 1, 20: 3, 60: 6 };

export class Replay {
  private recs: Rec[];
  private i = 0;
  private vt = 0;
  private mult = 1;
  private speedCmd: 1 | 20 | 60 = 1;
  paused = false;
  private timer: NodeJS.Timeout | null = null;
  private lastClock: SimClock | null = null;

  constructor(private readonly bus: Bus, readonly file: string, startPaused = false) {
    this.recs = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l) as Rec; } catch { return null; }
      })
      .filter((r): r is Rec => !!r && typeof r.type === 'string');
    const t0 = this.recs[0]?.wallMs ?? 0;
    for (const r of this.recs) r.wallMs = (r.wallMs ?? 0) - t0;
    this.paused = startPaused;
    console.log(`[replay] loaded ${this.recs.length} events from ${file} (${((this.recs.at(-1)?.wallMs ?? 0) / 1000).toFixed(0)} s)`);
  }

  get length(): number {
    return this.recs.length;
  }

  start(): void {
    this.timer = setInterval(() => this.loop(), LOOP_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  simTime(): string {
    return this.lastClock?.simTime ?? this.recs[0]?.simTime ?? new Date().toISOString();
  }

  private patchClock(c: SimClock): SimClock {
    return { ...c, mode: 'replay', paused: this.paused };
  }

  private loop(): void {
    try {
      if (this.paused) return;
      this.vt += LOOP_MS * this.mult;
      while (this.i < this.recs.length && this.recs[this.i].wallMs <= this.vt) {
        const r = this.recs[this.i++];
        let payload = r.payload as LineaEvent['payload'];
        if (r.type === 'world.tick') {
          const p = r.payload as Extract<LineaEvent, { type: 'world.tick' }>['payload'];
          this.lastClock = this.patchClock(p.clock);
          payload = { ...p, clock: this.lastClock };
        } else if (r.type === 'sim.control') {
          payload = { ...this.patchClock(r.payload as SimClock), note: (r.payload as { note?: string }).note };
        }
        this.bus.publishRaw({ type: r.type, simTime: r.simTime, payload } as LineaEvent);
      }
      if (this.i >= this.recs.length) {
        this.paused = true;
        this.emitControl('replay ended');
      }
    } catch (err) {
      console.error('[replay] loop error', err);
    }
  }

  private emitControl(note: string): void {
    const c = this.lastClock ?? { simTime: this.simTime(), speed: 60, paused: this.paused, mode: 'replay', scenarioStep: 'calm' };
    this.bus.emit('sim.control', { ...c, mode: 'replay', paused: this.paused, note });
  }

  clockState(): SimClock | null {
    return this.lastClock ? { ...this.lastClock, paused: this.paused } : null;
  }

  control(cmd: ControlCmd): void {
    switch (cmd.cmd) {
      case 'pause': this.paused = true; this.emitControl('paused'); break;
      case 'play':
        if (this.i >= this.recs.length) this.restart();
        this.paused = false;
        this.emitControl('playing');
        break;
      case 'speed':
        this.speedCmd = cmd.value;
        this.mult = SPEED_MULT[cmd.value] ?? 1;
        this.emitControl(`replay speed ×${this.mult}`);
        break;
      case 'reset': this.restart(); break;
      default: this.emitControl(`${cmd.cmd} ignored in replay`); break;
    }
  }

  private restart(): void {
    this.i = 0;
    this.vt = 0;
    this.lastClock = null;
    this.bus.clearRing();
    this.emitControl('reset');
  }
}
