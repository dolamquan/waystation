import type { ConsoleAttention as Attention, ConsoleInfo } from './types.ts';

/** How long a session that matched no console is left alone before it is looked up again. */
const MISS_TTL_MS = 15_000;
/** Deepest process ancestry walked; also stops a parent cycle from looping. */
const MAX_ANCESTORS = 64;

/**
 * What a Claude Code hook event means for its console. `null` means the session ended, so the console
 * drops back to output-recency; `undefined` means the event says nothing about attention.
 */
export function attentionForHook(input: Readonly<Record<string, unknown>>): Attention | null | undefined {
  switch (input.hook_event_name) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working';
    case 'Notification':
      // permission_prompt and idle_prompt both wait on the operator; a plain sign-in confirmation does not.
      return input.notification_type === 'auth_success' ? undefined : 'needs-you';
    case 'Stop':
      return 'ready';
    case 'SessionEnd':
      return null;
    default:
      return undefined;
  }
}

/** The slice of PtyManager the linker needs, so tests can supply a fake. */
export interface AttentionConsoles {
  list(): ConsoleInfo[];
  pidOf(id: string): number | undefined;
  setAttention(id: string, value: Attention | undefined): void;
}

export interface ConsoleAttentionDeps {
  readonly consoles: AttentionConsoles;
  /** The Claude Code process id for a session (from its session file); undefined when unknown. */
  readonly sessionPid: (sessionId: string) => Promise<number | undefined>;
  /** Process table as child pid -> parent pid. */
  readonly parents: () => Promise<ReadonlyMap<number, number>>;
  readonly now?: () => number;
}

/**
 * Reflects Claude Code hook events on the console the session runs in.
 *
 * The hook payload carries no pid or console id, so the link is made from the other side: the session file
 * names the Claude process, and the console is the one whose pseudo-terminal pid is an ancestor of it. That
 * needs nothing from the child's environment (so no id can leak or be spoofed) and works with hooks that are
 * already installed. Anything that cannot be resolved is skipped silently and the console keeps output-recency.
 */
export class ConsoleAttention {
  private readonly linked = new Map<string, string>();
  private readonly missedAt = new Map<string, number>();
  private readonly lookups = new Map<string, Promise<string | undefined>>();

  constructor(private readonly deps: ConsoleAttentionDeps) {}

  async handle(input: Readonly<Record<string, unknown>>): Promise<void> {
    const sessionId = typeof input.session_id === 'string' ? input.session_id : undefined;
    const value = attentionForHook(input);
    if (!sessionId || value === undefined) return;
    const consoleId = await this.consoleFor(sessionId);
    if (!consoleId) return;
    this.deps.consoles.setAttention(consoleId, value ?? undefined);
    if (value === null) this.linked.delete(sessionId);
  }

  private async consoleFor(sessionId: string): Promise<string | undefined> {
    const claudeConsoles = this.deps.consoles.list().filter((info) => info.kind === 'claude' && info.state === 'running');
    if (claudeConsoles.length === 0) return undefined;
    const cached = this.linked.get(sessionId);
    if (cached && claudeConsoles.some((info) => info.id === cached)) return cached;
    const now = (this.deps.now ?? Date.now)();
    const missed = this.missedAt.get(sessionId);
    if (missed !== undefined && now - missed < MISS_TTL_MS) return undefined;
    // Events of one session arrive back to back; they share one lookup and are applied in arrival order.
    const pending = this.lookups.get(sessionId) ?? this.lookup(sessionId, claudeConsoles, now);
    this.lookups.set(sessionId, pending);
    return pending;
  }

  private async lookup(sessionId: string, claudeConsoles: readonly ConsoleInfo[], now: number): Promise<string | undefined> {
    try {
      const found = await this.resolve(sessionId, claudeConsoles);
      if (found) this.linked.set(sessionId, found);
      else this.missedAt.set(sessionId, now);
      return found;
    } catch {
      // No process table (non-Windows, PowerShell blocked): the console keeps its output-recency status.
      this.missedAt.set(sessionId, now);
      return undefined;
    } finally {
      this.lookups.delete(sessionId);
    }
  }

  private async resolve(sessionId: string, claudeConsoles: readonly ConsoleInfo[]): Promise<string | undefined> {
    const pid = await this.deps.sessionPid(sessionId);
    if (pid === undefined) return undefined;
    const byPid = new Map<number, string>();
    for (const info of claudeConsoles) {
      const ptyPid = this.deps.consoles.pidOf(info.id);
      if (ptyPid !== undefined) byPid.set(ptyPid, info.id);
    }
    const parents = await this.deps.parents();
    let current: number | undefined = pid;
    for (let depth = 0; current !== undefined && depth < MAX_ANCESTORS; depth += 1) {
      const owner = byPid.get(current);
      if (owner) return owner;
      current = parents.get(current);
    }
    return undefined;
  }
}
