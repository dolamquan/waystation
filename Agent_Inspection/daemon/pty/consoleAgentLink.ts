import { isPidAlive } from '../collectors/claudeSessions.ts';
import type { ConsoleInfo, ConsoleKind } from './types.ts';

/** Deepest process ancestry walked; also stops a parent cycle from looping. */
const MAX_ANCESTORS = 64;
const DEFAULT_THROTTLE_MS = 1500;
/** A process table read (a powershell.exe spawn) is reused this long. */
const DEFAULT_TABLE_TTL_MS = 5000;
/** Clock slack between a console's recorded createdAt and its agent's process start time. */
const START_SKEW_MS = 2000;

/** Agents whose source says they run in an editor never run in a board console. */
const EDITOR_SOURCE = /vscode|cursor|windsurf|editor/i;

export interface LinkAgent {
  readonly id: string;
  readonly vendor: string;
  readonly pid?: number;
  readonly parentId?: string;
  /** Folder and start time (epoch ms): enough to place an agent whose process id is unknown. */
  readonly cwd?: string;
  readonly startedAt?: number;
  /** When a process last opened the session (Codex thread lock): places a thread resumed inside a console. */
  readonly openedAt?: number;
  /** Last conversation activity (epoch ms): the weakest hint for a resumed thread, which started long before its console. */
  readonly lastEventAt?: number;
  readonly source?: string;
}

export interface LinkConsole {
  readonly id: string;
  readonly kind: ConsoleKind;
  /** The console's pseudo-terminal process id. */
  readonly ptyPid: number;
  /** When the console was created; an agent that started before it cannot be running inside it. */
  readonly createdAt?: number;
  /** When the console's current process was spawned (later than createdAt for a restored console). */
  readonly launchedAt?: number;
  readonly cwd?: string;
}

const samePath = (a: string, b: string): boolean => {
  const norm = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
};

/**
 * When the console's current process started. A restored console keeps its original createdAt but runs a new
 * process; nothing older than that process can have been started or opened by it.
 */
const launchOf = (console: LinkConsole): number | undefined => console.launchedAt ?? console.createdAt;

/**
 * Assigns each agent (in the given order) to a free console of its vendor, in its folder, whose process was
 * already running at `at(agent)`: the one launched most recently before then, i.e. the closest fit.
 */
function placeByFolder(
  links: Map<string, string>, agents: readonly LinkAgent[], consoles: readonly LinkConsole[], at: (agent: LinkAgent) => number | undefined,
): void {
  const taken = new Set(links.values());
  for (const agent of agents) {
    const when = at(agent);
    if (taken.has(agent.id) || when === undefined) continue;
    const match = consoles
      .filter((console) => {
        const launched = launchOf(console);
        return console.kind === agent.vendor && !links.has(console.id) && console.cwd !== undefined && launched !== undefined
          && samePath(console.cwd, agent.cwd!) && launched - START_SKEW_MS <= when;
      })
      .sort((a, b) => launchOf(b)! - launchOf(a)!)[0];
    if (match) {
      links.set(match.id, agent.id);
      taken.add(agent.id);
    }
  }
}

/**
 * Links by folder and time, for agents with no process to trace (Codex rollout threads), and as a quick
 * first guess while the process table is read. Existing links are kept. Three passes, most certain first:
 * 1. A thread that started after a console's process launched began in that console.
 * 2. A thread opened (Codex thread lock created) after a console launched was resumed in it: `codex resume`
 *    typed there, `/resume` inside Codex, or a restored console. Its own start time is far older.
 * 3. Failing both, a pid-less thread active since a console launched is most likely the one running in it.
 */
export function guessLinks(
  agents: readonly LinkAgent[], consoles: readonly LinkConsole[], existing: ReadonlyMap<string, string>,
): Map<string, string> {
  const links = new Map(existing);
  const eligible = agents.filter((agent) => agent.parentId === undefined && agent.cwd !== undefined
    && agent.startedAt !== undefined && !EDITOR_SOURCE.test(agent.source ?? ''));
  const pidless = eligible.filter((agent) => agent.pid === undefined);
  const ascending = (key: (agent: LinkAgent) => number | undefined) => (list: readonly LinkAgent[]) =>
    [...list].sort((a, b) => (key(a) ?? 0) - (key(b) ?? 0));
  placeByFolder(links, ascending((a) => a.startedAt)(eligible), consoles, (agent) => agent.startedAt);
  placeByFolder(links, ascending((a) => a.openedAt)(pidless), consoles, (agent) => agent.openedAt);
  placeByFolder(links, ascending((a) => a.lastEventAt)(pidless).reverse(), consoles, (agent) => agent.lastEventAt);
  return links;
}

/** One row of the process table. `startedAt` (epoch ms) is absent when the platform does not report it. */
export interface LinkProc {
  readonly pid: number;
  readonly ppid: number;
  readonly startedAt?: number;
}

/**
 * Which registry agent runs inside which console: the agent whose process has the console's pseudo-terminal
 * as an ancestor (and, when start times are known, that started no earlier than the console).
 * Only Claude Code and Codex consoles link, and only to an agent of the same vendor.
 * Returns console id -> agent id; a top-level agent wins over its sub-agents.
 */
export function computeLinks(
  agents: readonly LinkAgent[], consoles: readonly LinkConsole[], parents: ReadonlyMap<number, number>,
  startedAt: ReadonlyMap<number, number> = new Map(),
): Map<string, string> {
  const byPid = new Map<number, LinkConsole>();
  for (const console of consoles) if (console.kind !== 'shell') byPid.set(console.ptyPid, console);
  const links = new Map<string, string>();
  const ranked = [...agents].sort((a, b) => Number(a.parentId !== undefined) - Number(b.parentId !== undefined));
  for (const agent of ranked) {
    if (agent.pid === undefined) continue;
    let current: number | undefined = agent.pid;
    for (let depth = 0; current !== undefined && depth < MAX_ANCESTORS; depth += 1) {
      const owner = byPid.get(current);
      if (owner) {
        const started = startedAt.get(agent.pid);
        // PID reuse guard: a process older than the console cannot be running in it. Skipped when unknown.
        const predates = started !== undefined && owner.createdAt !== undefined && started < owner.createdAt - START_SKEW_MS;
        if (owner.kind === agent.vendor && !links.has(owner.id) && !predates) links.set(owner.id, agent.id);
        break;
      }
      current = parents.get(current);
    }
  }
  return links;
}

/** The slice of PtyManager the linker needs, so tests can supply a fake. */
export interface LinkConsoles {
  list(): ConsoleInfo[];
  pidOf(id: string): number | undefined;
  setAgentId(id: string, agentId: string | undefined): void;
}

export interface ConsoleAgentLinkerDeps {
  readonly agents: () => readonly LinkAgent[];
  readonly consoles: LinkConsoles;
  /** The process table; may reject when it cannot be read. Costs a process spawn, so the linker caches it. */
  readonly processes: () => Promise<readonly LinkProc[]>;
  readonly throttleMs?: number;
  readonly tableTtlMs?: number;
  readonly now?: () => number;
  readonly isAlive?: (pid: number) => boolean;
}

/**
 * Keeps `agentId` on consoles up to date. It only ever clears links it made itself: a console that was
 * linked directly (opened for a known agent) keeps that link. Never throws.
 */
export class ConsoleAgentLinker {
  private readonly autoLinked = new Set<string>();
  private readonly reported = new Set<string>();
  private table: { readonly at: number; readonly rows: readonly LinkProc[]; readonly checkedPids: ReadonlySet<number> } | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private applying = false;

  constructor(private readonly deps: ConsoleAgentLinkerDeps) {}

  /** Asks for a re-link soon; calls close together share one run. */
  request(): void {
    if (this.stopped || this.applying) return;
    if (this.running) {
      this.again = true;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, this.deps.throttleMs ?? DEFAULT_THROTTLE_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One linking pass. Overlapping calls join the pass in flight. */
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // A board snapshot must include changes that arrived during a slow process scan too.
    // Drain them before resolving, rather than publishing an unlinked agent until the next timer.
    this.running = (async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again && !this.stopped);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async pass(): Promise<void> {
    try {
      const { consoles } = this.deps;
      const all = consoles.list();
      const direct = all.filter((info) => info.agentId !== undefined && !this.autoLinked.has(info.id));
      const taken = new Set(direct.map((info) => info.agentId));
      const candidates: LinkConsole[] = [];
      for (const info of all) {
        if (info.kind === 'shell' || info.state !== 'running' || direct.includes(info)) continue;
        const ptyPid = consoles.pidOf(info.id);
        if (ptyPid !== undefined) candidates.push({ id: info.id, kind: info.kind, ptyPid, createdAt: info.createdAt, launchedAt: info.launchedAt, cwd: info.cwd });
      }
      const snapshot = () => new Map(consoles.list().map((info) => [info.id, info.agentId] as const));
      let current = new Map(all.map((info) => [info.id, info.agentId] as const));
      let links = new Map<string, string>();
      if (candidates.length > 0) {
        const agents = this.deps.agents().filter((agent) => !taken.has(agent.id));
        const kept = this.keptLinks(candidates, current);
        if (this.needsScan(candidates, agents, current)) {
          // Reading the process table takes seconds; until then the board would show the new agent twice.
          this.apply(guessLinks(agents, candidates, kept), current);
          links = await this.scanLinks(agents, candidates);
          current = snapshot();
        } else {
          links = kept;
        }
        // Agents with no process id (Codex threads) can only ever be placed by folder and time.
        links = guessLinks(agents.filter((agent) => agent.pid === undefined), candidates, links);
      }
      this.apply(links, current);
    } catch (error) {
      // No process table (non-Windows, PowerShell blocked) or a bug: existing links stay; say so once.
      this.report(error);
    }
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.reported.has(message)) return;
    this.reported.add(message);
    console.error('[console-link] linking failed:', message);
  }

  /** A scan is only worth a process spawn when a console could gain an agent, or a linked agent went away. */
  private needsScan(
    candidates: readonly LinkConsole[], agents: readonly LinkAgent[], current: ReadonlyMap<string, string | undefined>,
  ): boolean {
    const isAlive = this.deps.isAlive ?? isPidAlive;
    const byId = new Map(agents.map((agent) => [agent.id, agent] as const));
    const linkedAgents = new Set<string>();
    for (const console of candidates) {
      if (!this.autoLinked.has(console.id)) continue;
      const agentId = current.get(console.id);
      const agent = agentId === undefined ? undefined : byId.get(agentId);
      // A pid-less agent was linked by folder and time; it stays linked while it is listed.
      if (!agent || (agent.pid !== undefined && !isAlive(agent.pid))) return true;
      linkedAgents.add(agent.id);
    }
    return candidates.some((console) => !this.autoLinked.has(console.id)
      && agents.some((agent) => agent.pid !== undefined && agent.vendor === console.kind && !linkedAgents.has(agent.id)));
  }

  /** The links already made, for consoles that are still running. */
  private keptLinks(candidates: readonly LinkConsole[], current: ReadonlyMap<string, string | undefined>): Map<string, string> {
    const kept = new Map<string, string>();
    for (const console of candidates) {
      const agentId = current.get(console.id);
      if (this.autoLinked.has(console.id) && agentId !== undefined) kept.set(console.id, agentId);
    }
    return kept;
  }

  private async scanLinks(agents: readonly LinkAgent[], candidates: readonly LinkConsole[]): Promise<Map<string, string>> {
    const rows = await this.processTable(agents.flatMap(agent => agent.pid === undefined ? [] : [agent.pid]));
    const parents = new Map(rows.map((row) => [row.pid, row.ppid] as const));
    const startedAt = new Map(rows.flatMap((row) => (row.startedAt === undefined ? [] : [[row.pid, row.startedAt] as const])));
    return computeLinks(agents, candidates, parents, startedAt);
  }

  private async processTable(pids: readonly number[]): Promise<readonly LinkProc[]> {
    const now = (this.deps.now ?? Date.now)();
    // A new process may have started after the cached scan. Check it once immediately, even within the TTL.
    const known = this.table && new Set([...this.table.rows.map(row => row.pid), ...this.table.checkedPids]);
    if (this.table && now - this.table.at < (this.deps.tableTtlMs ?? DEFAULT_TABLE_TTL_MS)
      && pids.every(pid => known!.has(pid))) return this.table.rows;
    const rows = await this.deps.processes();
    this.table = { at: now, rows, checkedPids: new Set(pids) };
    return rows;
  }

  private apply(links: ReadonlyMap<string, string>, current: ReadonlyMap<string, string | undefined>): void {
    const { consoles } = this.deps;
    // Our own console updates emit 'changed' too; they do not require another discovery pass.
    this.applying = true;
    try {
      for (const id of [...this.autoLinked]) {
        if (links.has(id)) continue;
        this.autoLinked.delete(id);
        if (current.get(id) !== undefined) consoles.setAgentId(id, undefined);
      }
      for (const [id, agentId] of links) {
        this.autoLinked.add(id);
        if (current.get(id) !== agentId) consoles.setAgentId(id, agentId);
      }
    } finally { this.applying = false; }
  }
}
