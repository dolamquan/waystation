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

/** A remote (HTTP or SSE) MCP server. Header values may be secrets: never log them. */
export interface RemoteMcpServer {
  readonly type: 'http' | 'sse';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ManagedLaunch {
  readonly vendor: 'claude' | 'codex';
  readonly cwd: string;
  /** First instruction. Empty only when resuming a session: the agent then waits, idle, for one. */
  readonly prompt: string;
  /** Keep this agent id (an agent coming back from the operator's terminal stays the same agent). */
  readonly agentId?: string;
  readonly name?: string;
  /** Continue an existing session: Claude resumes (and by default forks) it, Codex resumes the thread. */
  readonly resumeSessionId?: string;
  readonly fork?: boolean;
  readonly appendSystemPrompt?: string;
  readonly intercept?: boolean;
  /** Model override, e.g. "claude-sonnet-5-5" or a Codex model name. */
  readonly model?: string;
  /** Extra stdio MCP servers (the team bridge, library MCP servers, the notify bridge). */
  readonly mcpServers?: Readonly<Record<string, StdioMcpServer>>;
  /** Remote MCP servers from the library. */
  readonly remoteMcpServers?: Readonly<Record<string, RemoteMcpServer>>;
  /** Claude only: local Claude Code plugin directories to load (library skills bundle, installed plugins). */
  readonly plugins?: readonly string[];
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
  /** Model override the agent was launched with, carried over when its session moves to the real CLI. */
  readonly model?: string;
  /** How it was launched, so it can be relaunched on the same session after a spell in the operator's terminal. */
  readonly launch?: ManagedLaunch;
  snapshot(): Agent;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  setIntercepting(on: boolean): void;
  stop(): Promise<void>;
}
