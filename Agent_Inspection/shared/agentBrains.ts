export type BrainProvider = 'openai' | 'anthropic' | 'compatible';
export interface BrainConnection {
  id: string; project: string; label: string; provider: BrainProvider; baseUrl: string; model: string;
  hasKey: boolean; createdAt: number;
  workspaceId?: string;
}
export interface AgentRuntime {
  kind: 'managed' | 'api';
  connectionId?: string;
  policy: 'chat-only' | 'review-tools' | 'configured-tools';
  maxOutputTokens: number;
  maxSteps?: number;
  maxToolCalls?: number;
  /** Bounds the whole connected workflow, including managed sessions and operator waits. */
  maxDurationSeconds?: number;
  maxWorkflowSteps?: number;
  /** Aggregate input + output token ceiling across all agents in a workflow. */
  maxTotalTokens?: number;
  /** Gives an API agent a `run_code` tool that runs model-written code in a fresh isolated sandbox. */
  codeExecution?: import('./agentEvaluation.ts').SandboxConfig;
}
export type AgentTestResult = { kind: 'api'; text: string; model: string; truncated: boolean } | { kind: 'managed'; agentId: string };
