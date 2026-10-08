import type { Agent, PendingInterception } from './api.ts';

/** How long you must be away before the "While you were away" card appears. */
export const RECAP_MIN_AWAY_MS = 10 * 60 * 1000;
export const LAST_VISIT_KEY = 'waystation-last-visit';

export type RecapGroup = 'waiting' | 'trouble' | 'finished';

export interface RecapEntry {
  readonly id: string;
  readonly name: string;
  readonly project: string;
  readonly group: RecapGroup;
  /** One short human line explaining why the agent is listed. */
  readonly detail: string;
  readonly at?: number;
  /** Approvals waiting for this agent (waiting group only). */
  readonly pendingCount: number;
}

export interface Recap {
  readonly since: number;
  readonly awayMs: number;
  readonly waiting: readonly RecapEntry[];
  readonly trouble: readonly RecapEntry[];
  readonly finished: readonly RecapEntry[];
  /** Agents with any event since the last visit. */
  readonly activeCount: number;
  /** Active agents that are still busy and need nothing from you. */
  readonly stillWorking: number;
  /** List-price estimate across active agents. */
  readonly spentUsd: number;
  /** False when no active agent carries a price estimate. */
  readonly hasCost: boolean;
}

/** Minimal Storage surface so tests can inject a fake or a blocked store. */
export interface VisitStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const isActiveSince = (agent: Agent, since: number): boolean => (agent.lastEventAt ?? 0) > since;

const troubleDetail = (agent: Agent): string | undefined => {
  if (agent.lastError) return agent.lastError;
  if (agent.breaker && agent.breaker.level !== 'ok') return agent.breaker.reason || `Runaway guard ${agent.breaker.level}`;
  return undefined;
};

function classify(agent: Agent, pendingCount: number, active: boolean): RecapEntry | undefined {
  const base = { id: agent.id, name: agent.name, project: agent.project, at: agent.lastEventAt, pendingCount };
  if (agent.status === 'waiting' || pendingCount > 0) {
    const detail = pendingCount > 0 ? `${pendingCount} approval${pendingCount === 1 ? '' : 's'} waiting` : 'Waiting for your reply';
    return { ...base, group: 'waiting', detail };
  }
  if (!active) return undefined;
  const trouble = troubleDetail(agent);
  if (trouble) return { ...base, group: 'trouble', detail: trouble };
  if (agent.status === 'idle') return { ...base, group: 'finished', detail: 'Finished and ready for more' };
  if (agent.status === 'stopped') return { ...base, group: 'finished', detail: 'Session ended' };
  return undefined;
}

const newestFirst = (a: RecapEntry, b: RecapEntry): number => (b.at ?? 0) - (a.at ?? 0);

/** Summarise what the crew did between `lastVisit` and `now`. Pure; safe to call every render. */
export function buildRecap(agents: readonly Agent[], pending: readonly PendingInterception[], lastVisit: number, now: number): Recap {
  const pendingByAgent = pending.reduce<ReadonlyMap<string, number>>(
    (acc, p) => new Map(acc).set(p.agentId, (acc.get(p.agentId) ?? 0) + 1),
    new Map(),
  );
  const active = agents.filter(agent => isActiveSince(agent, lastVisit));
  const entries = agents
    .map(agent => classify(agent, pendingByAgent.get(agent.id) ?? 0, isActiveSince(agent, lastVisit)))
    .filter((entry): entry is RecapEntry => entry !== undefined);
  const pick = (group: RecapGroup): RecapEntry[] => entries.filter(e => e.group === group).sort(newestFirst);
  const priced = active.filter(agent => agent.usage?.costUsd !== undefined);
  return {
    since: lastVisit,
    awayMs: Math.max(0, now - lastVisit),
    waiting: pick('waiting'),
    trouble: pick('trouble'),
    finished: pick('finished'),
    activeCount: active.length,
    stillWorking: active.filter(agent => agent.status === 'busy' && !pendingByAgent.has(agent.id) && !troubleDetail(agent)).length,
    spentUsd: priced.reduce((sum, agent) => sum + (agent.usage?.costUsd ?? 0), 0),
    hasCost: priced.length > 0,
  };
}

/** Show the card only after a real absence during which something happened. */
export function shouldShowRecap(recap: Recap): boolean {
  return recap.awayMs >= RECAP_MIN_AWAY_MS && recap.activeCount > 0;
}

const browserStorage = (): VisitStorage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined; // Access itself can throw when site data is blocked.
  }
};

export function readLastVisit(storage: VisitStorage | undefined = browserStorage()): number | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(LAST_VISIT_KEY);
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Returns whether the write stuck; a blocked store just means the card cannot remember visits. */
export function writeLastVisit(ts: number, storage: VisitStorage | undefined = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LAST_VISIT_KEY, String(ts));
    return true;
  } catch {
    return false;
  }
}
