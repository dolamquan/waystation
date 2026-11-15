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
}
export type AgentTestResult = { kind: 'api'; text: string; model: string; truncated: boolean } | { kind: 'managed'; agentId: string };
