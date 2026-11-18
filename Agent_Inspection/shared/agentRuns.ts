import type { ArchitectureDocument } from './architecture.ts';
import type { RunExecution } from './agentPlatform.ts';
import type { EvaluationScore } from './agentEvaluation.ts';
export type AgentRunStatus = 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface AgentRunEvent { seq: number; ts: number; kind: 'status' | 'model' | 'tool' | 'memory' | 'output' | 'approval' | 'error' | 'evaluation'; message: string; detail?: string }
export interface AgentRun {
  id: string; architectureId: string; architectureTitle: string; revision: number; nodeId: string; agentName: string; project: string;
  runtime: 'api' | 'managed'; provider: string; model: string; status: AgentRunStatus; input: string; output?: string; error?: string;
  createdAt: number; startedAt?: number; finishedAt?: number; agentId?: string; retryOf?: string;
  usage: { inputTokens: number; outputTokens: number; toolCalls: number }; events: AgentRunEvent[];
  pending?: { id: string; title: string; detail: string; expiresAt: number };
  deploymentId?: string; deploymentVersion?: number; environmentId?: string; conversationId?: string; source?: 'chat' | 'api' | 'interval' | 'webhook' | 'experiment'; experimentId?: string;
  artifacts?: { path: string; nodeId: string }[];
  evaluations?: EvaluationScore[];
  /** Structured tool trajectory: what the agent called, with what (redacted, truncated) arguments, and how it went. */
  toolCalls?: ToolCallRecord[];
  activeNodeId?: string;
  /** Durable workflow checkpoints. Completed steps are reused when resuming. */
  steps?: WorkflowStep[];
  resumeOf?: string;
  executionKey?: string;
}
export interface WorkflowStep {
  id: string; nodeId: string; name: string; kind: 'agent' | 'approval' | 'router' | 'output' | 'memory';
  status: 'running' | 'succeeded' | 'failed' | 'uncertain'; input: string; output?: string;
  startedAt: number; finishedAt?: number; error?: string;
}
export interface StoredAgentRun extends AgentRun { definition: ArchitectureDocument; execution?: RunExecution; allowUncertainReplay?: boolean; activeToolOffset?: number }
export interface ToolCallRecord { seq: number; ts: number; name: string; source: 'tool' | 'mcp' | 'memory' | 'code'; args: unknown; ok: boolean; error?: string; durationMs: number; approval: 'auto' | 'operator' | 'harness' }
/** One tool exactly as the model sees it, plus the gateway policy applied to its calls. */
export interface ToolManifestEntry {
  name: string; label: string; description: string; parameters: Record<string, unknown>;
  source: 'tool' | 'mcp' | 'memory' | 'code'; nodeId?: string; readOnly: boolean; approval: boolean; memoryAction?: 'get' | 'put';
}
export const ACTIVE_AGENT_RUNS: readonly AgentRunStatus[] = ['queued', 'running', 'waiting_approval'];
