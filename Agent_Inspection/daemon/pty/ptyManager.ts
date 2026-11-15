import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  ConsoleInputError, SESSION_ID, isConsoleKind,
  type ConsoleAttention, type ConsoleInfo, type ConsoleKind, type ConsoleServerMessage, type PtyHandle, type PtySpawn, type SavedConsoleSpec,
} from './types.ts';
import type { ConsoleStore } from './consoleStore.ts';

/** Running consoles at once; each one is a live process. */
export const MAX_RUNNING_CONSOLES = 12;
/** Output kept per console so a reloaded page can repaint the screen. */
export const SCROLLBACK_CHARS = 200_000;
export const DEFAULT_COLS = 100;
export const DEFAULT_ROWS = 30;
const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 5;
const MAX_ROWS = 200;
const MAX_NAME_CHARS = 60;
const MAX_INPUT_CHARS = 64 * 1024;
/** Variables the daemon uses to talk to its own agents; a console never inherits them. */
const PRIVATE_ENV_PREFIXES = ['WAYSTATION_', 'AGENT_TOWER_'];
const UNC_PATH = /^[\\/]{2}/;
const KIND_LABEL: Readonly<Record<ConsoleKind, string>> = { claude: 'Claude Code', codex: 'Codex', shell: 'Shell' };

/** Fixed text for bringing a saved console back; never built from anything the operator typed. */
const RESUME_LATEST: Readonly<Record<ConsoleKind, string>> = { claude: 'claude --continue', codex: 'codex resume --last', shell: '' };

/** Resumes one known session. The id is checked against SESSION_ID (hex and dashes), so it cannot carry shell syntax. */
function resumeSession(kind: ConsoleKind, sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new ConsoleInputError('That saved session id is not valid.');
  if (kind === 'claude') return `claude --resume ${sessionId}`;
  if (kind === 'codex') return `codex resume ${sessionId}`;
  return '';
}

/**
 * How a console starts: fresh (false), continuing the folder's latest session (true), or resuming one session (its id).
 * "Latest" is only safe for a console with no sibling of its kind in the same folder: otherwise each would continue
 * the same conversation and the board would show it several times.
 */
export type ResumeMode = boolean | string;

export interface CommandLine {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * Fixed command lines. The console's kind picks one of three known commands, so nothing the operator types
 * ever becomes part of the launch. The shell stays open if the agent CLI exits or is not installed.
 */
export function commandLineFor(kind: ConsoleKind, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, resume: ResumeMode = false): CommandLine {
  // A shell has nothing to continue.
  const command = typeof resume === 'string' ? resumeSession(kind, resume) : resume ? RESUME_LATEST[kind] : kind;
  if (platform === 'win32') {
    return { file: 'powershell.exe', args: kind === 'shell' ? ['-NoLogo'] : ['-NoLogo', '-NoExit', '-Command', command] };
  }
  const shell = env.SHELL || '/bin/bash';
  return { file: shell, args: kind === 'shell' ? [] : ['-c', `${command}; exec "${shell}"`] };
}

export function consoleEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    // Windows treats variable names case-insensitively, so the prefix match must too.
    if (typeof value !== 'string' || PRIVATE_ENV_PREFIXES.some((prefix) => key.toUpperCase().startsWith(prefix))) continue;
    env[key] = value;
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

interface Entry {
  info: ConsoleInfo;
  readonly handle: PtyHandle;
  scrollback: string;
  readonly listeners: Set<(message: ConsoleServerMessage) => void>;
  /** False for consoles started from a one-time launcher ticket: restoring them later would run a stale ticket. */
  readonly restorable: boolean;
  readonly onExit?: (() => void) | undefined;
  /** The session last seen running here (from the linked agent, or the one it was restored into); saved for restore. */
  sessionId?: string;
}

/** `claude:<id>` / `codex:<id>` agents are sessions of that CLI; returns the id when it belongs to a console of `kind`. */
export function sessionOfAgent(kind: ConsoleKind, agentId: string | undefined): string | undefined {
  if (!agentId || kind === 'shell' || !agentId.startsWith(`${kind}:`)) return undefined;
  const id = agentId.slice(kind.length + 1);
  return SESSION_ID.test(id) ? id : undefined;
}

const sameFolder = (a: string, b: string): boolean => {
  const norm = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
};

/**
 * A fixed command the daemon itself decided to run in a console (never request text). The environment is
 * always `consoleEnv()`: secrets belong in the launcher's ticket file, not here.
 */
export interface CommandConsole {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly name: string;
  readonly kind: ConsoleKind;
  /** The registry agent whose session this console runs, when the daemon already knows it. */
  readonly agentId?: string;
  /** Runs once when the process ends (including when the console is closed). */
  readonly onExit?: () => void;
}

/** Launch parameters shared by the public (kind-based) and the internal (command-based) creation paths. */
interface Launch {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly name: string | undefined;
  readonly kind: ConsoleKind;
  readonly cols: number;
  readonly rows: number;
  readonly agentId?: string;
  readonly restorable: boolean;
  readonly onExit?: () => void;
  /** The session this launch resumes, when it resumes a known one. */
  readonly sessionId?: string;
}

export interface CreateConsole {
  readonly kind: ConsoleKind;
  readonly cwd: string;
  readonly name: string | undefined;
  readonly cols: number;
  readonly rows: number;
}

/** Checks the request body for a new console. Throws ConsoleInputError with a message fit to show the operator. */
export function validateCreate(raw: unknown): CreateConsole {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!isConsoleKind(body.kind)) throw new ConsoleInputError('kind must be claude, codex or shell.');
  if (typeof body.cwd !== 'string' || !isAbsolute(body.cwd)) throw new ConsoleInputError('cwd must be an absolute path.');
  // A \\server\share path would make the daemon open a network connection just to check the folder.
  if (UNC_PATH.test(body.cwd)) throw new ConsoleInputError('Network folders are not supported. Use a folder on this machine.');
  if (!existsSync(body.cwd) || !statSync(body.cwd).isDirectory()) throw new ConsoleInputError(`Folder not found: ${body.cwd}`);
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, MAX_NAME_CHARS) : undefined;
  return {
    kind: body.kind,
    cwd: body.cwd,
    name,
    cols: clamp(body.cols, MIN_COLS, MAX_COLS, DEFAULT_COLS),
    rows: clamp(body.rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS),
  };
}

/** Owns every console: real pseudo-terminals running the agent CLIs (or a shell) that the board shows. */
export class PtyManager extends EventEmitter {
  private readonly entries = new Map<string, Entry>();
  private sequence = 0;
  /** Consoles whose process is still starting; they count against the cap before they are listed. */
  private starting = 0;
  private closed = false;

  /** Specs from the previous run, offered to the operator but never launched on their own. */
  private readonly saved = new Map<string, SavedConsoleSpec>();

  constructor(private readonly spawn: PtySpawn, private readonly now: () => number = Date.now, private readonly store?: ConsoleStore) {
    super();
    for (const spec of store?.load() ?? []) this.saved.set(spec.id, spec);
  }

  list(): ConsoleInfo[] {
    return [...this.entries.values()].map((entry) => entry.info);
  }

  get(id: string): ConsoleInfo | undefined {
    return this.entries.get(id)?.info;
  }

  create(raw: unknown): Promise<ConsoleInfo> {
    return this.launch(validateCreate(raw), undefined);
  }

  /**
   * Internal creation path for a command the daemon chose (the CLI launcher for an agent's ticket). Not
   * reachable from request bodies. Same env filter, cap, scrollback and subscribers as any console, but it
   * is never saved for restore.
   */
  async createFromCommand(command: CommandConsole): Promise<ConsoleInfo> {
    const { cwd } = command;
    if (!isAbsolute(cwd) || UNC_PATH.test(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new ConsoleInputError(`Folder not found: ${cwd}`);
    }
    return await this.start({
      file: command.file, args: command.args, cwd, kind: command.kind, agentId: command.agentId,
      name: command.name.trim().slice(0, MAX_NAME_CHARS) || undefined,
      cols: DEFAULT_COLS, rows: DEFAULT_ROWS, restorable: false, onExit: command.onExit,
    }, undefined);
  }

  /** Consoles remembered from an earlier run that have not been brought back or discarded. */
  savedSpecs(): SavedConsoleSpec[] {
    return [...this.saved.values()];
  }

  /** Launches a saved console again, resuming its last session where the CLI supports it. */
  async restore(id: string): Promise<ConsoleInfo> {
    const spec = this.saved.get(id);
    if (!spec) throw new ConsoleInputError('That saved console is no longer available.');
    const request = validateCreate({ kind: spec.kind, cwd: spec.cwd, name: spec.name });
    // Taken out first so a double click cannot launch it twice; put back if the launch fails.
    this.saved.delete(id);
    try {
      return await this.launch(request, spec);
    } catch (error) {
      if (!this.closed) {
        this.saved.set(id, spec);
        this.persist();
      }
      throw error;
    }
  }

  /** Forgets a saved console without launching it. */
  discard(id: string): boolean {
    if (!this.saved.delete(id)) return false;
    this.persist();
    return true;
  }

  private launch(request: CreateConsole, saved: SavedConsoleSpec | undefined): Promise<ConsoleInfo> {
    const resume = saved ? this.resumeModeFor(saved) : false;
    const { file, args } = commandLineFor(request.kind, process.platform, process.env, resume);
    return this.start({ ...request, file, args, restorable: true, ...(typeof resume === 'string' ? { sessionId: resume } : {}) }, saved);
  }

  /**
   * A saved console reopens its own session. One saved before session ids were recorded may continue the folder's
   * latest session only when no other console of its kind shares that folder; otherwise it starts fresh, because
   * every one of them would continue the same conversation.
   */
  private resumeModeFor(saved: SavedConsoleSpec): ResumeMode {
    if (saved.sessionId) return saved.sessionId;
    const siblings = [...this.saved.values(), ...[...this.entries.values()].map((entry) => entry.info)]
      .filter((other) => other.id !== saved.id && other.kind === saved.kind && sameFolder(other.cwd, saved.cwd));
    return siblings.length === 0;
  }

  private async start(request: Launch, saved: SavedConsoleSpec | undefined): Promise<ConsoleInfo> {
    if (this.closed) throw new ConsoleInputError('Waystation is shutting down.');
    const running = this.list().filter((info) => info.state === 'running').length;
    if (running + this.starting >= MAX_RUNNING_CONSOLES) throw new ConsoleInputError(`At most ${MAX_RUNNING_CONSOLES} consoles can run at once. Close one first.`);
    const { file, args } = request;
    this.starting += 1;
    let handle: PtyHandle;
    try {
      handle = await this.spawn(file, args, { cwd: request.cwd, cols: request.cols, rows: request.rows, env: consoleEnv() });
    } finally {
      this.starting -= 1;
    }
    if (this.closed) {
      handle.kill();
      throw new ConsoleInputError('Waystation is shutting down.');
    }
    this.sequence += 1;
    const createdAt = saved?.createdAt ?? this.now();
    const entry: Entry = {
      info: {
        // A restored console keeps its id, so the board and the saved list never disagree about who it is.
        id: saved?.id ?? randomUUID(),
        name: request.name ?? `${KIND_LABEL[request.kind]} ${this.sequence}`,
        kind: request.kind,
        cwd: request.cwd,
        state: 'running',
        createdAt,
        launchedAt: this.now(),
        lastOutputAt: this.now(),
        ...(request.agentId ? { agentId: request.agentId } : {}),
      },
      handle,
      scrollback: '',
      listeners: new Set(),
      restorable: request.restorable,
      onExit: request.onExit,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    };
    this.entries.set(entry.info.id, entry);
    handle.onData((data) => this.output(entry, data));
    handle.onExit((code) => this.exited(entry, code));
    this.persist();
    this.emit('changed', this.list());
    return entry.info;
  }

  /** Replays what the console has printed so far, then streams new output until `unsubscribe` is called. */
  subscribe(id: string, listener: (message: ConsoleServerMessage) => void): { readonly replay: string; readonly unsubscribe: () => void } | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.listeners.add(listener);
    return { replay: entry.scrollback, unsubscribe: () => { entry.listeners.delete(listener); } };
  }

  write(id: string, data: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.info.state !== 'running' || data.length > MAX_INPUT_CHARS) return;
    entry.handle.write(data);
  }

  resize(id: string, cols: unknown, rows: unknown): void {
    const entry = this.entries.get(id);
    if (!entry || entry.info.state !== 'running') return;
    entry.handle.resize(clamp(cols, MIN_COLS, MAX_COLS, DEFAULT_COLS), clamp(rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS));
  }

  /** What the console has printed (raw, capped at SCROLLBACK_CHARS); a handoff brief quotes its tail. */
  scrollbackOf(id: string): string {
    return this.entries.get(id)?.scrollback ?? '';
  }

  /** The pseudo-terminal's process id while the console runs; hook events are linked to consoles through it. */
  pidOf(id: string): number | undefined {
    const entry = this.entries.get(id);
    return entry?.info.state === 'running' ? entry.handle.pid : undefined;
  }

  /** Records what the console's CLI reported through its hooks (Claude Code only); undefined clears it. */
  setAttention(id: string, value: ConsoleAttention | undefined): void {
    const entry = this.entries.get(id);
    if (!entry || entry.info.kind !== 'claude' || entry.info.state !== 'running' || entry.info.attention === value) return;
    const { attention: _previous, ...rest } = entry.info;
    entry.info = value ? { ...rest, attention: value } : rest;
    this.emit('changed', this.list());
  }

  /** Links the console to the registry agent whose session runs in it (undefined unlinks). Emits only on a real change. */
  setAgentId(id: string, agentId: string | undefined): void {
    const entry = this.entries.get(id);
    if (!entry || entry.info.agentId === agentId) return;
    const { agentId: _previous, ...rest } = entry.info;
    entry.info = agentId ? { ...rest, agentId } : rest;
    // Remember the session for the next restore. An unlink keeps the last one: the CLI may just be between turns.
    const sessionId = sessionOfAgent(entry.info.kind, agentId);
    if (sessionId && sessionId !== entry.sessionId) {
      entry.sessionId = sessionId;
      this.persist();
    }
    this.emit('changed', this.list());
  }

  /** Renames a console (the name shown on its tile and kept for the next start). False when there is no such console. */
  rename(id: string, raw: unknown): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const name = typeof raw === 'string' ? raw.trim().slice(0, MAX_NAME_CHARS) : '';
    if (!name) throw new ConsoleInputError('A console name needs at least one character.');
    if (name === entry.info.name) return true;
    entry.info = { ...entry.info, name };
    this.persist();
    this.emit('changed', this.list());
    return true;
  }

  /** Ends a running console's process. It stays listed, as exited, until dismissed. */
  kill(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.info.state === 'running') entry.handle.kill();
    return true;
  }

  /** Removes a console from the board, ending its process first if it is still running. */
  dismiss(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.info.state === 'running') entry.handle.kill();
    this.release(entry);
    this.entries.delete(id);
    this.persist();
    this.emit('changed', this.list());
    return true;
  }

  /** Ends every process and refuses new consoles, including any still starting. The saved list is kept. */
  shutdown(): void {
    // Written before the processes end: their exits and the clear below must not shrink the saved list.
    this.persist();
    this.closed = true;
    for (const entry of this.entries.values()) {
      if (entry.info.state === 'running') entry.handle.kill();
      this.release(entry);
    }
    this.entries.clear();
  }

  /** Saves what to offer next start: consoles still on the board plus saved ones not yet handled. No output is stored. */
  private persist(): void {
    if (!this.store || this.closed) return;
    const live = [...this.entries.values()].filter((entry) => entry.restorable).map(({ info, sessionId }): SavedConsoleSpec => ({
      id: info.id, name: info.name, kind: info.kind, cwd: info.cwd, createdAt: info.createdAt, ...(sessionId ? { sessionId } : {}),
    }));
    this.store.save([...this.saved.values(), ...live]);
  }

  /** Tells every open terminal view that the console is gone, then forgets them. */
  private release(entry: Entry): void {
    for (const listener of entry.listeners) listener({ type: 'closed' });
    entry.listeners.clear();
  }

  private output(entry: Entry, data: string): void {
    const combined = entry.scrollback + data;
    entry.scrollback = combined.length > SCROLLBACK_CHARS ? combined.slice(combined.length - SCROLLBACK_CHARS) : combined;
    entry.info = { ...entry.info, lastOutputAt: this.now() };
    for (const listener of entry.listeners) listener({ type: 'output', data });
  }

  private exited(entry: Entry, code: number): void {
    if (entry.info.state === 'exited') return;
    entry.info = { ...entry.info, state: 'exited', exitCode: code };
    for (const listener of entry.listeners) listener({ type: 'exit', code });
    if (this.entries.has(entry.info.id)) this.emit('changed', this.list());
    // Shutdown kills every process; their exits must not re-enter callers (e.g. relaunch an agent) while the daemon closes.
    if (this.closed) return;
    try {
      entry.onExit?.();
    } catch (error) {
      console.error('[console] exit handler failed:', (error as Error).message);
    }
  }
}
