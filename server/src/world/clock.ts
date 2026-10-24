// Sim clock: epoch-ms internally, ISO with a fixed -07:00 offset for events.
export const SIM_START = Date.parse('2026-10-22T13:30:00-07:00');
export const SIM_END = Date.parse('2026-10-22T19:30:00-07:00');
export const TICK_MS = 250;
export const MIN = 60_000;

const PT_OFFSET_MS = -7 * 3600_000;

/** ISO string in Pacific (fixed -07:00), independent of server TZ. */
export function toIsoPT(ms: number): string {
  const d = new Date(ms + PT_OFFSET_MS);
  return d.toISOString().slice(0, 19) + '-07:00';
}

export function parseIso(iso: string): number {
  return Date.parse(iso);
}

/** "14:55" (24 h, PT) — used in source ids. */
export function hhmm(ms: number): string {
  return new Date(ms + PT_OFFSET_MS).toISOString().slice(11, 16);
}

/** "2:55 PM" (PT) — used in human labels. */
export function clockLabel(ms: number): string {
  const d = new Date(ms + PT_OFFSET_MS);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Sim ms for "HH:MM" on the replay day. */
export function atPT(hm: string, dayOffset = 0): number {
  return Date.parse(`2026-10-22T${hm}:00-07:00`) + dayOffset * 24 * 3600_000;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Speed = 1 | 20 | 60;

export function asSpeed(n: unknown, fallback: Speed = 60): Speed {
  const v = Number(n);
  return v === 1 || v === 20 || v === 60 ? v : fallback;
}

export class Clock {
  simMs = SIM_START;
  speed: Speed;
  paused = false;
  private savedSpeed: Speed | null = null;

  constructor(private readonly defaultSpeed: Speed) {
    this.speed = defaultSpeed;
  }

  /** Sim ms to advance for one wall tick. */
  stepMs(): number {
    return this.paused ? 0 : this.speed * TICK_MS;
  }

  iso(): string {
    return toIsoPT(this.simMs);
  }

  setSpeed(s: Speed): void {
    this.speed = s;
    this.savedSpeed = null;
  }

  /** Drop to `s` (e.g. 1× during a live call) remembering the previous speed. */
  setClockSpeed(s: Speed): void {
    if (this.savedSpeed === null) this.savedSpeed = this.speed;
    this.speed = s;
  }

  restoreClockSpeed(): void {
    if (this.savedSpeed !== null) {
      this.speed = this.savedSpeed;
      this.savedSpeed = null;
    }
  }

  reset(): void {
    this.simMs = SIM_START;
    this.speed = this.defaultSpeed;
    this.savedSpeed = null;
    this.paused = false;
  }
}
