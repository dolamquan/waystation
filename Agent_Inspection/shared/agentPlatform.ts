import type { ArchitectureDocument } from './architecture.ts';
import type { MemoryConfig, ToolConfig } from './agentResources.ts';
import type { AgentRun } from './agentRuns.ts';
import type { SandboxConfig } from './agentEvaluation.ts';

export interface CapabilityRef { id: string; version: number }
export type CapabilitySpec =
  | { kind: 'skill'; instructions: string; requires: string[] }
  | { kind: 'tool'; config: ToolConfig }
  | { kind: 'memory'; config: MemoryConfig }
  | { kind: 'tavily'; connectionId: string; functionName: string; maxResults: number; searchDepth: 'basic' | 'advanced'; includeDomains: string[]; excludeDomains: string[] };
export interface AgentCapability { id: string; project: string; version: number; name: string; description: string; createdAt: number; spec: CapabilitySpec }
export interface ServiceConnection { id: string; project: string; name: string; kind: 'tavily' | 'http' | 'postgres'; endpoint?: string; hasSecret: boolean; createdAt: number }
export interface AgentEnvironment {
  id: string; project: string; name: string; revision: number; runtime: 'local'; maxConcurrentRuns: number;
  network: 'configured' | 'restricted'; allowedHosts: string[]; createdAt: number;
  sandbox?: SandboxConfig;
}
export interface DeploymentSummary {
  id: string; architectureId: string; architectureTitle: string; nodeId: string; name: string; project: string; version: number; revision: number;
  environmentId: string; environmentName: string; status: 'active' | 'paused'; createdAt: number;
  harness: 'api' | 'managed'; provider: string; model: string; capabilities: AgentCapability[];
}
export interface AgentDeployment extends DeploymentSummary { definition: ArchitectureDocument; environment: AgentEnvironment }
export interface ConversationMessage { id: string; role: 'user' | 'assistant'; text: string; ts: number; runId: string; replyToRunId?: string }
export interface AgentConversationRecord { id: string; deploymentId: string; project: string; title: string; createdAt: number; updatedAt: number; messages: ConversationMessage[] }
export interface AgentTrigger { id: string; deploymentId: string; name: string; kind: 'interval' | 'webhook'; text: string; enabled: boolean; intervalMinutes?: number; nextAt?: number; lastRunId?: string; lastError?: string; createdAt: number; hasToken?: boolean }
export interface RunExecution {
  environment: AgentEnvironment; history: { role: 'user' | 'assistant'; content: string }[];
  deploymentId: string; deploymentVersion: number; conversationId?: string; source: 'chat' | 'api' | 'interval' | 'webhook' | 'experiment';
  experimentId?: string; evaluationScope?: string; skipDelivery?: boolean;
}
export interface AgentPlatformState { environments: AgentEnvironment[]; deployments: DeploymentSummary[]; capabilities: AgentCapability[]; connections: ServiceConnection[] }
export interface DeploymentDetail { deployment: AgentDeployment; conversations: AgentConversationRecord[]; runs: AgentRun[]; triggers: AgentTrigger[] }
