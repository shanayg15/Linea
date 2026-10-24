import { create } from 'zustand';
import type {
  LineaEvent,
  Metrics,
  MetricsPoint,
  PayloadOf,
  PortStatus,
  SimClock,
  WatchdogStatus,
  WorldView,
} from '@shared/types';

export type FeedItem =
  | { kind: 'decision'; id: string; e: PayloadOf<'agent.decision'>; simTime: string }
  | { kind: 'blocked'; id: string; e: PayloadOf<'tool.gate'>; simTime: string }
  | { kind: 'trip'; id: string; e: PayloadOf<'watchdog.trip'>; simTime: string }
  | {
      kind: 'call';
      id: string;
      e: PayloadOf<'call.ended'> & { personName: string; truckId: string | null; mode: 'live' | 'simulated' };
      simTime: string;
    }
  | { kind: 'report'; id: string; e: PayloadOf<'queue.report'>; simTime: string }
  | { kind: 'resolved'; id: string; e: PayloadOf<'watchdog.resolved'>; simTime: string };

export interface Utterance {
  id: string;
  speaker: 'linea' | 'human';
  text: string;
  textEnglish: string | null;
}

export interface CallState {
  started: PayloadOf<'call.started'>;
  status: string;
  startedAtWall: number;
  utterances: Utterance[];
  tools: { tool: string; result: string }[];
  ended?: PayloadOf<'call.ended'>;
  endedAtWall?: number;
  lastSpeaker: 'linea' | 'human' | null;
  lastSpeechAt: number;
}

export type ConnState = 'mock' | 'connecting' | 'open' | 'error';

export interface Snapshot {
  linea: WorldView;
  baseline: WorldView;
  clock: SimClock;
  metrics: { linea: Metrics; baseline: Metrics } | null;
  series: MetricsPoint[];
  watchdog: WatchdogStatus | null;
  recent: LineaEvent[];
}

interface UiState {
  clock: SimClock | null;
  linea: WorldView | null;
  baseline: WorldView | null;
  prevTick: { at: number; linea: WorldView; baseline: WorldView } | null;
  lastTickAt: number;
  ports: PortStatus[];
  live: Record<string, PayloadOf<'live.cbp'>>;
  feed: FeedItem[];
  calls: Record<string, CallState>;
  activeCallId: string | null;
  callsToday: number;
  watchdog: WatchdogStatus | null;
  activeTrip: PayloadOf<'watchdog.trip'> | null;
  resolvedFlash: { tripId: string; resolution: string; at: number } | null;
  metrics: { linea: Metrics; baseline: Metrics } | null;
  series: MetricsPoint[];
  queueReports: PayloadOf<'queue.report'>[];
  lastThinkingAt: number;
  policyView: 'linea' | 'baseline';
  endCard: boolean;
  debug: boolean;
  toast: { text: string; at: number } | null;
  conn: ConnState;
  lastSeq: number;
  eventCounts: Record<string, number>;

  ingest(e: LineaEvent): void;
  hydrate(s: Snapshot): void;
  reset(): void;
  setPolicyView(v: 'linea' | 'baseline'): void;
  togglePolicyView(): void;
  setEndCard(v: boolean): void;
  toggleDebug(): void;
  showToast(text: string): void;
  setConn(c: ConnState): void;
}

const FEED_MAX = 60;
const TRIP_TIMEOUT_MS = 12_000;
const CALL_LINGER_MS = 4_000;

// Dedupe across snapshot + SSE replay (the server resends recent events on reconnect).
const seenIds = new Set<string>();
const seenOrder: string[] = [];
function firstSeen(id: string): boolean {
  if (seenIds.has(id)) return false;
  seenIds.add(id);
  seenOrder.push(id);
  if (seenOrder.length > 5000) seenIds.delete(seenOrder.shift()!);
  return true;
}

const initial = {
  clock: null,
  linea: null,
  baseline: null,
  prevTick: null,
  lastTickAt: 0,
  ports: [],
  live: {},
  feed: [],
  calls: {},
  activeCallId: null,
  callsToday: 0,
  watchdog: null,
  activeTrip: null,
  resolvedFlash: null,
  metrics: null,
  series: [],
  queueReports: [],
  lastThinkingAt: 0,
  lastSeq: 0,
  eventCounts: {},
} satisfies Partial<UiState>;

export const useStore = create<UiState>()((set, get) => {
  const pushFeed = (item: FeedItem) => set((s) => ({ feed: [item, ...s.feed].slice(0, FEED_MAX) }));

  const updateCall = (callId: string, fn: (c: CallState) => CallState) =>
    set((s) => {
      const c = s.calls[callId];
      return c ? { calls: { ...s.calls, [callId]: fn(c) } } : {};
    });

  return {
    ...initial,
    policyView: 'linea',
    endCard: false,
    debug: false,
    toast: null,
    conn: 'connecting',

    ingest(e) {
      const now = performance.now();
      set((s) => ({ lastSeq: Math.max(s.lastSeq, e.seq), eventCounts: { ...s.eventCounts, [e.type]: (s.eventCounts[e.type] ?? 0) + 1 } }));
      if (e.type !== 'world.tick' && !firstSeen(e.id)) return;

      switch (e.type) {
        case 'world.tick': {
          const s = get();
          set({
            prevTick: s.linea && s.baseline ? { at: s.lastTickAt, linea: s.linea, baseline: s.baseline } : null,
            linea: e.payload.linea,
            baseline: e.payload.baseline,
            clock: e.payload.clock,
            ports: e.payload.linea.ports,
            lastTickAt: now,
          });
          break;
        }
        case 'sim.control': {
          const { note: _note, ...clock } = e.payload;
          set({ clock });
          break;
        }
        case 'live.cbp':
          set((s) => ({ live: { ...s.live, [`${e.payload.portId}:${e.payload.lane}`]: e.payload } }));
          break;
        case 'agent.thinking':
          set({ lastThinkingAt: now });
          break;
        case 'agent.decision':
          set({ lastThinkingAt: now });
          if (e.payload.action !== 'no_action') pushFeed({ kind: 'decision', id: e.id, e: e.payload, simTime: e.simTime });
          break;
        case 'tool.gate':
          if (e.payload.verdict === 'blocked') pushFeed({ kind: 'blocked', id: e.id, e: e.payload, simTime: e.simTime });
          break;
        case 'watchdog.trip': {
          pushFeed({ kind: 'trip', id: e.id, e: e.payload, simTime: e.simTime });
          set({ activeTrip: e.payload });
          const tripId = e.payload.tripId;
          setTimeout(() => {
            if (get().activeTrip?.tripId === tripId) set({ activeTrip: null });
          }, TRIP_TIMEOUT_MS);
          break;
        }
        case 'watchdog.resolved':
          pushFeed({ kind: 'resolved', id: e.id, e: e.payload, simTime: e.simTime });
          set((s) => ({
            activeTrip: s.activeTrip?.tripId === e.payload.tripId ? null : s.activeTrip,
            resolvedFlash: { tripId: e.payload.tripId, resolution: e.payload.resolution, at: now },
          }));
          break;
        case 'watchdog.status':
          set({ watchdog: e.payload });
          break;
        case 'queue.report':
          pushFeed({ kind: 'report', id: e.id, e: e.payload, simTime: e.simTime });
          set((s) => ({ queueReports: [...s.queueReports, e.payload] }));
          break;
        case 'call.started':
          set((s) => ({
            calls: {
              ...s.calls,
              [e.payload.callId]: {
                started: e.payload,
                status: 'ringing',
                startedAtWall: now,
                utterances: [],
                tools: [],
                lastSpeaker: null,
                lastSpeechAt: 0,
              },
            },
            activeCallId: e.payload.callId,
            callsToday: s.callsToday + 1,
          }));
          break;
        case 'call.status':
          updateCall(e.payload.callId, (c) => ({ ...c, status: e.payload.status }));
          break;
        case 'call.transcript': {
          const p = e.payload;
          updateCall(p.callId, (c) => {
            const idx = c.utterances.findIndex((u) => u.id === p.utteranceId);
            const u: Utterance = {
              id: p.utteranceId,
              speaker: p.speaker,
              text: p.text,
              textEnglish: p.textEnglish ?? (idx >= 0 ? c.utterances[idx]!.textEnglish : null),
            };
            const utterances = idx >= 0 ? c.utterances.map((x, i) => (i === idx ? u : x)) : [...c.utterances, u];
            // A translation re-emit (same id, same text) isn't new speech.
            const isNewSpeech = idx < 0 || c.utterances[idx]!.text !== p.text;
            return isNewSpeech ? { ...c, utterances, lastSpeaker: p.speaker, lastSpeechAt: now } : { ...c, utterances };
          });
          break;
        }
        case 'call.tool':
          updateCall(e.payload.callId, (c) => ({ ...c, tools: [...c.tools, { tool: e.payload.tool, result: e.payload.result }] }));
          break;
        case 'call.ended': {
          const callId = e.payload.callId;
          const c = get().calls[callId];
          updateCall(callId, (x) => ({ ...x, ended: e.payload, endedAtWall: now, status: e.payload.outcome === 'no_answer' ? 'no_answer' : 'completed' }));
          pushFeed({
            kind: 'call',
            id: e.id,
            e: { ...e.payload, personName: c?.started.personName ?? 'Driver', truckId: c?.started.truckId ?? null, mode: c?.started.mode ?? 'simulated' },
            simTime: e.simTime,
          });
          setTimeout(() => {
            if (get().activeCallId === callId) set({ activeCallId: null });
          }, CALL_LINGER_MS);
          break;
        }
        case 'metrics.update':
          set((s) => {
            const pt = e.payload.point;
            const series = s.series.some((x) => x.t === pt.t) ? s.series.map((x) => (x.t === pt.t ? pt : x)) : [...s.series, pt];
            series.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
            return { metrics: { linea: e.payload.linea, baseline: e.payload.baseline }, series };
          });
          break;
        case 'port.update':
        case 'agent.usage':
        case 'escalation':
          break;
      }
    },

    hydrate(snap) {
      set({
        linea: snap.linea,
        baseline: snap.baseline,
        clock: snap.clock,
        ports: snap.linea.ports,
        metrics: snap.metrics,
        series: snap.series,
        watchdog: snap.watchdog,
        lastTickAt: performance.now(),
      });
      for (const e of snap.recent) get().ingest(e);
    },

    reset() {
      seenIds.clear();
      seenOrder.length = 0;
      set({ ...initial });
    },

    setPolicyView: (policyView) => set({ policyView }),
    togglePolicyView: () => set((s) => ({ policyView: s.policyView === 'linea' ? 'baseline' : 'linea' })),
    setEndCard: (endCard) => set({ endCard }),
    toggleDebug: () => set((s) => ({ debug: !s.debug })),
    showToast: (text) => set({ toast: { text, at: performance.now() } }),
    setConn: (conn) => set({ conn }),
  };
});
