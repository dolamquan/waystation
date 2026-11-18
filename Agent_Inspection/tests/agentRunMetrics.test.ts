import { describe, expect, it } from 'vitest';
import { metricsWindow, percentile, runMetrics } from '../daemon/architecture/runMetrics.ts';
import type { AgentRun, ToolCallRecord } from '../shared/agentRuns.ts';

const HOUR = 3_600_000;
const FROM = Date.UTC(2026, 10, 14, 0);
const TO = FROM + 24 * HOUR;
const PROJECT = 'C:\\work\\alpha';
let seq = 0;

function run(over: Partial<AgentRun> = {}): AgentRun {
  seq += 1;
  const createdAt = over.createdAt ?? FROM + HOUR;
  return {
    id: `run-${seq}`, architectureId: 'arch', architectureTitle: 'Support', revision: 1, nodeId: 'agent', agentName: 'Triage', project: PROJECT,
    runtime: 'api', provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'succeeded', input: 'task', createdAt,
    startedAt: createdAt, finishedAt: createdAt + 1000, usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 }, events: [], source: 'chat', ...over,
  };
}
const call = (over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({ seq: 1, ts: FROM, name: 'search', source: 'tool', args: {}, ok: true, durationMs: 100, approval: 'auto', ...over });
const metrics = (runs: AgentRun[], extra: Partial<Parameters<typeof runMetrics>[1]> = {}) => runMetrics(runs, { from: FROM, to: TO, bucketMs: HOUR, project: PROJECT, now: TO, ...extra });

describe('runMetrics', () => {
  it('returns zeroed totals and empty buckets for no data', () => {
    const m = metrics([]);
    expect(m.totals).toMatchObject({ runs: 0, successRate: null, errorRate: null, p50Ms: null, p95Ms: null, toolErrorRate: null, estimatedCostUsd: 0, unpricedRuns: 0 });
    expect(m.timeseries).toHaveLength(24);
    expect(m.timeseries.every(b => b.succeeded + b.failed + b.cancelled + b.other === 0)).toBe(true);
    expect(m.byAgent).toEqual([]); expect(m.recentFailures).toEqual([]); expect(m.agents).toEqual([]);
  });

  it('counts statuses and derives success and error rates from finished runs only', () => {
    const m = metrics([run(), run(), run({ status: 'failed', error: 'boom' }), run({ status: 'cancelled' }), run({ status: 'running', finishedAt: undefined }), run({ status: 'interrupted' })]);
    expect(m.totals).toMatchObject({ runs: 6, succeeded: 2, failed: 1, cancelled: 1, interrupted: 1, active: 1 });
    expect(m.totals.successRate).toBeCloseTo(2 / 5);
    expect(m.totals.errorRate).toBeCloseTo(1 / 5);
    expect(m.timeseries[1]).toMatchObject({ succeeded: 2, failed: 1, cancelled: 1, other: 2 });
  });

  it('computes nearest-rank latency percentiles from finished runs that started', () => {
    const runs = Array.from({ length: 100 }, (_, i) => run({ startedAt: FROM, finishedAt: FROM + (i + 1) * 10, createdAt: FROM }));
    runs.push(run({ status: 'cancelled', startedAt: undefined, finishedAt: FROM + 999_999, createdAt: FROM }));
    const m = metrics(runs);
    expect(m.totals).toMatchObject({ p50Ms: 500, p95Ms: 950, p99Ms: 990 });
    expect(m.timeseries[0]).toMatchObject({ p50Ms: 500, p95Ms: 950 });
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.99)).toBe(7);
  });

  it('reports the previous equal-length period separately for deltas', () => {
    const m = metrics([run(), run({ createdAt: FROM - HOUR, status: 'failed' }), run({ createdAt: FROM - 2 * HOUR }), run({ createdAt: FROM - 25 * HOUR })]);
    expect(m.totals.runs).toBe(1);
    expect(m.previous).toMatchObject({ runs: 2, succeeded: 1, failed: 1, successRate: 0.5 });
  });

  it('never includes runs from another project folder', () => {
    const m = metrics([run(), run({ project: 'C:/work/alpha/' }), run({ project: 'C:\\work\\beta', agentName: 'Leaked', status: 'failed' }), run({ project: '' })]);
    expect(m.totals.runs).toBe(2);
    expect(m.recentFailures).toEqual([]);
    expect(m.agents.map(a => a.agentName)).toEqual(['Triage']);
    expect(() => metrics([], { project: '' })).toThrow();
  });

  it('estimates cost only for priced models and counts the unpriced runs', () => {
    const m = metrics([run({ usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, toolCalls: 0 } }), run({ model: 'gpt-mystery', provider: 'openai', usage: { inputTokens: 5_000_000, outputTokens: 0, toolCalls: 0 } })]);
    expect(m.totals.estimatedCostUsd).toBeCloseTo(3 + 15);
    expect(m.totals.unpricedRuns).toBe(1);
    expect(m.totals.inputTokens).toBe(6_000_000);
    const mystery = m.byModel.find(r => r.model === 'gpt-mystery');
    expect(mystery?.estimatedCostUsd).toBeNull();
    expect(m.byModel.find(r => r.model === 'claude-sonnet-4-6')?.estimatedCostUsd).toBeCloseTo(18);
  });

  it('breaks down by agent, source and tool, and filters by agent and source', () => {
    const runs = [
      run({ usage: { inputTokens: 0, outputTokens: 0, toolCalls: 2 }, toolCalls: [call(), call({ ok: false, error: 'timeout', durationMs: 300, approval: 'operator' })] }),
      run({ nodeId: 'writer', agentName: 'Writer', source: 'webhook', status: 'failed', error: 'bad', finishedAt: FROM + 5 * HOUR }),
      run({ nodeId: 'writer', agentName: 'Writer', source: 'webhook' }),
    ];
    const m = metrics(runs);
    expect(m.byAgent.map(a => [a.key, a.runs])).toEqual([['arch:writer', 2], ['arch:agent', 1]]);
    expect(m.bySource).toEqual([{ source: 'webhook', runs: 2, failed: 1, successRate: 0.5 }, { source: 'chat', runs: 1, failed: 0, successRate: 1 }]);
    expect(m.byTool).toEqual([{ name: 'search', source: 'tool', calls: 2, errors: 1, errorRate: 0.5, avgDurationMs: 200, operatorApprovals: 1, harnessApprovals: 0 }]);
    expect(m.totals).toMatchObject({ toolCalls: 2, recordedToolCalls: 2, toolErrors: 1, toolErrorRate: 0.5 });
    expect(m.recentFailures).toEqual([expect.objectContaining({ agentName: 'Writer', error: 'bad', finishedAt: FROM + 5 * HOUR })]);
    const writer = metrics(runs, { architectureId: 'arch', nodeId: 'writer' });
    expect(writer.totals.runs).toBe(2);
    expect(writer.agents).toHaveLength(2);
    expect(metrics(runs, { source: 'chat' }).totals.runs).toBe(1);
  });

  it('keeps the ten most recent failures, newest first', () => {
    const runs = Array.from({ length: 12 }, (_, i) => run({ status: 'failed', finishedAt: FROM + i * HOUR }));
    const failures = metrics(runs).recentFailures;
    expect(failures).toHaveLength(10);
    expect(failures[0].finishedAt).toBe(FROM + 11 * HOUR);
  });

  it('rejects malformed windows', () => {
    expect(() => metrics([], { to: FROM })).toThrow(RangeError);
    expect(() => metrics([], { bucketMs: 1 })).toThrow(RangeError);
  });
});

describe('metricsWindow', () => {
  it('ends at the close of the current local bucket', () => {
    const now = Date.UTC(2026, 10, 14, 10, 30);
    expect(metricsWindow(now, 24 * HOUR, HOUR)).toEqual({ from: Date.UTC(2026, 10, 13, 11), to: Date.UTC(2026, 10, 14, 11) });
    const day = 24 * HOUR;
    const local = metricsWindow(now, 30 * day, day, 300);
    expect(local.to).toBe(Date.UTC(2026, 10, 15, 5));
    expect(local.to - local.from).toBe(30 * day);
  });
});
