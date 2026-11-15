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
}
export interface StoredAgentRun extends AgentRun { definition: ArchitectureDocument; execution?: RunExecution }
export const ACTIVE_AGENT_RUNS: readonly AgentRunStatus[] = ['queued', 'running', 'waiting_approval'];
