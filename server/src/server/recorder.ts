// JSONL recorder: every bus event (incl. ticks) + wallMs since recording start.
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Bus } from './bus';
import { fromRoot } from './env';

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class Recorder {
  private stream: WriteStream | null = null;
  private startedAt = 0;
  file: string | null = null;
  count = 0;

  constructor(bus: Bus) {
    bus.on((e) => {
      if (!this.stream) return;
      this.count++;
      this.stream.write(JSON.stringify({ ...e, wallMs: Date.now() - this.startedAt }) + '\n');
    });
  }

  get active(): boolean {
    return this.stream !== null;
  }

  start(path?: string): string {
    this.stop();
    const dir = fromRoot('runs');
    mkdirSync(dir, { recursive: true });
    this.file = path ? fromRoot(path) : join(dir, `${stamp()}.jsonl`);
    this.stream = createWriteStream(this.file, { flags: 'w' });
    this.stream.on('error', (err) => console.error('[recorder] write error', err));
    this.startedAt = Date.now();
    this.count = 0;
    console.log(`[recorder] recording → ${this.file}`);
    return this.file;
  }

  stop(): string | null {
    if (!this.stream) return null;
    const f = this.file;
    this.stream.end();
    this.stream = null;
    console.log(`[recorder] stopped (${this.count} events) → ${f}`);
    return f;
  }
}
