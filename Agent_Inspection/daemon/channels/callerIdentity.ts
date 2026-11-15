import type { ProcInfo } from '../collectors/processScanner.ts';
import type { Agent } from '../domain/types.ts';
import { TeamAuthError } from '../teams/teamContext.ts';

/**
 * Which agent session is calling the channel CLI? Agents run `ws-channel` from their own shell, so the
 * session is the nearest agent process up the CLI's parent chain. Managed agents also carry their id in
 * WAYSTATION_AGENT_ID (their processes are not always known by pid).
 *
 * Trust model: every agent runs as the same OS user, so a determined local process could claim another
 * pid. This ties well-behaved agents to their sessions; it is not a boundary against local malware.
 */

/** Subclass of TeamAuthError so the API answers 401, as it does for the other agent bridges. */
export class ChannelAuthError extends TeamAuthError {}

export interface CallerClaim {
  readonly pid?: number;
  readonly ppid?: number;
  readonly agentId?: string;
}

export interface CallerDeps {
  readonly agent: (agentId: string) => Agent | undefined;
  readonly agents: () => readonly Agent[];
  readonly processes: () => Promise<readonly ProcInfo[]>;
  readonly now: () => number;
}

const MAX_ANCESTRY = 16;
const CACHE_TTL_MS = 5 * 60_000;
const SCAN_REUSE_MS = 2_000;
const MAX_AGENT_ID = 200;

const isPid = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

export function parseClaim(raw: unknown): CallerClaim {
  if (!raw || typeof raw !== 'object') return {};
  const fields = raw as Record<string, unknown>;
  const agentId = typeof fields.agentId === 'string' && fields.agentId.length > 0 && fields.agentId.length <= MAX_AGENT_ID
    ? fields.agentId : undefined;
  return {
    ...(isPid(fields.pid) ? { pid: fields.pid } : {}),
    ...(isPid(fields.ppid) ? { ppid: fields.ppid } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

const live = (agent: Agent): boolean => agent.status !== 'stopped' && isPid(agent.pid);

/** The nearest live agent whose process is `pid` or one of its ancestors. */
export function ancestorAgent(pid: number, procs: readonly ProcInfo[], agents: readonly Agent[]): Agent | undefined {
  return ancestry(pid, procs).map((p) => agentAt(p, agents)).find((agent) => agent !== undefined);
}

function ancestry(pid: number, procs: readonly ProcInfo[]): number[] {
  const parentOf = new Map(procs.map((proc) => [proc.pid, proc.ppid] as const));
  const chain: number[] = [];
  let current: number | undefined = pid;
  while (current !== undefined && isPid(current) && !chain.includes(current) && chain.length < MAX_ANCESTRY) {
    chain.push(current);
    current = parentOf.get(current);
  }
  return chain;
}

const agentAt = (pid: number, agents: readonly Agent[]): Agent | undefined =>
  agents.find((agent) => live(agent) && agent.pid === pid);

export class CallerResolver {
  /** Per intermediate pid (the agent's shell, usually): which agent it belongs to, until `expires`. */
  private cache = new Map<number, { agentId: string; expires: number }>();
  private scan: { at: number; procs: Promise<readonly ProcInfo[]> } | undefined;

  constructor(private readonly deps: CallerDeps) {}

  async resolve(claim: CallerClaim): Promise<Agent> {
    if (claim.agentId) return this.byId(claim.agentId);
    if (!claim.pid) throw new ChannelAuthError('Run ws-channel from inside an agent session: the call carried no process id.');
    const cached = claim.ppid ? this.cached(claim.ppid) : undefined;
    if (cached) return cached;
    let procs: readonly ProcInfo[];
    try {
      procs = await this.processes();
    } catch (error) {
      throw new ChannelAuthError(`Could not identify the calling session: ${(error as Error).message}`);
    }
    // The CLI process may be younger than the scan: then start from its parent, which it reported itself.
    const leafSeen = procs.some((proc) => proc.pid === claim.pid);
    const chain = ancestry(leafSeen || !claim.ppid ? claim.pid : claim.ppid, procs);
    const agents = this.deps.agents();
    const index = chain.findIndex((p) => agentAt(p, agents) !== undefined);
    if (index < 0) throw new ChannelAuthError('ws-channel is not running inside an agent session Waystation can see.');
    const agent = agentAt(chain[index], agents)!;
    // Cache the long-lived processes between the CLI and the agent (its shell), never the CLI itself.
    this.remember(chain.slice(leafSeen ? 1 : 0, index), agent.id);
    return agent;
  }

  private byId(agentId: string): Agent {
    const agent = this.deps.agent(agentId);
    if (!agent || agent.status === 'stopped') throw new ChannelAuthError(`Waystation does not know a running session ${agentId}.`);
    return agent;
  }

  private cached(pid: number): Agent | undefined {
    const hit = this.cache.get(pid);
    if (!hit || hit.expires <= this.deps.now()) return undefined;
    const agent = this.deps.agent(hit.agentId);
    return agent && agent.status !== 'stopped' ? agent : undefined;
  }

  private remember(pids: readonly number[], agentId: string): void {
    const expires = this.deps.now() + CACHE_TTL_MS;
    const fresh = [...this.cache].filter(([, entry]) => entry.expires > this.deps.now());
    this.cache = new Map([...fresh, ...pids.map((pid) => [pid, { agentId, expires }] as const)]);
  }

  /** Several CLI calls at once share one process scan. */
  private processes(): Promise<readonly ProcInfo[]> {
    const now = this.deps.now();
    if (this.scan && now - this.scan.at < SCAN_REUSE_MS) return this.scan.procs;
    const procs = this.deps.processes();
    this.scan = { at: now, procs };
    procs.catch(() => { if (this.scan?.procs === procs) this.scan = undefined; });
    return procs;
  }
}
