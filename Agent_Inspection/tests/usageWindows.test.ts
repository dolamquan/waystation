import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClaudeLimitRecorder, claudeQuotaLimit, claudeRateLimitEvent, codexRateLimits,
} from '../daemon/usage/planLimits.ts';
import { activeBlock, sumWindow } from '../daemon/usage/usageBlocks.ts';
import { UsageWindows } from '../daemon/usage/usageWindows.ts';
import { ZERO_TOKENS } from '../daemon/usage/usageMeter.ts';
import { tempDir } from './helpers.ts';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-07T15:30:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const codexTokenCount = (ts: number, total: Record<string, number>, rateLimits?: Record<string, unknown>) => ({
  timestamp: iso(ts),
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: total, last_token_usage: { total_tokens: 1 }, model_context_window: 200_000 },
    ...(rateLimits ? { rate_limits: rateLimits } : {}),
  },
});

const claudeAssistant = (ts: number, id: string, usage: Record<string, number>, model = 'claude-opus-5-5') => ({
  timestamp: iso(ts),
  type: 'assistant',
  message: { id, model, usage },
});

const jsonl = (lines: unknown[]) => `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;

describe('plan limits from Codex rollouts', () => {
  it('reads primary and secondary windows, converting resets_at seconds to ms', () => {
    // Arrange
    const line = codexTokenCount(NOW, { input_tokens: 10 }, {
      limit_id: 'codex',
      primary: { used_percent: 35, window_minutes: 300, resets_at: 1_791_328_536 },
      secondary: { used_percent: 12.5, window_minutes: 10080, resets_at: 1_791_581_089 },
      plan_type: 'plus',
    });

    // Act
    const result = codexRateLimits(line);

    // Assert
    expect(result?.planType).toBe('plus');
    expect(result?.limits).toEqual([
      { window: 'five_hour', label: '5-hour', usedPercent: 35, windowMinutes: 300, resetsAt: 1_791_328_536_000, observedAt: NOW, source: 'codex' },
      { window: 'weekly', label: 'Weekly', usedPercent: 12.5, windowMinutes: 10080, resetsAt: 1_791_581_089_000, observedAt: NOW, source: 'codex' },
    ]);
  });

  it('accepts resets_in_seconds relative to the line timestamp', () => {
    const line = codexTokenCount(NOW, { input_tokens: 1 }, { primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 600 } });

    const result = codexRateLimits(line);

    expect(result?.limits[0]).toMatchObject({ window: 'five_hour', resetsAt: NOW + 10 * MIN });
  });

  it('ignores token_count lines without rate limits and unrelated lines', () => {
    expect(codexRateLimits(codexTokenCount(NOW, { input_tokens: 1 }))).toBeUndefined();
    expect(codexRateLimits({ type: 'turn_context', payload: { model: 'gpt-6' } })).toBeUndefined();
    expect(codexRateLimits(null)).toBeUndefined();
  });
});

describe('plan limits from Claude', () => {
  it('reads a rate-limit hit recorded in a Claude Code transcript', () => {
    // Arrange
    const line = {
      timestamp: iso(NOW), type: 'assistant', error: 'rate_limit', isApiErrorMessage: true,
      quotaLimits: { status: 'rejected', resetsAt: 1_791_271_800, rateLimitType: 'five_hour' },
      message: { id: 'x', model: '<synthetic>', usage: {} },
    };

    // Act
    const limit = claudeQuotaLimit(line);

    // Assert
    expect(limit).toEqual({
      window: 'five_hour', label: '5-hour', status: 'rejected', resetsAt: 1_791_271_800_000, observedAt: NOW, source: 'claude-transcript',
    });
    expect(claudeQuotaLimit(claudeAssistant(NOW, 'm', { input_tokens: 1 }))).toBeUndefined();
  });

  it('reads an Agent SDK rate_limit_event, treating a 0-1 utilization as a fraction', () => {
    const limit = claudeRateLimitEvent({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', resetsAt: 1_791_300_000, rateLimitType: 'seven_day_opus', utilization: 0.82 },
    }, NOW);

    expect(limit).toEqual({
      window: 'seven_day_opus', label: 'Weekly · Opus', status: 'allowed_warning', usedPercent: 82,
      resetsAt: 1_791_300_000_000, observedAt: NOW, source: 'claude-sdk',
    });
    expect(claudeRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', utilization: 64 } }, NOW))
      .toMatchObject({ usedPercent: 64, window: 'unknown' });
    expect(claudeRateLimitEvent({ type: 'assistant' }, NOW)).toBeUndefined();
  });

  it('keeps only the newest observation per window', () => {
    // Arrange
    const recorder = new ClaudeLimitRecorder();
    const event = (utilization: number) => ({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization } });

    // Act
    recorder.record(event(0.2), NOW - HOUR);
    recorder.record(event(0.5), NOW);
    recorder.record(event(0.1), NOW - 2 * HOUR);
    recorder.record({ type: 'assistant' }, NOW);

    // Assert
    expect(recorder.list().map((l) => l.usedPercent)).toEqual([50]);
  });
});

describe('ccusage-style 5-hour blocks', () => {
  const entry = (ts: number, output = 10) => ({ ts, tokens: { ...ZERO_TOKENS, output } });

  it('starts the block at the hour of the first activity and ends it 5 hours later', () => {
    // Arrange: activity at 12:40 and 15:10, now 15:30
    const entries = [entry(Date.parse('2026-10-07T12:40:00Z')), entry(Date.parse('2026-10-07T15:10:00Z'), 5)];

    // Act
    const block = activeBlock(entries, NOW);

    // Assert
    expect(block?.start).toBe(Date.parse('2026-10-07T12:00:00Z'));
    expect(block?.end).toBe(Date.parse('2026-10-07T17:00:00Z'));
    expect(block?.entries).toHaveLength(2);
  });

  it('opens a new block once activity falls past the previous block end', () => {
    const entries = [entry(Date.parse('2026-10-07T08:30:00Z')), entry(Date.parse('2026-10-07T13:05:00Z'))];

    const block = activeBlock(entries, NOW);

    expect(block?.start).toBe(Date.parse('2026-10-07T13:00:00Z'));
    expect(block?.entries).toHaveLength(1);
  });

  it('has no active block when the last block already ended', () => {
    expect(activeBlock([entry(Date.parse('2026-10-07T09:00:00Z'))], NOW)).toBeUndefined();
    expect(activeBlock([], NOW)).toBeUndefined();
  });

  it('sums tokens and prices only priced entries', () => {
    const window = sumWindow([
      { ts: 1, tokens: { ...ZERO_TOKENS, output: 1_000_000 }, model: 'claude-opus-5' },
      { ts: 2, tokens: { ...ZERO_TOKENS, input: 500 }, model: 'gpt-6' },
    ], 0, 10);

    expect(window).toMatchObject({ start: 0, end: 10, totalTokens: 1_000_500, costUsd: 25, unpricedTokens: 500, requests: 2, lastActivityAt: 2 });
  });
});

describe('UsageWindows scanner', () => {
  function setup() {
    const root = tempDir('usage-windows-');
    const claudeDir = join(root, 'claude', 'projects');
    const codexDir = join(root, 'codex', 'sessions');
    mkdirSync(join(claudeDir, 'proj-a', 'sess-1', 'subagents'), { recursive: true });
    mkdirSync(join(codexDir, '2026', '10', '07'), { recursive: true });
    return { claudeDir, codexDir };
  }

  it('computes the active block and 7-day totals per vendor with real Codex limits', async () => {
    // Arrange
    const { claudeDir, codexDir } = setup();
    const main = join(claudeDir, 'proj-a', 'sess-1.jsonl');
    writeFileSync(main, jsonl([
      claudeAssistant(NOW - 2 * 24 * HOUR, 'old', { input_tokens: 100, output_tokens: 100 }),
      claudeAssistant(NOW - 50 * MIN, 'm1', { input_tokens: 10, output_tokens: 5 }),
      // Streaming rewrites the same message id: counted once.
      claudeAssistant(NOW - 49 * MIN, 'm1', { input_tokens: 10, output_tokens: 1_000_000 }),
      claudeAssistant(NOW - 9 * 24 * HOUR, 'ancient', { input_tokens: 999 }),
      { type: 'user', timestamp: iso(NOW), message: { content: 'secret prompt' } },
    ]));
    writeFileSync(join(claudeDir, 'proj-a', 'sess-1', 'subagents', 'agent-x.jsonl'), jsonl([
      claudeAssistant(NOW - 20 * MIN, 'm2', { cache_read_input_tokens: 2_000_000 }),
    ]));
    const rollout = join(codexDir, '2026', '10', '07', 'rollout-a.jsonl');
    writeFileSync(rollout, jsonl([
      { timestamp: iso(NOW - 40 * MIN), type: 'turn_context', payload: { model: 'gpt-6' } },
      codexTokenCount(NOW - 40 * MIN, { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }),
      codexTokenCount(NOW - 10 * MIN, { input_tokens: 300, cached_input_tokens: 40, output_tokens: 30 }, {
        primary: { used_percent: 35, window_minutes: 300, resets_at: Math.round((NOW + 2 * HOUR) / 1000) },
        secondary: { used_percent: 12, window_minutes: 10080, resets_at: Math.round((NOW + 3 * 24 * HOUR) / 1000) },
        plan_type: 'plus',
      }),
    ]));
    const windows = new UsageWindows({ claudeProjectsDir: claudeDir, codexSessionsDir: codexDir, liveClaudeLimits: () => [] });

    // Act
    const report = await windows.report(NOW);

    // Assert
    const claude = report.vendors.find((v) => v.vendor === 'claude')!;
    expect(claude.block?.start).toBe(Date.parse('2026-10-07T14:00:00Z'));
    expect(claude.block?.end).toBe(Date.parse('2026-10-07T19:00:00Z'));
    expect(claude.block?.tokens).toMatchObject({ input: 10, output: 1_000_000, cacheRead: 2_000_000 });
    expect(claude.block?.requests).toBe(2);
    // Opus 5.5: 10*4 + 1M*20 + 2M*0.2 per million
    expect(claude.block?.costUsd).toBeCloseTo(20.40004, 5);
    expect(claude.week.totalTokens).toBe(3_000_210);
    expect(claude.limits).toEqual([]);

    const codex = report.vendors.find((v) => v.vendor === 'codex')!;
    expect(codex.block?.tokens).toMatchObject({ input: 260, cacheRead: 40, output: 30 });
    expect(codex.block?.costUsd).toBeUndefined();
    expect(codex.planType).toBe('plus');
    expect(codex.limits.map((l) => [l.label, l.usedPercent])).toEqual([['5-hour', 35], ['Weekly', 12]]);
    expect(JSON.stringify(report)).not.toContain('secret prompt');
  });

  it('skips files not modified within 7 days and merges live Claude limits with transcript hits', async () => {
    // Arrange
    const { claudeDir, codexDir } = setup();
    const stale = join(claudeDir, 'proj-a', 'stale.jsonl');
    writeFileSync(stale, jsonl([claudeAssistant(NOW - HOUR, 'z', { input_tokens: 5 })]));
    const eightDaysAgo = (NOW - 8 * 24 * HOUR) / 1000;
    utimesSync(stale, eightDaysAgo, eightDaysAgo);
    const hit = join(claudeDir, 'proj-a', 'hit.jsonl');
    writeFileSync(hit, jsonl([{
      timestamp: iso(NOW - 30 * MIN), type: 'assistant', error: 'rate_limit',
      quotaLimits: { status: 'rejected', resetsAt: Math.round((NOW + HOUR) / 1000), rateLimitType: 'five_hour' },
      message: { id: 'syn', model: '<synthetic>', usage: { input_tokens: 0 } },
    }]));
    const live = [{ window: 'seven_day', label: 'Weekly', usedPercent: 40, observedAt: NOW - MIN, source: 'claude-sdk' as const }];
    const windows = new UsageWindows({ claudeProjectsDir: claudeDir, codexSessionsDir: codexDir, liveClaudeLimits: () => live });

    // Act
    const report = await windows.report(NOW);

    // Assert
    const claude = report.vendors.find((v) => v.vendor === 'claude')!;
    expect(claude.week.totalTokens).toBe(0);
    expect(claude.block).toBeUndefined();
    expect(claude.limits.map((l) => [l.window, l.status ?? l.usedPercent])).toEqual([['five_hour', 'rejected'], ['seven_day', 40]]);
    expect(report.files).toBe(1);
  });

  it('caches the report and rescans only files whose size or mtime changed', async () => {
    // Arrange
    const { claudeDir, codexDir } = setup();
    const a = join(claudeDir, 'proj-a', 'a.jsonl');
    const b = join(claudeDir, 'proj-a', 'b.jsonl');
    writeFileSync(a, jsonl([claudeAssistant(NOW - 10 * MIN, 'a1', { output_tokens: 1 })]));
    writeFileSync(b, jsonl([claudeAssistant(NOW - 10 * MIN, 'b1', { output_tokens: 2 })]));
    const windows = new UsageWindows({ claudeProjectsDir: claudeDir, codexSessionsDir: codexDir, liveClaudeLimits: () => [], refreshMs: 60_000 });
    const first = await windows.report(NOW);

    // Act
    appendFileSync(b, jsonl([claudeAssistant(NOW - 5 * MIN, 'b2', { output_tokens: 4 })]));
    const cached = await windows.report(NOW + 1000);
    const refreshed = await windows.report(NOW + 61_000);

    // Assert
    expect(first.filesRead).toBe(2);
    expect(cached).toBe(first);
    expect(refreshed.filesRead).toBe(1);
    expect(refreshed.vendors.find((v) => v.vendor === 'claude')!.week.totalTokens).toBe(7);
  });

  it('reports empty windows when the transcript folders do not exist', async () => {
    const windows = new UsageWindows({ claudeProjectsDir: join(tempDir(), 'none'), codexSessionsDir: join(tempDir(), 'none'), liveClaudeLimits: () => [] });

    const report = await windows.report(NOW);

    expect(report.vendors.map((v) => [v.vendor, v.week.totalTokens, v.block])).toEqual([['claude', 0, undefined], ['codex', 0, undefined]]);
  });
});
