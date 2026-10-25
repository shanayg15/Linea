// SPEC §7: GET /events (SSE) · GET /snapshot · POST /control · GET /health.
import type { Express, Request, Response } from 'express';
import type { ControlCmd, LineaEvent } from '../../../shared/types';
import type { Bus } from './bus';
import type { SnapshotStore } from './snapshot';

const REPLAY_ON_CONNECT = 200;
const PING_MS = 15_000;

const CMDS = new Set([
  'pause', 'play', 'speed', 'inject_spike', 'inject_missed_call', 'inject_oscillation', 'chaos_flip',
  'request_queue_report', 'budget_squeeze', 'reset', 'jump', 'start_recording', 'stop_recording',
]);

export interface HttpDeps {
  bus: Bus;
  snapshot: SnapshotStore;
  control: (cmd: ControlCmd) => Record<string, unknown> | void;
  health: () => { mode: string; agentMode: string; simTime: string | null };
}

export function mountHttp(app: Express, deps: HttpDeps): { clients: Set<Response> } {
  const clients = new Set<Response>();
  const frame = (e: LineaEvent) => `id: ${e.seq}\nevent: message\ndata: ${JSON.stringify(e)}\n\n`;

  deps.bus.on((e) => {
    if (clients.size === 0) return;
    const f = frame(e);
    for (const res of clients) {
      try { res.write(f); } catch { clients.delete(res); }
    }
  });

  setInterval(() => {
    for (const res of clients) {
      try { res.write(': ping\n\n'); } catch { clients.delete(res); }
    }
  }, PING_MS).unref();

  app.get('/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();
    req.socket.setNoDelay(true);
    res.write('retry: 2000\n\n');
    const last = Number(req.header('Last-Event-ID') ?? req.query.lastEventId ?? 0) || 0;
    for (const e of deps.bus.since(last, REPLAY_ON_CONNECT)) res.write(frame(e));
    if (deps.bus.latestTick) res.write(frame(deps.bus.latestTick));
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  app.get('/snapshot', (_req, res) => {
    res.json(deps.snapshot.get());
  });

  app.post('/control', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<ControlCmd>;
    if (typeof body.cmd !== 'string' || !CMDS.has(body.cmd)) {
      res.status(400).json({ ok: false, error: `unknown cmd ${String(body.cmd)}` });
      return;
    }
    try {
      const extra = deps.control(body as ControlCmd) ?? {};
      res.json({ ok: true, ...extra });
    } catch (err) {
      console.error('[http] control error', err);
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, ...deps.health(), clients: clients.size });
  });

  return { clients };
}
