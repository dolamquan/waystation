import type { TokenCounts } from '../domain/types.ts';
import { costUsd } from './pricing.ts';
import { ZERO_TOKENS, addTokens, totalTokens } from './usageMeter.ts';
import type { ComputedWindow } from './windowTypes.ts';

export const BLOCK_MS = 5 * 60 * 60 * 1000;

/** One API response (Claude) or one token_count delta (Codex), with when it happened. */
export interface UsageEntry {
  readonly ts: number;
  readonly tokens: TokenCounts;
  readonly model?: string;
}

export interface Block<E extends UsageEntry = UsageEntry> {
  readonly start: number;
  readonly end: number;
  readonly entries: readonly E[];
}

const floorToHour = (ts: number): number => {
  const date = new Date(ts);
  date.setUTCMinutes(0, 0, 0);
  return date.getTime();
};

/**
 * ccusage-style blocks: a block starts at the first activity after the previous block ended, floored to the
 * hour, and lasts 5 hours (a gap of 5 hours without activity also starts a new block). Returns the block
 * still open at `now`, if any.
 */
export function activeBlock<E extends UsageEntry>(entries: readonly E[], now: number, durationMs = BLOCK_MS): Block<E> | undefined {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  let start: number | undefined;
  let lastTs = -Infinity;
  let current: E[] = [];
  for (const entry of sorted) {
    if (start === undefined || entry.ts - start >= durationMs || entry.ts - lastTs >= durationMs) {
      start = floorToHour(entry.ts);
      current = [];
    }
    current.push(entry);
    lastTs = entry.ts;
  }
  if (start === undefined || now >= start + durationMs || now - lastTs >= durationMs) return undefined;
  return { start, end: start + durationMs, entries: current };
}

export function sumWindow(entries: readonly UsageEntry[], start: number, end: number): ComputedWindow {
  let tokens = ZERO_TOKENS;
  let cost = 0;
  let priced = false;
  let unpricedTokens = 0;
  let lastActivityAt: number | undefined;
  for (const entry of entries) {
    tokens = addTokens(tokens, entry.tokens);
    const entryCost = costUsd(entry.model, entry.tokens);
    if (entryCost === undefined) unpricedTokens += totalTokens(entry.tokens);
    else {
      cost += entryCost;
      priced = true;
    }
    lastActivityAt = Math.max(lastActivityAt ?? entry.ts, entry.ts);
  }
  return {
    start,
    end,
    tokens,
    totalTokens: totalTokens(tokens),
    ...(priced ? { costUsd: cost } : {}),
    unpricedTokens,
    requests: entries.length,
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
  };
}
