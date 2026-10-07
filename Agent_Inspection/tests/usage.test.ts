import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contextWindowFor, costUsd } from '../daemon/usage/pricing.ts';
import {
  UsageMeter, ZERO_TOKENS, claudeUsageSample, codexExecTurnUsage, codexRolloutModel, codexRolloutUsage, scanJsonl,
} from '../daemon/usage/usageMeter.ts';
import { tempDir } from './helpers.ts';

const claudeLine = (id: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { id, model: 'claude-opus-5-5', usage },
  ...extra,
});

describe('pricing', () => {
  it('prices each token class, including 1-hour cache writes at 2x input', () => {
    const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 };
    // Opus 5.5: 4 + 20 + 0.20 + 4*1.25 + 4*2
    expect(costUsd('claude-opus-5-5', tokens)).toBeCloseTo(37.2, 5);
  });

  it('resolves dated and provider-prefixed ids, and leaves unknown models unpriced', () => {
    expect(contextWindowFor('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(contextWindowFor('us.anthropic.claude-sonnet-5-5')).toBe(1_000_000);
    expect(costUsd('claude-opus-5', { ...ZERO_TOKENS, output: 1_000_000 })).toBe(25);
    expect(costUsd('gpt-6.1-sol', { ...ZERO_TOKENS, output: 1_000_000 })).toBeUndefined();
    expect(costUsd(undefined, ZERO_TOKENS)).toBeUndefined();
  });
});

describe('usage parsing', () => {
  it('reads Claude usage, splitting cache writes by TTL', () => {
    const sample = claudeUsageSample(claudeLine('m1', {
      input_tokens: 2, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 500,
      cache_creation: { ephemeral_1h_input_tokens: 400, ephemeral_5m_input_tokens: 100 },
    }));
    expect(sample).toMatchObject({
      messageId: 'm1', model: 'claude-opus-5-5', contextTokens: 802, isMain: true,
      tokens: { input: 2, output: 200, cacheRead: 300, cacheWrite5m: 100, cacheWrite1h: 400 },
    });
    expect(claudeUsageSample(claudeLine('m2', {}, { isSidechain: true }))?.isMain).toBe(false);
    expect(claudeUsageSample({ type: 'user', message: { id: 'x', usage: {} } })).toBeUndefined();
    expect(claudeUsageSample({ type: 'assistant', message: { id: 'x', model: '<synthetic>', usage: {} } })).toBeUndefined();
  });

  it('reads Codex rollout totals, model and exec turns (cached input is part of input_tokens)', () => {
    const rollout = codexRolloutUsage({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 },
          last_token_usage: { total_tokens: 900 },
          model_context_window: 258400,
        },
      },
    });
    expect(rollout).toEqual({
      total: { input: 400, output: 50, cacheRead: 600, cacheWrite5m: 0, cacheWrite1h: 0 },
      contextTokens: 900,
      contextWindow: 258400,
    });
    expect(codexRolloutUsage({ type: 'event_msg', payload: { type: 'token_count', info: null } })).toBeUndefined();
    expect(codexRolloutModel({ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } })).toBe('gpt-6.1-sol');
    expect(codexExecTurnUsage({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 } }))
      .toEqual({ input: 6, output: 3, cacheRead: 4, cacheWrite5m: 0, cacheWrite1h: 0 });
  });
});

describe('UsageMeter', () => {
  it('counts a repeated Claude message once and keeps the main context size', () => {
    const meter = new UsageMeter();
    const line = claudeLine('m1', { input_tokens: 10, output_tokens: 1_000_000, cache_read_input_tokens: 90 });
    meter.addClaude(claudeUsageSample(line)!);
    meter.addClaude(claudeUsageSample(line)!);
    meter.addClaude(claudeUsageSample(claudeLine('m2', { input_tokens: 5, output_tokens: 5 }, { isSidechain: true }))!);
    const usage = meter.snapshot()!;
    expect(usage.tokens.output).toBe(1_000_005);
    expect(usage.costUsd).toBeCloseTo(20.0001, 3);
    expect(usage.contextTokens).toBe(100);
    expect(usage.contextWindow).toBe(1_000_000);
    expect(meter.model).toBe('claude-opus-5-5');
  });

  it('adds exec turns, replaces cumulative totals, and leaves unpriced models without a cost', () => {
    const meter = new UsageMeter('gpt-6.1-sol');
    expect(meter.snapshot()).toBeUndefined();
    meter.addTurn({ ...ZERO_TOKENS, input: 5 });
    meter.addTurn({ ...ZERO_TOKENS, input: 5 });
    expect(meter.snapshot()?.tokens.input).toBe(10);
    meter.setTotals({ ...ZERO_TOKENS, output: 7 });
    meter.setContext(500, 258400);
    expect(meter.snapshot()).toEqual({ tokens: { ...ZERO_TOKENS, output: 7 }, contextTokens: 500, contextWindow: 258400 });
  });

  it('scans a whole transcript, skipping lines that are not usage', async () => {
    const file = join(tempDir(), 't.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify(claudeLine('a', { input_tokens: 1, output_tokens: 2 })),
      '{"usage": broken',
      JSON.stringify(claudeLine('b', { input_tokens: 3, output_tokens: 4 })),
    ].join('\n'));
    const meter = new UsageMeter();
    await scanJsonl(file, (line) => {
      const sample = claudeUsageSample(line);
      if (sample) meter.addClaude(sample);
    });
    expect(meter.snapshot()?.tokens).toMatchObject({ input: 4, output: 6 });
  });
});
