// EventBus per SPEC §4.1: stamps id/seq/simTime/wallTime, ring buffer of 3000 (world.tick kept only as "latest").
import { EventEmitter } from 'node:events';
import { ulid } from 'ulid';
import type { LineaEvent, LineaEventType, PayloadOf } from '../../../shared/types';
import type { EventBus } from '../world/api';

const RING_SIZE = 3000;

export class Bus implements EventBus {
  private readonly ee = new EventEmitter();
  private ring: LineaEvent[] = [];
  private seq = 0;
  latestTick: LineaEvent | null = null;

  constructor(private readonly simTime: () => string) {
    this.ee.setMaxListeners(100);
  }

  emit<T extends LineaEventType>(type: T, payload: PayloadOf<T>): LineaEvent {
    const e = {
      id: ulid(),
      seq: ++this.seq,
      simTime: this.simTime(),
      wallTime: new Date().toISOString(),
      type,
      payload,
    } as LineaEvent;
    this.dispatch(e);
    return e;
  }

  /** Re-publish a recorded event (replay mode): keeps type/payload/simTime, restamps id/seq/wallTime. */
  publishRaw(rec: Pick<LineaEvent, 'type' | 'payload' | 'simTime'>): LineaEvent {
    const e = { ...rec, id: ulid(), seq: ++this.seq, wallTime: new Date().toISOString() } as LineaEvent;
    this.dispatch(e);
    return e;
  }

  private dispatch(e: LineaEvent): void {
    if (e.type === 'world.tick') {
      this.latestTick = e;
    } else {
      this.ring.push(e);
      if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE);
    }
    try {
      this.ee.emit('event', e);
    } catch (err) {
      console.error('[bus] listener error', err);
    }
  }

  on(fn: (e: LineaEvent) => void): () => void {
    const wrapped = (e: LineaEvent) => {
      try {
        fn(e);
      } catch (err) {
        console.error(`[bus] listener threw on ${e.type}`, err);
      }
    };
    this.ee.on('event', wrapped);
    return () => this.ee.off('event', wrapped);
  }

  /** Last n non-tick events, oldest first. */
  recent(n: number): LineaEvent[] {
    return this.ring.slice(-n);
  }

  /** Non-tick events with seq > afterSeq (at most n, newest kept), oldest first. */
  since(afterSeq: number, n: number): LineaEvent[] {
    const out = this.ring.filter((e) => e.seq > afterSeq);
    return out.slice(-n);
  }

  clearRing(): void {
    this.ring = [];
    this.latestTick = null;
  }
}
