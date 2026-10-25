// Voice wiring (TRACK_B §B5): Twilio webhooks, ConversationRelay WebSocket, live vs simulated routing.
import express, { type Express } from 'express';
import type { Server } from 'http';
import { WebSocketServer } from 'ws';
import type { StartDispatcherCall, StartDriverCall, Voice, VoiceHooks } from '../agent/types';
import type { WorldApi } from '../world/api';
import { finishCall, liveNumberFor, newCall, publicBaseUrl, publicUrlReachable, setStatus, startLive, twilioStatusToOurs, type VoiceCtx, emitStarted } from './calls';
import { gatherStart, gatherTurn, useGather } from './gather';
import { driverLanguage } from './prompts';
import { greetingFor, handleRelay } from './relay';
import { runSimulatedDispatcherCall, runSimulatedDriverCall } from './simulated';

let ctx: VoiceCtx | null = null;
let voice: Voice | null = null;

const noopHooks: VoiceHooks = { onNoAnswer() {}, onAnswered() {}, onCost() {}, onDispatcherDecision() {} };

export function getVoice(world: WorldApi, hooks: VoiceHooks = noopHooks): Voice {
  if (ctx && voice) {
    if (hooks !== noopHooks) ctx.hooks = hooks;
    return voice;
  }
  const c: VoiceCtx = { world, hooks, calls: new Map(), liveActive: null, liveQueue: [] };
  ctx = c;
  voice = {
    async startDriverCall(req: StartDriverCall) {
      const truck = world.getTruck(req.truckId);
      // LIVE_DRIVER_CALLS=request (default): only the operator's hotkey-C call rings a real phone, so the demo phone
      // never rings off-script; the dispatcher's own calls run as simulated calls. LIVE_DRIVER_CALLS=all lets them ring.
      const liveAllowed = req.operator === true || (process.env.LIVE_DRIVER_CALLS ?? 'request').trim().toLowerCase() === 'all';
      // A dead tunnel would ring the phone and drop the call; fall back to a simulated call instead.
      const to = liveAllowed && liveNumberFor('driver', req.truckId) && (await publicUrlReachable()) ? liveNumberFor('driver', req.truckId) : null;
      const call = newCall(c, {
        kind: 'driver',
        mode: to ? 'live' : 'simulated',
        truckId: req.truckId,
        personName: truck?.driverName ?? req.truckId,
        language: to ? driverLanguage() : 'es-MX', // simulated scripts are written in Spanish
        purpose: req.goal === 'learn_queue' ? 'Learn the real queue length' : req.goal === 'give_instruction' ? 'Give a new instruction' : 'Check status',
        goal: req.goal,
        instruction: req.instruction,
        tripIds: [],
        to: to ?? undefined,
      });
      if (to) startLive(c, call);
      else {
        emitStarted(c, call);
        void runSimulatedDriverCall(c, call).catch((err) => console.error('[voice] simulated call failed', err));
      }
      return call.callId;
    },
    async startDispatcherCall(req: StartDispatcherCall) {
      const to = liveNumberFor('dispatcher', null) && (await publicUrlReachable()) ? liveNumberFor('dispatcher', null) : null;
      const call = newCall(c, {
        kind: 'dispatcher',
        mode: to ? 'live' : 'simulated',
        truckId: null,
        personName: 'Ana',
        language: 'en-US',
        purpose: 'Watchdog escalation',
        summary: req.summary,
        questions: req.questions,
        tripIds: req.tripIds,
        to: to ?? undefined,
      });
      if (to) startLive(c, call);
      else {
        emitStarted(c, call);
        void runSimulatedDispatcherCall(c, call).catch((err) => console.error('[voice] simulated call failed', err));
      }
      return call.callId;
    },
  };
  return voice;
}

export function mountVoice(app: Express, server: Server, world: WorldApi): void {
  getVoice(world);
  const form = express.urlencoded({ extended: false });

  app.post('/voice/twiml', form, async (req, res) => {
    const callId = String(req.query.callId ?? '');
    const call = ctx?.calls.get(callId);
    const base = publicBaseUrl();
    if (!call || !base || !ctx) {
      res.type('text/xml').send('<Response><Hangup/></Response>');
      return;
    }
    call.twimlServed = true;
    if (useGather()) {
      // Free-tier transport: Twilio speech recognition + <Say>, no ConversationRelay.
      try {
        res.type('text/xml').send(await gatherStart(ctx, call, base));
      } catch (err) {
        console.error('[voice] gather start failed', err);
        res.type('text/xml').send('<Response><Hangup/></Response>');
      }
      return;
    }
    const wss = `${base.replace(/^http/, 'ws')}/voice/relay?callId=${encodeURIComponent(callId)}`;
    res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="${xml(base)}/voice/connect-action">
    <ConversationRelay url="${xml(wss)}" language="${call.language}" welcomeGreeting="${xml(greetingFor(ctx, call))}" interruptible="true">
      <Parameter name="callId" value="${xml(callId)}"/>
    </ConversationRelay>
  </Connect>
</Response>`,
    );
  });

  app.post('/voice/status', form, (req, res) => {
    res.sendStatus(204);
    const call = ctx?.calls.get(String(req.query.callId ?? ''));
    if (!call || !ctx || call.ended) return;
    const s = twilioStatusToOurs(String((req.body as Record<string, unknown>)?.CallStatus ?? ''));
    if (!s) return;
    if (s === 'in_progress' && call.status === 'in_progress') return;
    setStatus(ctx, call, s);
    if (s === 'no_answer' || s === 'busy') finishCall(ctx, call, 'no_answer', `${call.personName} did not answer.`);
    else if (s === 'failed') finishCall(ctx, call, 'failed', `Call to ${call.personName} failed.`);
    else if (s === 'completed') finishCall(ctx, call, 'completed', `Call with ${call.personName} ended.`);
  });

  app.post('/voice/gather', form, async (req, res) => {
    const base = publicBaseUrl();
    if (!ctx || !base) {
      res.type('text/xml').send('<Response><Hangup/></Response>');
      return;
    }
    try {
      const speech = String((req.body as Record<string, unknown>)?.SpeechResult ?? '');
      res.type('text/xml').send(await gatherTurn(ctx, String(req.query.callId ?? ''), speech, base));
    } catch (err) {
      console.error('[voice] gather turn failed', err);
      res.type('text/xml').send('<Response><Hangup/></Response>');
    }
  });

  app.post('/voice/connect-action', form, (_req, res) => {
    res.type('text/xml').send('<Response><Hangup/></Response>');
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/voice/relay') return; // leave other upgrade paths to their owners
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!ctx) return ws.close();
      handleRelay(ctx, ws, url.searchParams.get('callId'));
    });
  });
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
