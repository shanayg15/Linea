// hardware/bridge.ts - drives Ana's desk beacon from the Linea event stream
import { SerialPort, ReadlineParser } from 'serialport';

const API = process.env.LINEA_API ?? 'http://localhost:8787';
const BAUD = Number(process.env.BEACON_BAUD ?? 115200);
const MOTOR = process.env.BEACON_MOTOR === '1';
const args = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let port: SerialPort;
let ready = false;
let lastSent = '';

function send(cmd: string, force = false) {
  if (!ready) return;
  if (!force && cmd === lastSent) return;
  lastSent = cmd;
  port.write(cmd + '\n');
  console.log(new Date().toLocaleTimeString(), '->', cmd);
}

async function findPort(): Promise<string> {
  if (process.env.BEACON_PORT) return process.env.BEACON_PORT;
  const ports = await SerialPort.list();
  const hit = ports.find(
    (p) =>
      /usbmodem|usbserial|wchusbserial|SLAB_USB|ttyACM|ttyUSB/i.test(p.path) ||
      /arduino|wch|silicon labs|ftdi|espressif/i.test(p.manufacturer ?? '') ||
      /^(2341|1a86|10c4|0403|303a)$/i.test(p.vendorId ?? ''),
  );
  if (!hit) {
    console.error('No beacon found. Ports:', ports.map((p) => `${p.path} (${p.manufacturer ?? '?'})`));
    console.error('Set BEACON_PORT=/dev/tty.xxx and retry.');
    process.exit(1);
  }
  return hit.path;
}

async function openPort() {
  const path = await findPort();
  port = new SerialPort({ path, baudRate: BAUD });
  port.on('open', () => {
    port.set({ dtr: true, rts: true }, (err) => {
      if (err) console.warn('[serial] dtr/rts notice:', err.message);
    });
  });
  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
  parser.on('data', (raw: string) => {
    const line = raw.trim();
    if (line === 'LINEA_BEACON_READY') {
      ready = true;
      console.log('Beacon ready on', path);
      send('IDLE', true);
    } else if (line) console.log('   <-', line);
  });
  port.on('error', (e) => console.error('Serial error:', e.message));
  // Opening the port resets most Arduinos (banner arrives ~1.5 s later). ESP32 often doesn't reset.
  setTimeout(() => {
    if (!ready) { ready = true; send('IDLE', true); }
  }, 500);
  while (!ready) await sleep(100);
}

// ---------------- state machine ----------------
const NEEDS_HUMAN_KINDS = new Set(['oscillation', 'no_answer', 'no_progress', 'budget', 'repeat_tool', 'repeat_call']);
const NEEDS_HUMAN_RESPONSES = new Set(['escalated', 'paused', 'stopped']);
const alerts = new Set<string>();
const dispatcherCalls = new Set<string>();
let ringing = false;
let whiteActive = false;
let lastAlertAt = 0;
let connectedAt = 0;

const base = () => (ringing ? 'RING' : alerts.size ? 'RING' : whiteActive ? 'WHITE' : 'IDLE');

function resetState() {
  alerts.clear(); dispatcherCalls.clear(); ringing = false; whiteActive = false;
  send('IDLE', true);
}

function onEvent(e: any) {
  // On connect the server replays its recent backlog: ignore that burst.
  if (Date.now() - connectedAt < 800) return;
  const p = e.payload ?? {};
  switch (e.type) {
    case 'sim.control':
      if (p.note === 'reset' || p.note?.includes('reset')) {
        console.log('[bridge] Simulation reset: returning beacon to GREEN');
        resetState();
      }
      break;

    case 'port.update':
      // When a spike occurs (wait >= 60 min), transition light to WHITE
      if (Number(p.waitMin) >= 60 && alerts.size === 0 && !ringing) {
        whiteActive = true;
        send('WHITE');
      }
      break;

    case 'agent.decision':
    case 'agent.thinking': {
      // Re-planning: transition to WHITE while evaluating options
      if (!ringing && alerts.size === 0) {
        whiteActive = true;
        send('WHITE');
      }
      if (MOTOR && e.type === 'agent.decision' && Array.isArray(p.truckIds) && p.truckIds.includes('T4')) {
        if (p.action === 'hold') send('BUZZ_HOLD', true);
        else if (p.action === 'dispatch' || p.action === 'reassign') send('BUZZ_GO', true);
      }
      break;
    }

    case 'watchdog.trip':
      if (NEEDS_HUMAN_KINDS.has(p.kind) || NEEDS_HUMAN_RESPONSES.has(p.response)) {
        alerts.add(p.tripId);
        lastAlertAt = Date.now();
        send('RING'); // Flashing Red on problem
      }
      break;

    case 'tool.gate':
      if (p.verdict === 'blocked' && p.tripKind) {
        alerts.add(`gate:${p.toolCallId ?? Date.now()}`);
        lastAlertAt = Date.now();
        send('RING'); // Flashing Red
      }
      break;

    case 'escalation':
      alerts.add(`esc:${p.escalationId}`);
      lastAlertAt = Date.now();
      send('RING'); // Flashing Red
      break;

    case 'call.started':
      if (p.kind === 'dispatcher') {
        dispatcherCalls.add(p.callId);
        ringing = true;
        lastAlertAt = Date.now();
        send('RING'); // Flashing Red
      }
      break;

    case 'call.status':
      if (dispatcherCalls.has(p.callId)) {
        if (p.status === 'ringing') {
          ringing = true;
          send('RING');
        } else {
          send(base());
        }
      } else if (p.status === 'failed') {
        alerts.add(`callfail:${p.callId}`);
        lastAlertAt = Date.now();
        send('RING');
      }
      break;

    case 'call.ended':
      if (dispatcherCalls.has(p.callId)) {
        dispatcherCalls.delete(p.callId);
        ringing = false;
        whiteActive = false;
        for (const id of [...alerts]) if (id.startsWith('esc:')) alerts.delete(id);
        send(alerts.size ? 'RING' : 'OK', true);
      } else if (p.outcome === 'failed') {
        alerts.add(`callfail:${p.callId}`);
        lastAlertAt = Date.now();
        send('RING');
      }
      break;

    case 'watchdog.resolved':
      alerts.delete(p.tripId);
      whiteActive = false;
      for (const id of [...alerts]) if (id.startsWith('gate:') || id.startsWith('callfail:')) alerts.delete(id);
      if (!alerts.size && !ringing) send('OK', true);
      break;
  }
}

// Safety net: never stay red forever during rehearsals.
setInterval(() => {
  if ((alerts.size || ringing) && Date.now() - lastAlertAt > 90_000) {
    console.log('Alert open > 90 s with no resolution: back to idle');
    resetState();
  }
}, 5000);

async function stream() {
  for (;;) {
    try {
      const res = await fetch(`${API}/events`, { headers: { Accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      connectedAt = Date.now();
      console.log('Connected to', `${API}/events`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (!data || data.includes('"type":"world.tick"')) continue; // skip the 4 Hz position spam
          try { onEvent(JSON.parse(data)); } catch { /* ignore malformed */ }
        }
      }
    } catch (err) {
      console.warn('Stream error, retrying in 1 s:', (err as Error).message);
    }
    resetState();
    await sleep(1000);
  }
}

async function demo() {
  const seq = ['IDLE', 'THINK', 'IDLE', 'ALERT', 'RING', 'ALERT', 'OK'];
  for (;;) for (const c of seq) { send(c, true); await sleep(2000); }
}

await openPort();
if (args[0] === '--demo') await demo();
else if (args[0] === '--send') { send((args[1] ?? 'IDLE').toUpperCase(), true); await sleep(500); process.exit(0); }
else await stream();
