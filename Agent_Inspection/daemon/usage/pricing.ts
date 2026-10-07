import type { TokenCounts } from '../domain/types.ts';

/** USD per million tokens. Cache writes are priced from `input` (1.25x for 5-minute, 2x for 1-hour TTL). */
interface ModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly contextWindow: number;
}

const MILLION = 1_000_000;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

/**
 * Anthropic first-party list prices (Sept 2026). Matched by prefix, so dated ids
 * (e.g. claude-haiku-4-5-20251001) resolve; longer prefixes are listed first.
 * Codex/OpenAI models are absent on purpose: we show their tokens, not a guessed price.
 */
const PRICES: ReadonlyArray<readonly [prefix: string, price: ModelPrice]> = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25, contextWindow: 1_000_000 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25, contextWindow: 1_000_000 }],
  ['claude-fable-5', { input: 10, output: 50, cacheRead: 1, contextWindow: 1_000_000 }],
  ['claude-mythos-5', { input: 10, output: 50, cacheRead: 1, contextWindow: 1_000_000 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2, contextWindow: 1_000_000 }],
  ['claude-opus-5', { input: 5, output: 25, cacheRead: 0.5, contextWindow: 1_000_000 }],
  ['claude-opus-4-8', { input: 5, output: 25, cacheRead: 0.5, contextWindow: 1_000_000 }],
  ['claude-opus-4-7', { input: 5, output: 25, cacheRead: 0.5, contextWindow: 1_000_000 }],
  ['claude-opus-4-6', { input: 5, output: 25, cacheRead: 0.5, contextWindow: 1_000_000 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2, contextWindow: 1_000_000 }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.2, contextWindow: 1_000_000 }],
  ['claude-sonnet-4-6', { input: 3, output: 15, cacheRead: 0.3, contextWindow: 1_000_000 }],
  ['claude-haiku-4-5', { input: 1, output: 5, cacheRead: 0.1, contextWindow: 200_000 }],
];

function priceFor(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const id = model.toLowerCase().replace(/^(us\.|eu\.|global\.)?anthropic\./, '').replace(/\[1m\]$/, '');
  return PRICES.find(([prefix]) => id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}@`))?.[1];
}

export function contextWindowFor(model: string | undefined): number | undefined {
  return priceFor(model)?.contextWindow;
}

/** List-price estimate, or undefined when the model has no known price. */
export function costUsd(model: string | undefined, tokens: TokenCounts): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  return (
    tokens.input * price.input
    + tokens.output * price.output
    + tokens.cacheRead * price.cacheRead
    + tokens.cacheWrite5m * price.input * CACHE_WRITE_5M
    + tokens.cacheWrite1h * price.input * CACHE_WRITE_1H
  ) / MILLION;
}
