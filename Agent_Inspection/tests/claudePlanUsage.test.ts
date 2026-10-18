import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeUsageLimits } from '../daemon/usage/planLimits.ts';
import { UsageWindows } from '../daemon/usage/usageWindows.ts';
import { tempDir } from './helpers.ts';

const sdk = vi.hoisted(() => ({ query: vi.fn(), usage: vi.fn(), close: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }));
const { readClaudePlanUsage } = await import('../daemon/usage/claudePlanUsage.ts');

const NOW = Date.parse('2026-10-07T21:00:00Z');
const response = (windows: Record<string, unknown>) => ({
  rate_limits_available: true, subscription_type: 'max', rate_limits: windows,
});

describe('Claude structured usage percentages', () => {
  it('keeps /usage utilization in percentage units, including values below one percent', () => {
    const result = claudeUsageLimits(response({
      five_hour: { utilization: 0.5, resets_at: '2026-10-08T00:00:00Z' },
      seven_day: { utilization: 32, resets_at: '2026-10-14T21:00:00Z' },
      seven_day_opus: { utilization: 1, resets_at: null },
      seven_day_sonnet: { utilization: 0, resets_at: null },
    }), NOW);
    expect(result?.planType).toBe('max');
    expect(result?.limits.map((limit) => limit.usedPercent)).toEqual([0.5, 32, 1, 0]);
    expect(result?.limits[0]).toMatchObject({ window: 'five_hour', resetsAt: Date.parse('2026-10-08T00:00:00Z'), observedAt: NOW, source: 'claude-sdk' });
  });

  it('does not invent percentages from tokens, missing values, or non-subscription usage', () => {
    expect(claudeUsageLimits({ rate_limits_available: false, session: { total_tokens: 90000 } }, NOW)).toBeUndefined();
    expect(claudeUsageLimits(response({ five_hour: { utilization: null }, seven_day: { utilization: NaN } }), NOW)).toBeUndefined();
    expect(claudeUsageLimits(null, NOW)).toBeUndefined();
  });

  it('keeps additional model windows and rejects invalid reset timestamps', () => {
    expect(claudeUsageLimits(response({
      five_hour: { utilization: 110, resets_at: 'invalid' },
      model_scoped: [{ display_name: 'Fable', utilization: 22, resets_at: null }],
    }), NOW)?.limits).toEqual([
      { window: 'five_hour', label: '5-hour', usedPercent: 100, observedAt: NOW, source: 'claude-sdk' },
      { window: 'model:Fable', label: 'Weekly · Fable', usedPercent: 22, observedAt: NOW, source: 'claude-sdk' },
    ]);
  });
});

describe('Claude plan metadata reader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.query.mockReturnValue({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: sdk.usage, close: sdk.close });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('reads percentages without sending a model prompt or persisting a session', async () => {
    sdk.usage.mockResolvedValue(response({ five_hour: { utilization: 42, resets_at: null } }));
    expect((await readClaudePlanUsage())?.limits[0].usedPercent).toBe(42);
    expect(sdk.usage).toHaveBeenCalledWith({ skipBehaviors: true });
    const launch = sdk.query.mock.calls[0][0];
    expect(typeof launch.prompt).not.toBe('string');
    expect(await launch.prompt[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true });
    expect(launch.options).toMatchObject({ tools: [], settingSources: [], persistSession: false });
    expect(sdk.close).toHaveBeenCalledOnce();
  });

  it('closes the metadata session and falls back when a usage read fails', async () => {
    sdk.usage.mockRejectedValue(new Error('Unavailable'));
    expect(await readClaudePlanUsage()).toBeUndefined();
    expect(sdk.close).toHaveBeenCalledOnce();
  });

  it('handles older SDKs without the usage control method', async () => {
    sdk.query.mockReturnValue({ close: sdk.close });
    expect(await readClaudePlanUsage()).toBeUndefined();
    expect(sdk.close).toHaveBeenCalledOnce();
  });

  it('limits the read time and closes an unresponsive session', async () => {
    vi.useFakeTimers();
    sdk.usage.mockImplementation(() => new Promise(() => {}));
    const pending = readClaudePlanUsage();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeUndefined();
    expect(sdk.close).toHaveBeenCalledOnce();
  });
});

describe('usage report integration', () => {
  it('includes structured Claude percentages and shares one cached read across callers', async () => {
    const read = vi.fn(async () => claudeUsageLimits(response({ five_hour: { utilization: 53, resets_at: null }, seven_day: { utilization: 36, resets_at: null } }), NOW));
    const report = new UsageWindows({ claudeProjectsDir: tempDir(), codexSessionsDir: tempDir(), liveClaudeLimits: () => [], readClaudePlanUsage: read });
    const [first, second] = await Promise.all([report.report(NOW), report.report(NOW)]);
    expect(first).toBe(second);
    expect(first.vendors[0]).toMatchObject({ vendor: 'claude', planType: 'max', limits: [{ usedPercent: 53 }, { usedPercent: 36 }] });
    expect(await report.report(NOW + 30_000)).toBe(first);
    expect(read).toHaveBeenCalledOnce();
  });

  it('keeps existing readings when the structured SDK read is unavailable', async () => {
    const reading = { window: 'five_hour', label: '5-hour', usedPercent: 20, observedAt: NOW, source: 'claude-sdk' as const };
    const report = new UsageWindows({ claudeProjectsDir: tempDir(), codexSessionsDir: tempDir(), liveClaudeLimits: () => [reading], readClaudePlanUsage: async () => { throw new Error('Offline'); } });
    expect((await report.report(NOW)).vendors[0].limits).toEqual([reading]);
  });
});
