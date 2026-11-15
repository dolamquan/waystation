/** What a console can run. Each is launched from a fixed command line, never from user-supplied text. */
export const CONSOLE_KINDS = ['claude', 'codex', 'shell'] as const;
export type ConsoleKind = (typeof CONSOLE_KINDS)[number];

export const isConsoleKind = (value: unknown): value is ConsoleKind =>
  typeof value === 'string' && (CONSOLE_KINDS as readonly string[]).includes(value);

export type ConsoleState = 'running' | 'exited';

/** What a Claude Code console reports through its own hooks; absent when hooks cannot be linked to it. */
export type ConsoleAttention = 'working' | 'needs-you' | 'ready';

export interface ConsoleInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: ConsoleKind;
  readonly cwd: string;
  readonly state: ConsoleState;
  readonly exitCode?: number;
  readonly createdAt: number;
  /**
   * When this console's process was spawned. Equals createdAt for a new console; later for one restored after a
   * restart (which keeps its original createdAt but runs a fresh `--continue` / `resume` process).
   */
  readonly launchedAt?: number;
  /** When the console last printed something; the board reads "working" from how recent this is. */
  readonly lastOutputAt: number;
  /** From the CLI's own hooks (Claude Code only); the board prefers it over output recency. */
  readonly attention?: ConsoleAttention;
  /** The registry agent whose session runs in this console, once the daemon has linked them; channels and the board use it. */
  readonly agentId?: string;
}

/** What is remembered about a console across daemon restarts. Never any terminal output. */
export type SavedConsoleSpec = Pick<ConsoleInfo, 'id' | 'name' | 'kind' | 'cwd' | 'createdAt'> & {
  /**
   * The Claude Code session / Codex thread that ran in it, so a restore reopens exactly that conversation.
   * "Continue the latest session" would put every console of a folder on the same conversation.
   */
  readonly sessionId?: string;
};

/** Claude Code session ids and Codex thread ids: hex and dashes only, so one can go on a fixed command line. */
export const SESSION_ID = /^[0-9a-f][0-9a-f-]{7,63}$/i;

/** Sent from the daemon to a console's browser socket. */
export type ConsoleServerMessage =
  | { readonly type: 'replay'; readonly data: string }
  | { readonly type: 'output'; readonly data: string }
  | { readonly type: 'exit'; readonly code: number }
  /** The console was removed from the board (dismissed, or the daemon is stopping). */
  | { readonly type: 'closed' };

/** Sent from the browser to the daemon. */
export type ConsoleClientMessage =
  | { readonly type: 'input'; readonly data: string }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number };

/** The slice of a pseudo-terminal the manager needs, so tests can supply a fake. */
export interface PtyHandle {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawnOptions {
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: Readonly<Record<string, string>>;
}

export type PtySpawn = (file: string, args: readonly string[], options: PtySpawnOptions) => Promise<PtyHandle>;

export class ConsoleInputError extends Error {}
