import { folder } from '../../web/src/stationOffices.ts';
import { costUsd } from '../usage/pricing.ts';
import { ACTIVE_AGENT_RUNS, type AgentRun } from '../../shared/agentRuns.ts';
import type { AgentMetricsRow, AgentOption, MetricsBucket, ModelMetricsRow, RecentFailure, RunMetrics, RunTotals, SourceMetricsRow, ToolMetricsRow } from '../../shared/agentRunMetrics.ts';

export interface RunMetricsOptions { from: number; to: number; bucketMs: number; project?: string; architectureId?: string; nodeId?: string; source?: string; now: number }

const RECENT_FAILURES = 10;
const MAX_BUCKETS = 400;
const FINISHED = new Set<AgentRun['status']>(['succeeded', 'failed', 'cancelled', 'interrupted']);
const ratio = (part: number, whole: number): number | null => whole > 0 ? part / whole : null;
const agentKey = (run: AgentRun) => `${run.architectureId}:${run.nodeId}`;

/** Nearest-rank percentile over an ascending list; null for an empty list. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** Wall time of a finished run that actually started; queued-then-cancelled runs have no latency. */
const latency = (run: AgentRun): number | undefined =>
  FINISHED.has(run.status) && run.startedAt !== undefined && run.finishedAt !== undefined && run.finishedAt >= run.startedAt ? run.finishedAt - run.startedAt : undefined;

/** List-price estimate from input/output tokens; undefined when the model has no price table. */
const runCost = (run: AgentRun): number | undefined =>
  costUsd(run.model, { input: run.usage.inputTokens, output: run.usage.outputTokens, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

const latencies = (runs: readonly AgentRun[]) => runs.map(latency).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
const toolErrors = (run: AgentRun) => (run.toolCalls ?? []).filter(c => !c.ok).length;

function totals(runs: readonly AgentRun[]): RunTotals {
  const count = (status: AgentRun['status']) => runs.filter(r => r.status === status).length;
  const succeeded = count('succeeded'); const failed = count('failed'); const cancelled = count('cancelled'); const interrupted = count('interrupted');
  const finished = succeeded + failed + cancelled + interrupted; const sorted = latencies(runs);
  const costs = runs.map(runCost); const recorded = runs.reduce((n, r) => n + (r.toolCalls?.length ?? 0), 0); const errors = runs.reduce((n, r) => n + toolErrors(r), 0);
  return {
    runs: runs.length, succeeded, failed, cancelled, interrupted, active: runs.filter(r => ACTIVE_AGENT_RUNS.includes(r.status)).length,
    successRate: ratio(succeeded, finished), errorRate: ratio(failed, finished),
    p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), p99Ms: percentile(sorted, 0.99),
    inputTokens: runs.reduce((n, r) => n + r.usage.inputTokens, 0), outputTokens: runs.reduce((n, r) => n + r.usage.outputTokens, 0),
    toolCalls: runs.reduce((n, r) => n + r.usage.toolCalls, 0), recordedToolCalls: recorded, toolErrors: errors, toolErrorRate: ratio(errors, recorded),
    estimatedCostUsd: costs.reduce<number>((n, c) => n + (c ?? 0), 0), unpricedRuns: costs.filter(c => c === undefined).length,
  };
}

function bucket(start: number, runs: readonly AgentRun[]): MetricsBucket {
  const t = totals(runs);
  return { start, succeeded: t.succeeded, failed: t.failed, cancelled: t.cancelled, other: t.interrupted + t.active, p50Ms: t.p50Ms, p95Ms: t.p95Ms,
    inputTokens: t.inputTokens, outputTokens: t.outputTokens, estimatedCostUsd: t.estimatedCostUsd, unpricedRuns: t.unpricedRuns, toolCalls: t.toolCalls, toolErrors: t.toolErrors };
}

function groupBy<K extends string>(runs: readonly AgentRun[], key: (run: AgentRun) => K): Map<K, AgentRun[]> {
  const groups = new Map<K, AgentRun[]>();
  for (const run of runs) groups.set(key(run), [...(groups.get(key(run)) ?? []), run]);
  return groups;
}

function byAgent(runs: readonly AgentRun[]): AgentMetricsRow[] {
  return [...groupBy(runs, agentKey)].map(([key, group]) => {
    const t = totals(group); const latest = group.reduce((a, b) => b.createdAt > a.createdAt ? b : a);
    return { key, architectureId: latest.architectureId, nodeId: latest.nodeId, agentName: latest.agentName, architectureTitle: latest.architectureTitle,
      runs: t.runs, failed: t.failed, successRate: t.successRate, p95Ms: t.p95Ms, estimatedCostUsd: t.estimatedCostUsd, unpricedRuns: t.unpricedRuns };
  }).sort((a, b) => b.runs - a.runs || a.agentName.localeCompare(b.agentName));
}

function byModel(runs: readonly AgentRun[]): ModelMetricsRow[] {
  return [...groupBy(runs, r => `${r.provider}\u0000${r.model}`)].map(([, group]) => {
    const t = totals(group);
    return { model: group[0].model, provider: group[0].provider, runs: t.runs, failed: t.failed, successRate: t.successRate, inputTokens: t.inputTokens, outputTokens: t.outputTokens,
      estimatedCostUsd: t.unpricedRuns === t.runs ? null : t.estimatedCostUsd };
  }).sort((a, b) => b.runs - a.runs || a.model.localeCompare(b.model));
}

function bySource(runs: readonly AgentRun[]): SourceMetricsRow[] {
  return [...groupBy(runs, r => r.source ?? 'chat')].map(([source, group]) => { const t = totals(group); return { source, runs: t.runs, failed: t.failed, successRate: t.successRate }; })
    .sort((a, b) => b.runs - a.runs || a.source.localeCompare(b.source));
}

function byTool(runs: readonly AgentRun[]): ToolMetricsRow[] {
  const calls = runs.flatMap(r => r.toolCalls ?? []);
  const groups = new Map<string, typeof calls>();
  for (const call of calls) { const key = `${call.source}\u0000${call.name}`; groups.set(key, [...(groups.get(key) ?? []), call]); }
  return [...groups.values()].map(group => {
    const errors = group.filter(c => !c.ok).length;
    return { name: group[0].name, source: group[0].source, calls: group.length, errors, errorRate: errors / group.length,
      avgDurationMs: group.reduce((n, c) => n + (Number.isFinite(c.durationMs) ? c.durationMs : 0), 0) / group.length,
      operatorApprovals: group.filter(c => c.approval === 'operator').length, harnessApprovals: group.filter(c => c.approval === 'harness').length };
  }).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

function recentFailures(runs: readonly AgentRun[]): RecentFailure[] {
  return runs.filter(r => r.status === 'failed').map(r => ({ id: r.id, agentName: r.agentName, architectureId: r.architectureId, nodeId: r.nodeId, error: r.error, finishedAt: r.finishedAt ?? r.createdAt }))
    .sort((a, b) => b.finishedAt - a.finishedAt).slice(0, RECENT_FAILURES);
}

/**
 * Run health for one window, bucketed by run creation time. Pure: the caller loads full records (with tool calls) and
 * must pass `project` for any operator-facing view, since runs from other project folders are excluded only by it.
 */
export function runMetrics(runs: readonly AgentRun[], opts: RunMetricsOptions): RunMetrics {
  const { from, to, bucketMs } = opts;
  if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) throw new RangeError('Metrics window must end after it starts.');
  if (!(bucketMs > 0) || Math.ceil((to - from) / bucketMs) > MAX_BUCKETS) throw new RangeError('Metrics bucket size is out of range.');
  const projectKey = opts.project === undefined ? undefined : folder(opts.project)?.key;
  if (opts.project !== undefined && !projectKey) throw new RangeError('Metrics need a project folder.');
  const span = to - from; const previousFrom = from - span;
  const inProject = runs.filter(r => projectKey === undefined || folder(r.project)?.key === projectKey);
  const inEitherPeriod = inProject.filter(r => r.createdAt >= previousFrom && r.createdAt < to);
  const filtered = inEitherPeriod.filter(r => (!opts.architectureId || r.architectureId === opts.architectureId) && (!opts.nodeId || r.nodeId === opts.nodeId) && (!opts.source || (r.source ?? 'chat') === opts.source));
  const current = filtered.filter(r => r.createdAt >= from); const previous = filtered.filter(r => r.createdAt < from);
  const count = Math.ceil(span / bucketMs);
  const buckets = Array.from({ length: count }, (_, i) => from + i * bucketMs);
  const perBucket = groupBy(current, r => String(Math.floor((r.createdAt - from) / bucketMs)));
  const agents: AgentOption[] = byAgent(inEitherPeriod).map(({ key, agentName, architectureTitle }) => ({ key, agentName, architectureTitle }));
  return {
    from, to, bucketMs, generatedAt: opts.now, totals: totals(current), previous: totals(previous),
    timeseries: buckets.map((start, i) => bucket(start, perBucket.get(String(i)) ?? [])),
    byAgent: byAgent(current), byModel: byModel(current), bySource: bySource(current), byTool: byTool(current), recentFailures: recentFailures(current), agents,
  };
}

/** Window ending at the close of the bucket that contains `now`, aligned to the viewer's local clock (`tzOffsetMin` as Date#getTimezoneOffset). */
export function metricsWindow(now: number, rangeMs: number, bucketMs: number, tzOffsetMin = 0): { from: number; to: number } {
  const offset = tzOffsetMin * 60_000; const local = now - offset;
  const to = Math.floor(local / bucketMs) * bucketMs + bucketMs + offset;
  return { from: to - rangeMs, to };
}
