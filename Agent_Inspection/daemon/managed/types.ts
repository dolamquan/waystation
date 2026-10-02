import type { Agent, AgentEvent, InterceptionDecision, PendingInterception } from '../domain/types.ts';
import type { ReadGuard } from './writeGuard.ts';

export interface StdioMcpServer {
  readonly command: string;
  readonly args: readonly string[];
  /** Non-secret values; they may appear on a command line. */
  readonly env: Readonly<Record<string, string>>;
  /** Names of variables from the agent's own environment (`ManagedLaunch.env`) to forward, for secrets. */
  readonly inheritEnv?: readonly string[];
}

export interface ManagedLaunch {
  readonly vendor: 'claude' | 'codex';
  readonly cwd: string;
  readonly prompt: string;
  readonly name?: string;
  /** Claude only: resume (and fork) an existing session's context. */
  readonly resumeSessionId?: string;
  readonly fork?: boolean;
  readonly appendSystemPrompt?: string;
  readonly intercept?: boolean;
  /** Model override, e.g. "claude-sonnet-5-5" or a Codex model name. */
  readonly model?: string;
  /** Extra stdio MCP servers (the team bridge). */
  readonly mcpServers?: Readonly<Record<string, StdioMcpServer>>;
  /**
   * Sandbox root. Claude: file-writing tools are denied outside it. Codex: runs with the
   * workspace-write sandbox, which confines writes to the working folder.
   */
  readonly writeRoot?: string;
  /** Claude only: file-reading tools may not open `deny` (except `allow`). */
  readonly readGuard?: ReadGuard;
  /** Extra environment for the agent process (kept out of argv so other processes cannot read it from the command line). */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ManagedHost {
  readonly onAgent: (agent: Agent) => void;
  readonly onEvent: (event: AgentEvent) => void;
  readonly onExit: (agentId: string) => void;
  /** The signal aborts when the SDK abandons the permission request (interrupt/stop). */
  readonly requestDecision: (
    item: Omit<PendingInterception, 'id' | 'createdAt'>,
    signal?: AbortSignal,
  ) => Promise<InterceptionDecision>;
}

export interface ManagedRunner {
  readonly id: string;
  readonly sessionId: string | undefined;
  snapshot(): Agent;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  setIntercepting(on: boolean): void;
  stop(): Promise<void>;
}
