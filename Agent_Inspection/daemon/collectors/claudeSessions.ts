import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudePaths, timings } from '../config.ts';
import type { Agent, AgentEvent, AgentStatus } from '../domain/types.ts';
import type { AgentRegistry } from '../domain/registry.ts';
import { projectName } from '../domain/text.ts';
import { JsonlTailer } from './jsonlTail.ts';
import { normalizeClaudeLine } from './normalizers.ts';

export const CLAUDE_SOURCE = 'claude-sessions';

export interface ClaudeSessionFile {
  readonly pid: number;
  readonly sessionId: string;
  readonly cwd?: string;
  readonly status?: string;
  readonly kind?: string;
  readonly entrypoint?: string;
  readonly name?: string;
  readonly startedAt?: number;
  readonly updatedAt?: number;
  readonly procStart?: string;
}

export function parseClaudeSessionFile(text: string): ClaudeSessionFile | undefined {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw.pid !== 'number' || typeof raw.sessionId !== 'string') return undefined;
    const str = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined);
    const num = (key: string) => (typeof raw[key] === 'number' ? (raw[key] as number) : undefined);
    return {
      pid: raw.pid,
      sessionId: raw.sessionId,
      cwd: str('cwd'),
      status: str('status'),
      kind: str('kind'),
      entrypoint: str('entrypoint'),
      name: str('name'),
      startedAt: num('startedAt'),
      updatedAt: num('updatedAt'),
      procStart: str('procStart'),
    };
  } catch {
    return undefined;
  }
}

/** Claude Code stores transcripts under a slug of the cwd with every non-alphanumeric replaced by '-'. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ClaudeCollectorDeps {
  readonly registry: AgentRegistry;
  readonly hooksInstalled: () => boolean;
  readonly isIntercepting: (sessionId: string) => boolean;
  readonly isAlive?: (pid: number) => boolean;
  /** Sessions driven by a tower-managed runner are listed by that runner instead. */
  readonly isManagedSession?: (sessionId: string) => boolean;
  readonly sessionsDir?: string;
  readonly projectsDir?: string;
}

interface SessionState {
  readonly tailer: JsonlTailer;
  title?: string;
  activity?: string;
  lastEventAt?: number;
}

export class ClaudeSessionsCollector {
  private lastGood = new Map<string, ClaudeSessionFile>();
  private sessions = new Map<string, SessionState>();
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;

  constructor(private readonly deps: ClaudeCollectorDeps) {}

  start(): void {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), timings.claudeRegistryPollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Session-file record for a live Claude session; used by the kill guard. */
  sessionFileFor(sessionId: string): ClaudeSessionFile | undefined {
    return [...this.lastGood.values()].find((file) => file.sessionId === sessionId);
  }

  /** Live activity reported by the hook bridge (preferred over transcript tailing for tool calls). */
  noteActivity(sessionId: string, event: AgentEvent): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (event.kind !== 'status' && event.kind !== 'system') state.activity = event.summary;
    state.lastEventAt = event.ts;
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const files = await this.readSessionFiles();
      const isAlive = this.deps.isAlive ?? isPidAlive;
      const isManaged = this.deps.isManagedSession ?? (() => false);
      const live = files.filter((file) => isAlive(file.pid) && !isManaged(file.sessionId));
      await Promise.all(live.map((file) => this.refreshTranscript(file)));
      const liveIds = new Set(live.map((file) => file.sessionId));
      this.sessions = new Map([...this.sessions].filter(([id]) => liveIds.has(id)));
      this.deps.registry.replaceSource(CLAUDE_SOURCE, live.map((file) => this.toAgent(file)));
    } catch (error) {
      console.error('[claude-sessions] scan failed:', (error as Error).message);
    } finally {
      this.scanning = false;
    }
  }

  private async readSessionFiles(): Promise<ClaudeSessionFile[]> {
    const dir = this.deps.sessionsDir ?? claudePaths.sessions;
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    const results = await Promise.all(names.map(async (name) => {
      const path = join(dir, name);
      const parsed = await readFile(path, 'utf8').then(parseClaudeSessionFile, () => undefined);
      // Files are rewritten frequently; a half-written read falls back to the last good parse.
      const value = parsed ?? this.lastGood.get(path);
      if (parsed) this.lastGood.set(path, parsed);
      return value;
    }));
    const present = new Set(names.map((name) => join(dir, name)));
    this.lastGood = new Map([...this.lastGood].filter(([path]) => present.has(path)));
    return results.filter((file): file is ClaudeSessionFile => file !== undefined);
  }

  private async refreshTranscript(file: ClaudeSessionFile): Promise<void> {
    if (!file.cwd) return;
    const agentId = `claude:${file.sessionId}`;
    let state = this.sessions.get(file.sessionId);
    if (!state) {
      const projectsDir = this.deps.projectsDir ?? claudePaths.projects;
      const transcript = join(projectsDir, claudeProjectSlug(file.cwd), `${file.sessionId}.jsonl`);
      state = { tailer: new JsonlTailer(transcript) };
      this.sessions.set(file.sessionId, state);
    }
    const hooked = this.deps.hooksInstalled();
    for (const line of await state.tailer.readNew()) {
      const { events, title } = normalizeClaudeLine(agentId, line);
      if (title) state.title = title;
      for (const event of events) {
        // With hooks installed, tool calls arrive live from the hook bridge instead.
        if (hooked && event.kind === 'tool_call') continue;
        state.activity = event.summary;
        state.lastEventAt = event.ts;
        this.deps.registry.pushEvent(event);
      }
    }
  }

  private toAgent(file: ClaudeSessionFile): Agent {
    const state = this.sessions.get(file.sessionId);
    const hooked = this.deps.hooksInstalled();
    const status: AgentStatus = file.status === 'busy' ? 'busy' : file.status === 'idle' ? 'idle' : 'unknown';
    const where = file.entrypoint?.includes('vscode') ? 'VS Code' : file.entrypoint ?? 'terminal';
    return {
      id: `claude:${file.sessionId}`,
      vendor: 'claude',
      tier: 'B',
      name: state?.title ?? file.name ?? `Claude ${file.sessionId.slice(0, 8)}`,
      sessionId: file.sessionId,
      pid: file.pid,
      cwd: file.cwd,
      project: projectName(file.cwd),
      status,
      source: `Claude Code · ${where}`,
      currentActivity: state?.activity,
      startedAt: file.startedAt,
      lastEventAt: Math.max(state?.lastEventAt ?? 0, file.updatedAt ?? 0) || undefined,
      hooked,
      intercepting: hooked && this.deps.isIntercepting(file.sessionId),
      canInstruct: hooked,
    };
  }
}
