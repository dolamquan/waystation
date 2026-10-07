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
  /** Model the agent is running, when known (launch override, transcript or session metadata). */
  readonly model?: string;
  readonly usage?: AgentUsage;
  /** Set by the runaway guard once it has stepped in. */
  readonly breaker?: BreakerInfo;
  /** Why a managed agent ended unexpectedly (crash or failed turn); cleared by the next good turn. */
  readonly lastError?: string;
  /** A Waystation agent currently open in the operator's terminal (real CLI). It comes back when that closes. */
  readonly inTerminal?: boolean;
  /** Registry id of the agent that spawned this one (Claude Code or Codex subagents). */
  readonly parentId?: string;
  /** Present on subagents: what was asked of them, from the spawn metadata. */
  readonly subagent?: SubagentInfo;
}

export interface SubagentInfo {
  /** Subagent type, e.g. "Explore" or "general-purpose". */
  readonly type?: string;
  readonly description?: string;
  /** Display name of the parent agent at the time of the last scan. */
  readonly parentName?: string;
}

export interface TokenCounts {
  /** Uncached input tokens. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}

export interface AgentUsage {
  readonly tokens: TokenCounts;
  /** List-price estimate; absent when the model has no known price (e.g. Codex). */
  readonly costUsd?: number;
  /** Tokens in the most recent request's context window, and the window size. */
  readonly contextTokens?: number;
  readonly contextWindow?: number;
}

export type BreakerLevel = 'ok' | 'warned' | 'constrained' | 'stopped';

export interface BreakerInfo {
  readonly level: BreakerLevel;
  readonly reason: string;
  readonly since: number;
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
