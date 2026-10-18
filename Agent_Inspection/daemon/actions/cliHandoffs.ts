import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPidAlive } from '../collectors/claudeSessions.ts';

/**
 * Sessions handed to the operator's terminal. The daemon writes a one-time ticket (command, folder and
 * secret environment) into its private folder; the launcher in the new tab consumes it, reports its pid,
 * and reports again when the CLI exits. A closed tab is noticed from the launcher's pid disappearing.
 */

export interface CliSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface CliTicket extends CliSpec {
  readonly handoffId: string;
  readonly expiresAt: number;
}

export class TicketError extends Error {}

const TICKET_ID = /^[0-9a-f]{32}$/;
const SIDECAR_NAME = /^[a-z][a-z0-9.-]{0,31}$/;
const TICKET_TTL_MS = 2 * 60_000;
/**
 * A session that never reported can be forgotten once its ticket has expired: the launcher only starts
 * the CLI after the tower confirms it, so nothing is running for it.
 */
const DEFAULT_START_TIMEOUT_MS = TICKET_TTL_MS;
const SWEEP_EVERY_MS = 3000;

export const isTicketId = (id: string): boolean => TICKET_ID.test(id);

function ticketPath(dir: string, id: string): string {
  if (!isTicketId(id)) throw new TicketError('That is not a valid ticket id.');
  return join(dir, `${id}.json`);
}

/** Read and delete a ticket. A ticket works once, and only for a short while. */
export function takeTicket(dir: string, id: string, now: number = Date.now()): CliTicket {
  const file = ticketPath(dir, id);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new TicketError('This ticket was not found or was already used. Open the session again from Waystation.');
  }
  rmSync(file, { force: true });
  const ticket = JSON.parse(raw) as CliTicket;
  if (ticket.expiresAt < now) throw new TicketError('This ticket has expired. Open the session again from Waystation.');
  return ticket;
}

interface Entry {
  readonly id: string;
  readonly label: string;
  readonly createdAt: number;
  /** The launcher and, once started, the CLI itself. The session is over only when all of them are gone. */
  readonly pids: readonly number[];
  readonly sidecars: readonly string[];
  readonly onEnd: () => void;
}

/** Builds the spec, given where its private files (e.g. an MCP config holding a token) will be written. */
type SpecSource = CliSpec | ((sidecarPath: (name: string) => string) => CliSpec);

export interface CliHandoffsOptions {
  readonly ticketsDir: string;
  readonly now?: () => number;
  readonly isAlive?: (pid: number) => boolean;
  readonly startTimeoutMs?: number;
}

export class CliHandoffs {
  private entries = new Map<string, Entry>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: CliHandoffsOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * Write a ticket (and any private sidecar files the CLI reads, such as an MCP config holding a token)
   * into the tower's private folder. Everything is deleted when the session ends.
   */
  create(source: SpecSource, meta: { readonly label: string }, onEnd: () => void, sidecars: Readonly<Record<string, string>> = {}): string {
    const dir = this.opts.ticketsDir;
    mkdirSync(dir, { recursive: true });
    const id = randomBytes(16).toString('hex');
    const sidecarPath = (name: string) => {
      if (!SIDECAR_NAME.test(name)) throw new TicketError(`bad sidecar name: ${name}`);
      return join(dir, `${id}.${name}`);
    };
    const spec = typeof source === 'function' ? source(sidecarPath) : source;
    const files = Object.entries(sidecars).map(([name, content]) => {
      const path = sidecarPath(name);
      writeFileSync(path, content, { mode: 0o600 });
      return path;
    });
    const ticket: CliTicket = { ...spec, handoffId: id, expiresAt: this.now() + TICKET_TTL_MS };
    writeFileSync(ticketPath(dir, id), JSON.stringify(ticket), { mode: 0o600 });
    this.entries = new Map([...this.entries, [id, { id, label: meta.label, createdAt: this.now(), pids: [], sidecars: files, onEnd }]]);
    return id;
  }

  /** The launcher (and then the CLI it started) report their pids. False if the session is unknown or over. */
  started(id: string, pid: number): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries = new Map([...this.entries, [id, { ...entry, pids: [...entry.pids, pid] }]]);
    return true;
  }

  /** The CLI closed: run its clean-up exactly once. */
  ended(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.remove(id);
    try {
      entry.onEnd();
    } catch (error) {
      console.error('[tower] ending a CLI session failed:', error);
    }
  }

  /** Forget a session that never opened (the terminal failed to start), without its clean-up. */
  discard(id: string): void {
    this.remove(id);
  }

  endLabel(label: string): void {
    this.endWhere((candidate) => candidate === label);
  }

  endWhere(matches: (label: string) => boolean): void {
    for (const entry of [...this.entries.values()]) if (matches(entry.label)) this.ended(entry.id);
  }

  has(label: string): boolean {
    return [...this.entries.values()].some((entry) => entry.label === label);
  }

  /** The open session with this label: its ticket id and reported pids (the launcher first, then the CLI). */
  find(label: string): { readonly id: string; readonly pids: readonly number[] } | undefined {
    const entry = [...this.entries.values()].find((candidate) => candidate.label === label);
    return entry ? { id: entry.id, pids: entry.pids } : undefined;
  }

  sweep(): void {
    const isAlive = this.opts.isAlive ?? isPidAlive;
    const startTimeout = this.opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    for (const entry of [...this.entries.values()]) {
      const gone = entry.pids.length > 0 ? entry.pids.every((pid) => !isAlive(pid)) : this.now() - entry.createdAt > startTimeout;
      if (gone) this.ended(entry.id);
    }
  }

  start(): void {
    this.removeStaleFiles();
    this.timer = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Tickets and sidecars (they can hold secrets) left behind by a daemon that crashed or was killed. */
  private removeStaleFiles(): void {
    const dir = this.opts.ticketsDir;
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      try {
        if (this.now() - statSync(file).mtimeMs > TICKET_TTL_MS) rmSync(file, { force: true, recursive: true });
      } catch (error) {
        console.error('[cli] could not remove stale ticket file:', (error as Error).message);
      }
    }
  }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    this.entries = new Map([...this.entries].filter(([key]) => key !== id));
    for (const file of [ticketPath(this.opts.ticketsDir, id), ...(entry?.sidecars ?? [])]) rmSync(file, { force: true });
  }
}
