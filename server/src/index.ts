// Linea server entry: bus → clock/scenario/sim → metrics → CBP → HTTP; agent + voice wired per SPEC §4.1.
import { fromRoot } from './server/env';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import type { ControlCmd } from '../../shared/types';
import type { Agent } from './world/api';
import { Bus } from './server/bus';
import { SnapshotStore } from './server/snapshot';
import { Recorder } from './server/recorder';
import { Replay } from './server/replay';
import { mountHttp } from './server/http';
import { World } from './world/sim';
import { asSpeed } from './world/clock';
import { createMockAgent } from './world/mockAgent';
import { startCbpPoller } from './world/cbp';

const MODE = process.env.MODE === 'replay' ? 'replay' : 'live';
let AGENT_MODE: 'claude' | 'mock' = process.env.AGENT_MODE === 'mock' ? 'mock' : 'claude';
const PORT = Number(process.env.PORT || 8787);
const SEED = Number(process.env.SIM_SEED || 1022);
const SPEED = asSpeed(process.env.SIM_SPEED, 60);
const START_PAUSED = process.env.START_PAUSED === '1';
const AGENT_CMDS = new Set(['budget_squeeze', 'chaos_flip', 'request_queue_report']);

let simTime: () => string = () => new Date().toISOString();
const bus = new Bus(() => simTime());
const snapshot = new SnapshotStore(bus);
const recorder = new Recorder(bus);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const httpServer = http.createServer(app);

let world: World | null = null;
let replay: Replay | null = null;
let agent: Agent | null = null;

function recordingCmd(cmd: ControlCmd): Record<string, unknown> | null {
  if (cmd.cmd === 'start_recording') {
    const file = recorder.start();
    bus.emit('sim.control', { ...(world?.clockState() ?? replay?.clockState() ?? fallbackClock()), note: `recording → ${file}` });
    return { file };
  }
  if (cmd.cmd === 'stop_recording') {
    bus.emit('sim.control', { ...(world?.clockState() ?? replay?.clockState() ?? fallbackClock()), note: 'recording stopped' });
    const file = recorder.stop();
    return { file };
  }
  return null;
}

function fallbackClock() {
  return { simTime: simTime(), speed: SPEED, paused: true, mode: MODE, scenarioStep: 'calm' } as const;
}

if (MODE === 'live') {
  const w = new World(bus, SEED, SPEED);
  world = w;
  simTime = () => w.now();
  if (START_PAUSED) w.clock.paused = true;

  if (AGENT_MODE === 'mock') {
    agent = createMockAgent(w);
  } else {
    try {
      agent = (await import('./agent/index')).createAgent(w);
    } catch (err) {
      console.error('[index] createAgent failed — falling back to the mock agent', err);
      agent = createMockAgent(w);
      AGENT_MODE = 'mock';
    }
    try {
      (await import('./voice/index')).mountVoice(app, httpServer, w);
    } catch (err) {
      console.error('[index] mountVoice failed — continuing without voice', err);
    }
  }
  w.setAgent(agent);
  startCbpPoller(bus, { log: (m) => console.log(`[cbp] ${m}`) });
  w.start();
} else {
  const file = fromRoot(process.env.RUN_FILE || 'runs/demo.jsonl');
  const r = new Replay(bus, file, START_PAUSED);
  replay = r;
  simTime = () => r.simTime();
  r.start();
}

function control(cmd: ControlCmd): Record<string, unknown> | void {
  const rec = recordingCmd(cmd);
  if (rec) return rec;
  if (replay) return replay.control(cmd);
  if (!world) return;
  if (AGENT_CMDS.has(cmd.cmd)) {
    try { agent?.handleControl(cmd); } catch (err) { console.error(`[index] agent.handleControl(${cmd.cmd}) threw`, err); }
    world.control(cmd);
    return;
  }
  world.control(cmd);
  if (cmd.cmd === 'reset') {
    if (START_PAUSED) world.clock.paused = true;
    try { agent?.handleControl(cmd); } catch (err) { console.error('[index] agent.handleControl(reset) threw', err); }
  }
}

mountHttp(app, {
  bus,
  snapshot,
  control,
  health: () => ({ mode: MODE, agentMode: MODE === 'replay' ? 'none' : AGENT_MODE, simTime: world ? world.now() : replay?.simTime() ?? null }),
});

httpServer.listen(PORT, () => {
  console.log('────────────────────────────────────────');
  console.log(' Linea server');
  console.log(`  mode        ${MODE}${MODE === 'replay' ? ` (${replay?.file})` : ''}`);
  console.log(`  agent       ${MODE === 'replay' ? 'none' : AGENT_MODE}`);
  console.log(`  port        ${PORT}  → http://localhost:${PORT}/health`);
  console.log(`  public url  ${process.env.PUBLIC_BASE_URL || '(unset — live calls disabled)'}`);
  console.log(`  seed/speed  ${SEED} / ${SPEED}×${START_PAUSED ? ' (start paused)' : ''}`);
  console.log('────────────────────────────────────────');
});

function shutdown() {
  recorder.stop();
  try { agent?.stop(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => console.error('[index] uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('[index] unhandledRejection', err));
