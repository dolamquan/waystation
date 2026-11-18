/** Contract for GET /api/agent-runs/metrics: run health for one project, computed on the daemon from full run records. */
export type MetricsRange = '24h' | '7d' | '30d';
export const METRICS_RANGES: Record<MetricsRange, { label: string; ms: number; bucketMs: number }> = {
  '24h': { label: 'Last 24 hours', ms: 24 * 3_600_000, bucketMs: 3_600_000 },
  '7d': { label: 'Last 7 days', ms: 7 * 86_400_000, bucketMs: 6 * 3_600_000 },
  '30d': { label: 'Last 30 days', ms: 30 * 86_400_000, bucketMs: 86_400_000 },
};
export const METRICS_SOURCES = ['chat', 'api', 'interval', 'webhook', 'experiment'] as const;

/** Rates are 0..1, or null when there is nothing to divide by. Latencies are milliseconds. Cost is an estimate in USD. */
export interface RunTotals {
  runs: number; succeeded: number; failed: number; cancelled: number; interrupted: number; active: number;
  /** succeeded / finished (succeeded + failed + cancelled + interrupted). */
  successRate: number | null;
  /** failed / finished. */
  errorRate: number | null;
  p50Ms: number | null; p95Ms: number | null; p99Ms: number | null;
  inputTokens: number; outputTokens: number;
  /** Tool calls counted in run usage. */
  toolCalls: number;
  /** Tool calls with a structured record (outcome known); the denominator of toolErrorRate. */
  recordedToolCalls: number; toolErrors: number; toolErrorRate: number | null;
  /** Sum over runs whose model has a list price; runs without one are counted in unpricedRuns and excluded. */
  estimatedCostUsd: number; unpricedRuns: number;
}
export interface MetricsBucket {
  start: number; succeeded: number; failed: number; cancelled: number; other: number;
  p50Ms: number | null; p95Ms: number | null;
  inputTokens: number; outputTokens: number; estimatedCostUsd: number; unpricedRuns: number;
  toolCalls: number; toolErrors: number;
}
export interface AgentMetricsRow { key: string; architectureId: string; nodeId: string; agentName: string; architectureTitle: string; runs: number; failed: number; successRate: number | null; p95Ms: number | null; estimatedCostUsd: number; unpricedRuns: number }
export interface ModelMetricsRow { model: string; provider: string; runs: number; failed: number; successRate: number | null; inputTokens: number; outputTokens: number; estimatedCostUsd: number | null }
export interface SourceMetricsRow { source: string; runs: number; failed: number; successRate: number | null }
export interface ToolMetricsRow { name: string; source: string; calls: number; errors: number; errorRate: number; avgDurationMs: number; operatorApprovals: number; harnessApprovals: number }
export interface RecentFailure { id: string; agentName: string; architectureId: string; nodeId: string; error?: string; finishedAt: number }
export interface AgentOption { key: string; agentName: string; architectureTitle: string }

export interface RunMetrics {
  from: number; to: number; bucketMs: number; generatedAt: number;
  totals: RunTotals;
  /** Same measures for the equal-length period immediately before `from`. */
  previous: RunTotals;
  timeseries: MetricsBucket[];
  byAgent: AgentMetricsRow[]; byModel: ModelMetricsRow[]; bySource: SourceMetricsRow[]; byTool: ToolMetricsRow[];
  recentFailures: RecentFailure[];
  /** Agents with runs in the project over both periods, ignoring the agent and source filters: the agent picker's options. */
  agents: AgentOption[];
}
