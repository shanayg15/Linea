// Off-critical-path translation of Spanish utterances (TRACK_B §B6.1).
import Anthropic from '@anthropic-ai/sdk';
import { ulid } from 'ulid';
import { claudeCost, MODELS, usageTokens } from '../agent/cost';
import { thinkingOff } from '../agent/dispatcher';
import type { VoiceCtx } from './calls';

let client: Anthropic | null = null;

export function translateUtterance(
  ctx: VoiceCtx,
  p: { callId: string; utteranceId: string; speaker: 'linea' | 'human'; text: string; lang: string },
): void {
  if (!p.lang.startsWith('es') || !p.text.trim()) return;
  void (async () => {
    try {
      client ??= new Anthropic();
      const model = MODELS.voice;
      const thinking = thinkingOff(model);
      const msg = await client.messages.create({
        model,
        max_tokens: 120,
        system: 'Translate to natural English. Output only the translation.',
        messages: [{ role: 'user', content: p.text }],
        ...(thinking ? { thinking } : {}),
      });
      const english = msg.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();
      const costUsd = claudeCost(model, msg.usage);
      ctx.hooks.onCost(costUsd);
      ctx.world.bus.emit('agent.usage', { requestId: ulid(), purpose: 'translate', model, ...usageTokens(msg.usage), costUsd });
      if (english) {
        ctx.world.bus.emit('call.transcript', { ...p, textEnglish: english, final: true });
      }
    } catch (err) {
      console.error('[voice] translation failed', (err as Error).message);
    }
  })();
}
