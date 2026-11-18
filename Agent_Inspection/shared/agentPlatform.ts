import type { ArchitectureDocument } from './architecture.ts';
import type { MemoryConfig, ToolConfig } from './agentResources.ts';
import type { AgentRun } from './agentRuns.ts';
import type { ExperimentCase, ExperimentStats, SandboxConfig } from './agentEvaluation.ts';

export interface CapabilityRef { id: string; version: number }
export type CapabilitySpec =
  | { kind: 'skill'; instructions: string; requires: string[] }
  | { kind: 'tool'; config: ToolConfig }
  | { kind: 'memory'; config: MemoryConfig }
  | { kind: 'tavily'; connectionId: string; functionName: string; maxResults: number; searchDepth: 'basic' | 'advanced'; includeDomains: string[]; excludeDomains: string[] }
  /** Tools discovered from an MCP server at publish time. Schemas are pinned by hash; a server-side change blocks the tool until re-published. */
  | { kind: 'mcp'; connectionId: string; server: string; approval: 'always' | 'trust_read_only'; tools: McpToolSnapshot[] };
export interface McpToolSnapshot { name: string; description: string; inputSchema: Record<string, unknown>; schemaHash: string; readOnlyHint?: boolean; destructiveHint?: boolean }
export interface AgentCapability { id: string; project: string; version: number; name: string; description: string; createdAt: number; spec: CapabilitySpec }
export interface ServiceConnection { id: string; project: string; name: string; kind: 'tavily' | 'http' | 'postgres' | 'mcp'; endpoint?: string; hasSecret: boolean; createdAt: number }
export interface AgentEnvironment {
  id: string; project: string; name: string; revision: number; runtime: 'local'; maxConcurrentRuns: number;
  network: 'configured' | 'restricted'; allowedHosts: string[]; createdAt: number;
  sandbox?: SandboxConfig;
}
export interface DeploymentSummary {
  id: string; architectureId: string; architectureTitle: string; nodeId: string; name: string; project: string; version: number; revision: number;
  environmentId: string; environmentName: string; status: 'active' | 'paused'; createdAt: number;
  harness: 'api' | 'managed'; provider: string; model: string; capabilities: AgentCapability[];
  /** Release stage. Unset on deployments created before release gating; those are treated as production. */
  release?: ReleaseStage; promotion?: PromotionRecord;
}
/** candidate: published, testable, not serving triggers. production: the one version triggers and webhooks run. retired: former production, available for rollback. */
export type ReleaseStage = 'candidate' | 'production' | 'retired';
export interface PromotionRecord { at: number; experimentId?: string; passRate?: number; override?: string; rollback?: boolean; previousVersion?: number }
/** Per-agent release policy: which evaluation a candidate must pass before it can serve production traffic. */
export interface ReleasePolicy { id: string; architectureId: string; nodeId: string; project: string; datasetId: string; evaluatorIds: string[]; minPassRate: number; requireLiveTools: boolean; blockRegressions: boolean; updatedAt: number }
export interface ReleaseEvidence { experimentId: string; name: string; datasetId: string; datasetRevision: number; evaluatorIds: string[]; evaluators?: CapabilityRef[]; toolMode: 'live' | 'disabled'; stats: ExperimentStats; finishedAt: number; cases: ExperimentCase[] }
export interface ReleaseCheck { label: string; ok: boolean; detail: string }
export interface ReleaseGate { deploymentId: string; version: number; passed: boolean; checks: ReleaseCheck[]; experimentId?: string; passRate?: number; regressions: string[]; policy?: ReleasePolicy }
export interface ReleaseState { policy?: ReleasePolicy; production?: DeploymentSummary; versions: (DeploymentSummary & { stage: ReleaseStage; gate?: ReleaseGate })[] }
export interface AgentDeployment extends DeploymentSummary { definition: ArchitectureDocument; environment: AgentEnvironment }
export interface ConversationMessage { id: string; role: 'user' | 'assistant'; text: string; ts: number; runId: string; replyToRunId?: string }
export interface AgentConversationRecord { id: string; deploymentId: string; project: string; title: string; createdAt: number; updatedAt: number; messages: ConversationMessage[] }
/** `follow: 'production'` (default for new triggers) runs whichever version is in production; `pinned` always runs `deploymentId`. */
export interface AgentTrigger { id: string; deploymentId: string; name: string; kind: 'interval' | 'webhook'; text: string; enabled: boolean; follow?: 'production' | 'pinned'; intervalMinutes?: number; nextAt?: number; lastRunId?: string; lastError?: string; createdAt: number; hasToken?: boolean }
export interface RunExecution {
  environment: AgentEnvironment; history: { role: 'user' | 'assistant'; content: string }[];
  deploymentId: string; deploymentVersion: number; conversationId?: string; source: 'chat' | 'api' | 'interval' | 'webhook' | 'experiment';
  experimentId?: string; evaluationScope?: string; skipDelivery?: boolean;
}
export interface AgentPlatformState { environments: AgentEnvironment[]; deployments: DeploymentSummary[]; capabilities: AgentCapability[]; connections: ServiceConnection[] }
export interface DeploymentDetail { deployment: AgentDeployment; conversations: AgentConversationRecord[]; runs: AgentRun[]; triggers: AgentTrigger[] }
