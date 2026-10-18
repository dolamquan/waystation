import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { AgentUsage, TokenCounts } from '../domain/types.ts';
import { contextWindowFor, costUsd } from './pricing.ts';

type Json = Record<string, unknown>;

export const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
const TOKEN_KEYS = Object.keys(ZERO_TOKENS) as Array<keyof TokenCounts>;

const asRecord = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return Object.fromEntries(TOKEN_KEYS.map((key) => [key, a[key] + b[key]])) as unknown as TokenCounts;
}

/** Field-wise a - b, never below zero (a shrinking total means the source restarted, not negative usage). */
export function subtractTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return Object.fromEntries(TOKEN_KEYS.map((key) => [key, Math.max(0, a[key] - b[key])])) as unknown as TokenCounts;
}

export const totalTokens = (t: TokenCounts): number => TOKEN_KEYS.reduce((sum, key) => sum + t[key], 0);

/** One Claude API response, from a Claude Code transcript line or an Agent SDK assistant message (same shape). */
export interface ClaudeUsageSample {
  readonly messageId: string;
  readonly model?: string;
  readonly tokens: TokenCounts;
  readonly contextTokens: number;
  /** False for subagent (sidechain) calls: they cost money but are not the main context window. */
  readonly isMain: boolean;
}

export function claudeUsageSample(line: unknown): ClaudeUsageSample | undefined {
  const entry = asRecord(line);
  const message = asRecord(entry?.message);
  const usage = asRecord(message?.usage);
  if (entry?.type !== 'assistant' || !message || !usage || typeof message.id !== 'string') return undefined;
  if (message.model === '<synthetic>') return undefined;
  const writes = count(usage.cache_creation_input_tokens);
  const breakdown = asRecord(usage.cache_creation);
  const write1h = breakdown ? Math.min(count(breakdown.ephemeral_1h_input_tokens), writes) : 0;
  const tokens: TokenCounts = {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite5m: writes - write1h,
    cacheWrite1h: write1h,
  };
  return {
    messageId: message.id,
    model: typeof message.model === 'string' ? message.model : undefined,
    tokens,
    contextTokens: tokens.input + tokens.cacheRead + writes,
    isMain: entry.isSidechain !== true && (entry.parent_tool_use_id === undefined || entry.parent_tool_use_id === null),
  };
}

/** OpenAI-style usage: `input_tokens` includes the cached part. */
function codexTokens(usage: Json): TokenCounts {
  const input = count(usage.input_tokens);
  const cached = Math.min(count(usage.cached_input_tokens), input);
  return { input: input - cached, output: count(usage.output_tokens), cacheRead: cached, cacheWrite5m: count(usage.cache_write_input_tokens), cacheWrite1h: 0 };
}

export interface CodexRolloutUsage {
  /** Cumulative for the whole thread. */
  readonly total: TokenCounts;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
}

/** Codex rollout `token_count` event (cumulative totals plus the last request). */
export function codexRolloutUsage(line: unknown): CodexRolloutUsage | undefined {
  const entry = asRecord(line);
  const payload = asRecord(entry?.payload);
  const info = asRecord(payload?.info);
  const total = asRecord(info?.total_token_usage);
  if (entry?.type !== 'event_msg' || payload?.type !== 'token_count' || !info || !total) return undefined;
  const last = asRecord(info.last_token_usage);
  return {
    total: codexTokens(total),
    contextTokens: last ? count(last.total_tokens) || undefined : undefined,
    contextWindow: count(info.model_context_window) || undefined,
  };
}

/** Codex rollout `turn_context` carries the model for the turn. */
export function codexRolloutModel(line: unknown): string | undefined {
  const entry = asRecord(line);
  const payload = asRecord(entry?.payload);
  return entry?.type === 'turn_context' && typeof payload?.model === 'string' ? payload.model : undefined;
}

/** `codex exec --json` `turn.completed` usage for that one turn. */
export function codexExecTurnUsage(line: unknown): TokenCounts | undefined {
  const entry = asRecord(line);
  const usage = asRecord(entry?.usage);
  return entry?.type === 'turn.completed' && usage ? codexTokens(usage) : undefined;
}

/** Running usage for one agent. Claude responses are keyed by message id, so re-reading a line never double counts. */
export class UsageMeter {
  private readonly messages = new Map<string, { tokens: TokenCounts; cost: number | undefined }>();
  private totals: TokenCounts = ZERO_TOKENS;
  private pricedCost = 0;
  private anyPriced = false;
  private currentModel: string | undefined;
  private contextTokens: number | undefined;
  private contextWindow: number | undefined;

  constructor(model?: string) {
    this.currentModel = model;
  }

  get model(): string | undefined {
    return this.currentModel;
  }

  addClaude(sample: ClaudeUsageSample): void {
    if (sample.model) this.currentModel = sample.model;
    const previous = this.messages.get(sample.messageId);
    const cost = costUsd(sample.model ?? this.currentModel, sample.tokens);
    this.totals = addTokens(subtractTokens(this.totals, previous?.tokens ?? ZERO_TOKENS), sample.tokens);
    this.pricedCost += (cost ?? 0) - (previous?.cost ?? 0);
    this.anyPriced ||= cost !== undefined;
    this.messages.set(sample.messageId, { tokens: sample.tokens, cost });
    if (sample.isMain) this.contextTokens = sample.contextTokens;
  }

  /** A self-contained turn (codex exec): add it. */
  addTurn(tokens: TokenCounts): void {
    this.totals = addTokens(this.totals, tokens);
  }

  /** A cumulative thread total (Codex rollout): replace. */
  setTotals(tokens: TokenCounts): void {
    this.totals = tokens;
  }

  setModel(model: string): void {
    this.currentModel = model;
  }

  setContext(tokens: number | undefined, window: number | undefined): void {
    if (tokens !== undefined) this.contextTokens = tokens;
    if (window !== undefined) this.contextWindow = window;
  }

  snapshot(): AgentUsage | undefined {
    if (totalTokens(this.totals) === 0 && this.contextTokens === undefined) return undefined;
    // Turn-level totals (Codex) have no per-message model; price them with the current one when we can.
    const cost = this.messages.size > 0
      ? (this.anyPriced ? this.pricedCost : undefined)
      : costUsd(this.currentModel, this.totals);
    const window = this.contextWindow ?? contextWindowFor(this.currentModel);
    return {
      tokens: this.totals,
      ...(cost !== undefined ? { costUsd: cost } : {}),
      ...(this.contextTokens !== undefined ? { contextTokens: this.contextTokens } : {}),
      ...(window !== undefined ? { contextWindow: window } : {}),
    };
  }
}

/** One full pass over a transcript, for sessions that were already running when the tower started. */
export async function scanJsonl(file: string, onLine: (line: unknown) => void): Promise<void> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const text of lines) {
      if (!text.includes('"usage"') && !text.includes('token_count') && !text.includes('turn_context')) continue;
      try {
        onLine(JSON.parse(text));
      } catch {
        // A partially written last line; the tailer picks it up once complete.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}
