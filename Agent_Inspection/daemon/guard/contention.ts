import { EventEmitter } from 'node:events';
import { posix, win32 } from 'node:path';
import type { Agent, AgentEvent } from '../domain/types.ts';
import { filesFromToolSummary } from '../outputs/extract.ts';

/**
 * Notices when agents that are not coordinating (not a parent and its own subagent, not in separate
 * worktrees) write the same file within a short window. Read-only: the tower broadcasts the list
 * and the operator decides what to do (tell them, or move one to its own worktree).
 */

export const CONTENTION_WINDOW_MS = 10 * 60_000;

export interface ContendingAgent {
  readonly agentId: string;
  readonly lastAt: number;
}

export interface FileContention {
  /** Absolute path as first recorded. */
  readonly path: string;
  /** Most recent writer first. */
  readonly agents: readonly ContendingAgent[];
  /** When the earliest of these agents first wrote it within the window. */
  readonly since: number;
}

interface Touch {
  readonly firstAt: number;
  readonly lastAt: number;
}

interface FileRecord {
  readonly path: string;
  readonly touches: ReadonlyMap<string, Touch>;
}

const DRIVE = /^[a-zA-Z]:[\\/]/;

/** Absolute display path for a recorded path, or undefined when a relative path has no folder to resolve against. */
function absolutePath(raw: string, cwd: string | undefined): string | undefined {
  if (DRIVE.test(raw)) return win32.normalize(raw);
  if (raw.startsWith('/')) return posix.normalize(raw);
  if (!cwd) return undefined;
  return DRIVE.test(cwd) ? win32.resolve(cwd, raw) : posix.resolve(cwd, raw);
}

/** Comparison key: forward slashes, and case folded on Windows drives (their file systems ignore case). */
export function fileKey(raw: string, cwd: string | undefined): string | undefined {
  const absolute = absolutePath(raw, cwd);
  if (!absolute) return undefined;
  const slashed = absolute.replace(/\\/g, '/');
  return DRIVE.test(absolute) ? slashed.toLowerCase() : slashed;
}

const related = (a: Agent | undefined, b: Agent | undefined): boolean =>
  !!a && !!b && (a.parentId === b.id || b.parentId === a.id);

/** Emits `changed` with the current list whenever the contested files or agents change. */
export class ContentionTracker extends EventEmitter {
  private files = new Map<string, FileRecord>();
  private signature = '';

  constructor(
    private readonly agent: (agentId: string) => Agent | undefined,
    private readonly windowMs = CONTENTION_WINDOW_MS,
  ) {
    super();
  }

  /** Records the files a tool call wrote. Returns true when the contested set changed. */
  observe(event: AgentEvent): boolean {
    if (event.kind !== 'tool_call') return false;
    const touches = filesFromToolSummary(event.summary);
    if (touches.length === 0) return false;
    const cwd = this.agent(event.agentId)?.cwd;
    for (const touch of touches) this.record(event.agentId, touch.path, cwd, event.ts);
    return this.refresh(event.ts);
  }

  /** Drops expired writes. Returns true when the contested set changed. */
  refresh(now = Date.now()): boolean {
    this.prune(now);
    const next = signatureOf(this.list(now));
    const changed = next !== this.signature;
    this.signature = next;
    if (changed) this.emit('changed', this.list(now));
    return changed;
  }

  list(now = Date.now()): FileContention[] {
    return [...this.files.values()].flatMap((file) => {
      const live = [...file.touches]
        .filter(([agentId, touch]) => now - touch.lastAt < this.windowMs && this.isLive(agentId))
        .map(([agentId, touch]) => ({ agentId, ...touch }));
      const contending = live.filter((entry) => live.some((other) =>
        other.agentId !== entry.agentId && !related(this.agent(entry.agentId), this.agent(other.agentId))));
      if (contending.length < 2) return [];
      return [{
        path: file.path,
        agents: contending.sort((a, b) => b.lastAt - a.lastAt).map(({ agentId, lastAt }) => ({ agentId, lastAt })),
        since: Math.min(...contending.map((entry) => entry.firstAt)),
      }];
    }).sort((a, b) => b.agents[0].lastAt - a.agents[0].lastAt);
  }

  forget(agentId: string): void {
    this.files = new Map([...this.files].map(([key, file]): [string, FileRecord] =>
      [key, { ...file, touches: new Map([...file.touches].filter(([id]) => id !== agentId)) }]));
  }

  private isLive(agentId: string): boolean {
    const agent = this.agent(agentId);
    return agent !== undefined && agent.status !== 'stopped';
  }

  private record(agentId: string, raw: string, cwd: string | undefined, ts: number): void {
    const key = fileKey(raw, cwd);
    const path = absolutePath(raw, cwd);
    if (!key || !path) return;
    const file = this.files.get(key) ?? { path, touches: new Map<string, Touch>() };
    const previous = file.touches.get(agentId);
    const touches = new Map(file.touches).set(agentId, { firstAt: previous?.firstAt ?? ts, lastAt: Math.max(previous?.lastAt ?? ts, ts) });
    this.files.set(key, { ...file, touches });
  }

  private prune(now: number): void {
    const fresh = [...this.files].flatMap(([key, file]): Array<[string, FileRecord]> => {
      const touches = new Map([...file.touches].filter(([, touch]) => now - touch.lastAt < this.windowMs));
      return touches.size ? [[key, { ...file, touches }]] : [];
    });
    this.files = new Map(fresh);
  }
}

function signatureOf(list: readonly FileContention[]): string {
  return list.map((entry) => `${entry.path}:${entry.agents.map((agent) => agent.agentId).sort().join(',')}`).sort().join('|');
}
