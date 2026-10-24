// Prices checked 2026-10-24.
// Claude: docs.claude.com pricing (Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 for prompts ≤ 100K tokens;
//         5-min cache write = 1.25× input, cache read = 0.1× input).
// Twilio: US outbound voice $0.014/min, ConversationRelay $0.07/min (billed on top of voice).
export const PRICES_PER_MTOK: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

export const TWILIO_PER_MIN = { outbound: 0.014, conversationRelay: 0.07 };

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function claudeCost(model: string, u: UsageLike): number {
  const p = PRICES_PER_MTOK[model];
  if (!p) throw new Error(`No price for model ${model} — add it to PRICES_PER_MTOK`);
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead) /
    1e6
  );
}

export function callCost(durationSec: number): number {
  return Math.ceil(Math.max(durationSec, 1) / 60) * (TWILIO_PER_MIN.outbound + TWILIO_PER_MIN.conversationRelay);
}

/** Throws at startup if a model in use has no (or zero) price while AGENT_MODE=claude. */
export function assertPricesFilled(models: string[]): void {
  if (process.env.AGENT_MODE === 'mock') return;
  for (const m of new Set(models)) {
    const p = PRICES_PER_MTOK[m];
    if (!p || p.input === 0 || p.output === 0 || p.cacheRead === 0 || p.cacheWrite === 0) {
      throw new Error(`cost.ts: price for ${m} is missing or 0 — fill PRICES_PER_MTOK before running AGENT_MODE=claude`);
    }
  }
}

export function usageTokens(u: UsageLike) {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

export const MODELS = {
  get dispatch() {
    return process.env.MODEL_DISPATCH || 'claude-sonnet-5-5';
  },
  get degraded() {
    return process.env.MODEL_DEGRADED || 'claude-haiku-5-5';
  },
  get voice() {
    return process.env.MODEL_VOICE || 'claude-haiku-5-5';
  },
};
