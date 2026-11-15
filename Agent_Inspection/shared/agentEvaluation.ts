import type { AgentDeployment } from './agentPlatform.ts';
import type { JsonSchema } from './agentResources.ts';
export interface DatasetExample { id: string; input: string; reference: string; split: 'test' | 'train' | 'validation'; sourceRunId?: string }
export interface AgentDataset { id: string; project: string; name: string; description: string; revision: number; examples: DatasetExample[]; updatedAt: number }
export type EvaluatorSpec = { kind: 'exact'; ignoreCase: boolean } | { kind: 'contains'; text: string; ignoreCase: boolean } | { kind: 'json'; schema: JsonSchema } | { kind: 'javascript'; code: string } | { kind: 'llm'; connectionId: string; criteria: string };
export interface AgentEvaluator { id: string; project: string; name: string; version: number; threshold: number; spec: EvaluatorSpec; createdAt: number }
export interface EvaluationScore { evaluatorId: string; evaluatorName: string; version: number; score?: number; passed?: boolean; comment: string; error?: string; usage?: { inputTokens: number; outputTokens: number; toolCalls: number } }
export interface ExperimentCase { id: string; exampleId: string; repetition: number; input: string; reference: string; status: 'pending' | 'running' | 'evaluating' | 'completed' | 'failed' | 'cancelled'; runId?: string; output?: string; error?: string; scores: EvaluationScore[]; durationMs?: number; tokens?: number }
export interface AgentExperiment {
  id: string; project: string; name: string; dataset: AgentDataset; evaluators: AgentEvaluator[]; deployment: AgentDeployment;
  status: 'running' | 'completed' | 'cancelled' | 'interrupted'; allowTools: boolean; repetitions: number; createdAt: number; finishedAt?: number; retryOf?: string; cases: ExperimentCase[];
}
export interface ExperimentSummary { id: string; name: string; status: AgentExperiment['status']; datasetId: string; datasetName: string; datasetRevision: number; deploymentName: string; deploymentVersion: number; createdAt: number; total: number; completed: number; failed: number; averageScore?: number }
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
