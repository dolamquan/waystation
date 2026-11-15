import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPEND_CAP, automatedLaunchBlock, evaluateSpend, quotaPressure, validateSpendCap,
} from '../daemon/guard/spendCap.ts';
import type { VendorWindows } from '../daemon/usage/windowTypes.ts';

const week = { start: 0, end: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, totalTokens: 0, unpricedTokens: 0, requests: 0 };
const vendor = (name: VendorWindows['vendor'], limits: VendorWindows['limits']): VendorWindows => ({ vendor: name, limits, week });

describe('validateSpendCap', () => {
  it('accepts a fleet cap, per-project caps and a quota threshold', () => {
    const config = validateSpendCap({ dailyUsd: 25, projects: { web: 5, ' api ': '3.5' }, quotaPausePercent: 90, constrainRunning: false });
    expect(config).toEqual({ dailyUsd: 25, projects: { web: 5, api: 3.5 }, quotaPausePercent: 90, constrainRunning: false });
  });

  it('treats empty, zero or missing values as "no cap"', () => {
    expect(validateSpendCap({ dailyUsd: '', projects: { web: 0 } })).toEqual(DEFAULT_SPEND_CAP);
    expect(validateSpendCap(undefined)).toEqual(DEFAULT_SPEND_CAP);
  });

  it('rejects nonsense with a readable message', () => {
    expect(() => validateSpendCap({ dailyUsd: -1 })).toThrow(/daily cap/i);
    expect(() => validateSpendCap({ dailyUsd: 'lots' })).toThrow(/daily cap/i);
    expect(() => validateSpendCap({ quotaPausePercent: 150 })).toThrow(/between 50 and 100/);
    expect(() => validateSpendCap({ projects: { '  ': 2 } })).toThrow(/project name/i);
  });
});

describe('evaluateSpend', () => {
  it('reports each capped scope as ok, near (80%+) or over', () => {
    const status = evaluateSpend(
      { ...DEFAULT_SPEND_CAP, dailyUsd: 10, projects: { web: 2, api: 5, idle: 1 } },
      [{ project: 'web', costUsd: 2.5 }, { project: 'api', costUsd: 4.2 }, { project: 'other', costUsd: 1 }],
      '2026-11-14',
    );
    expect(status.day).toBe('2026-11-14');
    expect(status.totalUsd).toBeCloseTo(7.7);
    expect(status.scopes.map((scope) => [scope.scope, scope.project, scope.limitUsd, scope.state])).toEqual([
      ['fleet', undefined, 10, 'ok'],
      ['project', 'api', 5, 'near'],
      ['project', 'idle', 1, 'ok'],
      ['project', 'web', 2, 'over'],
    ]);
    expect(status.scopes.find((scope) => scope.project === 'idle')?.spentUsd).toBe(0);
  });

  it('has no scopes when nothing is capped', () => {
    expect(evaluateSpend(DEFAULT_SPEND_CAP, [{ project: 'web', costUsd: 100 }], '2026-11-14').scopes).toEqual([]);
  });
});

describe('quotaPressure', () => {
  it('returns the fullest reported window for the vendor at or above the threshold', () => {
    const report = [
      vendor('claude', [
        { window: 'five_hour', label: '5-hour', usedPercent: 92, resetsAt: 5000, observedAt: 1, source: 'claude-sdk' },
        { window: 'seven_day', label: 'Weekly', usedPercent: 60, observedAt: 1, source: 'claude-sdk' },
      ]),
      vendor('codex', [{ window: 'weekly', label: 'Weekly', usedPercent: 40, observedAt: 1, source: 'codex' }]),
    ];
    expect(quotaPressure(report, 'claude', 90)).toEqual({ vendor: 'claude', label: '5-hour', usedPercent: 92, resetsAt: 5000 });
    expect(quotaPressure(report, 'codex', 90)).toBeUndefined();
    expect(quotaPressure(report, 'copilot', 90)).toBeUndefined();
  });

  it('treats a rejected window as full even without a percentage', () => {
    const report = [vendor('claude', [{ window: 'five_hour', label: '5-hour', status: 'rejected', observedAt: 1, source: 'claude-sdk' }])];
    expect(quotaPressure(report, 'claude', 95)).toMatchObject({ usedPercent: 100 });
  });

  it('does nothing when the threshold is off', () => {
    const report = [vendor('claude', [{ window: 'five_hour', label: '5-hour', usedPercent: 99, observedAt: 1, source: 'claude-sdk' }])];
    expect(quotaPressure(report, 'claude', undefined)).toBeUndefined();
  });
});

describe('automatedLaunchBlock', () => {
  const config = { ...DEFAULT_SPEND_CAP, dailyUsd: 10, projects: { web: 2 }, quotaPausePercent: 90 };

  it('blocks when the fleet or the launch\'s project is over its cap', () => {
    const over = evaluateSpend(config, [{ project: 'api', costUsd: 11 }], 'd');
    expect(automatedLaunchBlock(over, undefined, 'api')).toMatch(/\$11\.00 today.*\$10\.00 daily cap/);
    const projectOver = evaluateSpend(config, [{ project: 'web', costUsd: 2.1 }], 'd');
    expect(automatedLaunchBlock(projectOver, undefined, 'web')).toMatch(/Project web/);
    expect(automatedLaunchBlock(projectOver, undefined, 'api')).toBeUndefined();
  });

  it('blocks on quota pressure and says when the window resets', () => {
    const fine = evaluateSpend(config, [], 'd');
    const reason = automatedLaunchBlock(fine, { vendor: 'claude', label: '5-hour', usedPercent: 93, resetsAt: Date.UTC(2026, 10, 14, 15, 30) }, 'web');
    expect(reason).toMatch(/Claude 5-hour window is at 93%/);
    expect(reason).toMatch(/resets at/);
  });
});
