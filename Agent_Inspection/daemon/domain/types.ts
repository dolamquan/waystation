export type Vendor = 'claude' | 'codex' | 'other';

/**
 * A: launched by the tower (full control)
 * B: existing Claude Code session (control via hooks)
 * C: observed only (read + maybe stop)
 */
export type Tier = 'A' | 'B' | 'C';

export type AgentStatus = 'busy' | 'idle' | 'waiting' | 'stopped' | 'unknown';

export interface Agent {
  readonly id: string;
  readonly vendor: Vendor;
  readonly tier: Tier;
  readonly name: string;
  readonly sessionId?: string;
  readonly pid?: number;
  readonly cwd?: string;
  readonly project: string;
  readonly status: AgentStatus;
  readonly source: string;
  readonly currentActivity?: string;
  readonly startedAt?: number;
  readonly lastEventAt?: number;
  readonly hooked: boolean;
  readonly intercepting: boolean;
  /** Present when the Stop action is disabled; explains why. */
  readonly stopBlockedReason?: string;
  readonly canInstruct: boolean;
}

export type EventKind =
  | 'prompt'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'status'
  | 'stop'
  | 'system'
  | 'error';

export interface AgentEvent {
  readonly agentId: string;
  readonly ts: number;
  readonly kind: EventKind;
  readonly summary: string;
}

export interface PendingInterception {
  readonly id: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly createdAt: number;
  readonly origin: 'hook' | 'managed';
}

export type InterceptionDecision =
  | { readonly behavior: 'allow'; readonly updatedInput?: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string }
  | { readonly behavior: 'ask' };
