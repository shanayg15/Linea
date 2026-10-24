// npx tsx server/src/voice/__call.ts [carlos|ana]
// Live phone test before Track A's server exists: serves the voice routes on :8787 over FakeWorld,
// then rings PHONE_T4_CARLOS (Spanish, learn_queue) or PHONE_DISPATCHER_ANA (English escalation).
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { createFakeWorld } from '../agent/__fake';
import { createAgent } from '../agent';
import { getVoice, mountVoice } from '.';

const who = process.argv[2] === 'ana' ? 'ana' : 'carlos';
const missing = ['ANTHROPIC_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'PUBLIC_BASE_URL', who === 'ana' ? 'PHONE_DISPATCHER_ANA' : 'PHONE_T4_CARLOS'].filter(
  (k) => !process.env[k]?.trim(),
);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}

const world = createFakeWorld({ autoClock: true });
const agent = createAgent(world); // watchdog + cost meter hooks for the voice layer
const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));
const server = createServer(app);
mountVoice(app, server, world);

const SHOW = new Set(['call.started', 'call.status', 'call.transcript', 'call.tool', 'call.ended', 'queue.report', 'agent.usage', 'watchdog.resolved']);
world.bus.on((e) => {
  if (!SHOW.has(e.type)) return;
  const p = e.payload as unknown as Record<string, unknown>;
  if (e.type === 'call.transcript') console.log(`  ${p.speaker === 'linea' ? 'Linea' : 'Human'}: ${p.text}${p.textEnglish && p.textEnglish !== p.text ? `\n         (${p.textEnglish})` : ''}`);
  else console.log(`[${e.type}] ${JSON.stringify(p).slice(0, 200)}`);
  if (e.type === 'call.ended') {
    setTimeout(() => {
      agent.stop();
      server.close();
      process.exit(0);
    }, 4000); // let the last translation land
  }
});

server.listen(Number(process.env.PORT || 8787), async () => {
  console.log(`Voice test server on :${process.env.PORT || 8787}, public ${process.env.PUBLIC_BASE_URL}`);
  const voice = getVoice(world);
  if (who === 'ana') {
    await voice.startDispatcherCall({
      summary: "Pedro's truck keeps flipping between Otay and Tecate because Tecate's feed is flapping, and Iván hasn't answered twice.",
      questions: ['Should I keep Pedro on Otay?'],
      tripIds: [],
    });
  } else {
    await voice.startDriverCall({ truckId: 'T4', goal: 'learn_queue' });
  }
});
