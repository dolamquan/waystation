import type { AgentDeployment } from './agentPlatform.ts';
import type { JsonSchema } from './agentResources.ts';
/** `expectedTools` is the reference trajectory (tool names in call order), captured from a run or written by hand. */
export interface DatasetExample { id: string; input: string; reference: string; split: 'test' | 'train' | 'validation'; sourceRunId?: string; expectedTools?: string[] }
export interface AgentDataset { id: string; project: string; name: string; description: string; revision: number; examples: DatasetExample[]; updatedAt: number }
export type TrajectoryMode = 'exact' | 'in_order' | 'any_order';
/**
 * Output graders look at the final text; trajectory graders look at the structured tool calls the run made
 * (exact/in-order/any-order match with precision and recall, as in Vertex AI agent evaluation); budget graders
 * check steps and latency. `llm` is model-graded and should be spot-checked against human judgement.
 */
export type EvaluatorSpec =
  | { kind: 'exact'; ignoreCase: boolean } | { kind: 'contains'; text: string; ignoreCase: boolean } | { kind: 'regex'; pattern: string; flags: string }
  | { kind: 'json'; schema: JsonSchema } | { kind: 'javascript'; code: string } | { kind: 'llm'; connectionId: string; criteria: string }
  | { kind: 'tool_called'; tool: string; minCalls: number } | { kind: 'tool_not_called'; tool: string }
  | { kind: 'trajectory'; tools: string[]; mode: TrajectoryMode } | { kind: 'max_tool_calls'; max: number } | { kind: 'latency'; maxMs: number };
export const EVALUATOR_KINDS = ['exact', 'contains', 'regex', 'json', 'javascript', 'llm', 'tool_called', 'tool_not_called', 'trajectory', 'max_tool_calls', 'latency'] as const;
export interface AgentEvaluator { id: string; project: string; name: string; version: number; threshold: number; spec: EvaluatorSpec; createdAt: number }
export interface EvaluationScore { evaluatorId: string; evaluatorName: string; version: number; score?: number; passed?: boolean; comment: string; error?: string; usage?: { inputTokens: number; outputTokens: number; toolCalls: number } }
export interface ExperimentCase { id: string; exampleId: string; repetition: number; input: string; reference: string; status: 'pending' | 'running' | 'evaluating' | 'completed' | 'failed' | 'cancelled'; runId?: string; output?: string; error?: string; scores: EvaluationScore[]; durationMs?: number; tokens?: number; toolNames?: string[]; expectedTools?: string[] }
export interface AgentExperiment {
  id: string; project: string; name: string; dataset: AgentDataset; evaluators: AgentEvaluator[]; deployment: AgentDeployment;
  status: 'running' | 'completed' | 'cancelled' | 'interrupted'; allowTools: boolean; repetitions: number; createdAt: number; finishedAt?: number; retryOf?: string; cases: ExperimentCase[];
  /** Which agent was tested: `live` runs the deployed tools for real; `disabled` strips every tool, so it is not the deployed agent. */
  toolMode?: 'live' | 'disabled';
}
export interface ExperimentSummary { id: string; name: string; status: AgentExperiment['status']; datasetId: string; datasetName: string; datasetRevision: number; deploymentId: string; deploymentName: string; deploymentVersion: number; createdAt: number; total: number; completed: number; failed: number; averageScore?: number; stats: ExperimentStats; toolMode: 'live' | 'disabled' }

export interface ExperimentStats {
  total: number; finished: number; passed: number; failed: number; errored: number;
  /** Share of cases where every evaluator passed. Failed, errored and cancelled cases count as not passed. */
  passRate: number;
  /** Per example: at least one repetition passed (pass@k) / every repetition passed (pass^k). */
  passAtK: number; passHatK: number;
  /** Mean evaluator score with unscored cases counted as 0, so failures can never raise the average. */
  meanScore: number; p50Ms?: number; p95Ms?: number; tokens: number;
  perEvaluator: { evaluatorId: string; name: string; passRate: number; meanScore: number }[];
}

const FINAL: readonly ExperimentCase['status'][] = ['completed', 'failed', 'cancelled'];
export const casePassed = (c: ExperimentCase): boolean => c.status === 'completed' && c.scores.length > 0 && c.scores.every(s => s.passed === true);
const percentile = (values: number[], p: number): number | undefined => { if (!values.length) return undefined; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]; };
const groupByExample = (cases: readonly ExperimentCase[]): Map<string, ExperimentCase[]> => { const m = new Map<string, ExperimentCase[]>(); for (const c of cases) m.set(c.exampleId, [...(m.get(c.exampleId) ?? []), c]); return m; };

export function experimentStats(e: Pick<AgentExperiment, 'cases' | 'evaluators'>): ExperimentStats {
  const total = e.cases.length; const finished = e.cases.filter(c => FINAL.includes(c.status));
  const passed = e.cases.filter(casePassed).length; const examples = [...groupByExample(e.cases).values()];
  const rate = (n: number, d: number) => d ? n / d : 0;
  const scoreOf = (c: ExperimentCase, id?: string) => { const scores = c.scores.filter(s => !id || s.evaluatorId === id); return scores.length ? scores.reduce((a, s) => a + (typeof s.score === 'number' ? s.score : 0), 0) / scores.length : 0; };
  const durations = e.cases.flatMap(c => typeof c.durationMs === 'number' && c.status === 'completed' ? [c.durationMs] : []);
  return {
    total, finished: finished.length, passed, failed: finished.length - passed, errored: e.cases.filter(c => c.status === 'failed' || c.scores.some(s => s.error)).length,
    passRate: rate(passed, total), passAtK: rate(examples.filter(cs => cs.some(casePassed)).length, examples.length), passHatK: rate(examples.filter(cs => cs.every(casePassed)).length, examples.length),
    meanScore: rate(e.cases.reduce((a, c) => a + scoreOf(c), 0), total), p50Ms: percentile(durations, .5), p95Ms: percentile(durations, .95),
    tokens: e.cases.reduce((a, c) => a + (c.tokens ?? 0), 0),
    perEvaluator: e.evaluators.map(ev => ({ evaluatorId: ev.id, name: ev.name, passRate: rate(e.cases.filter(c => c.scores.some(s => s.evaluatorId === ev.id && s.passed)).length, total), meanScore: rate(e.cases.reduce((a, c) => a + scoreOf(c, ev.id), 0), total) })),
  };
}

/** Examples that passed every repetition on the baseline but fail at least one repetition on the candidate. */
export function regressions(baseline: Pick<AgentExperiment, 'cases'>, candidate: Pick<AgentExperiment, 'cases'>): string[] {
  const before = groupByExample(baseline.cases); const after = groupByExample(candidate.cases);
  return [...before.entries()].filter(([id, cs]) => cs.every(casePassed) && (after.get(id) ?? []).some(c => !casePassed(c))).map(([id]) => id);
}

/** Trajectory match with Vertex-style precision/recall. `actual` and `expected` are tool names in call order. */
export function trajectoryScore(actual: readonly string[], expected: readonly string[], mode: TrajectoryMode): { match: boolean; precision: number; recall: number } {
  const remaining = [...actual]; let hits = 0;
  for (const tool of expected) { const i = remaining.indexOf(tool); if (i >= 0) { hits++; remaining.splice(i, 1); } }
  const precision = actual.length ? hits / actual.length : expected.length ? 0 : 1; const recall = expected.length ? hits / expected.length : 1;
  let match: boolean;
  if (mode === 'exact') match = actual.length === expected.length && actual.every((t, i) => t === expected[i]);
  else if (mode === 'any_order') match = hits === expected.length;
  else { let i = 0; for (const t of actual) if (t === expected[i]) i++; match = i === expected.length; }
  return { match, precision, recall };
}
export interface SandboxConfig { backend: 'quickjs' | 'docker'; language: 'javascript' | 'python' | 'shell'; memoryMb: number; timeoutMs: number }
export interface SandboxExecution { id: string; project: string; runId?: string; config: SandboxConfig; status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; code: string; input: unknown; output?: unknown; stdout: string; stderr: string; exitCode?: number; createdAt: number; finishedAt?: number; error?: string }
export const DEFAULT_SANDBOX: SandboxConfig = { backend: 'quickjs', language: 'javascript', memoryMb: 32, timeoutMs: 1000 };
export function validateSandbox(raw: unknown): SandboxConfig {
  const c = raw as SandboxConfig; if (!c || !['quickjs', 'docker'].includes(c.backend) || !['javascript', 'python', 'shell'].includes(c.language)) throw new Error('Choose a sandbox backend and language.');
  if (c.backend === 'quickjs' && c.language !== 'javascript') throw new Error('The isolated interpreter supports JavaScript. Choose Docker for Python or shell.');
  if (!Number.isInteger(c.timeoutMs) || c.timeoutMs < 100 || c.timeoutMs > (c.backend === 'quickjs' ? 1000 : 30000)) throw new Error('Sandbox timeout must be 100–1000 ms for JavaScript or up to 30000 ms for Docker.');
  if (!Number.isInteger(c.memoryMb) || c.memoryMb < (c.backend === 'quickjs' ? 16 : 64) || c.memoryMb > (c.backend === 'quickjs' ? 64 : 1024)) throw new Error('Choose 16–64 MB for the interpreter or 64–1024 MB for Docker.');
  return { backend: c.backend, language: c.language, memoryMb: c.memoryMb, timeoutMs: c.timeoutMs };
}
