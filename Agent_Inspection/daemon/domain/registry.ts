import { EventEmitter } from 'node:events';
import type { Agent, AgentEvent } from './types.ts';

const MAX_EVENTS_PER_AGENT = 200;
const DUPLICATE_EVENT_WINDOW_MS = 2000;

interface RegistryEvents {
  agents: [Agent[]];
  event: [AgentEvent];
}

/**
 * In-memory source of truth for agents. Each collector owns a "source" key and
 * replaces its whole slice on every scan, so vanished agents disappear naturally.
 */
export class AgentRegistry extends EventEmitter<RegistryEvents> {
  private bySource = new Map<string, ReadonlyMap<string, Agent>>();
  private overrides = new Map<string, Partial<Agent>>();
  private events = new Map<string, readonly AgentEvent[]>();

  replaceSource(source: string, agents: readonly Agent[]): void {
    const next = new Map(agents.map((agent) => [agent.id, agent] as const));
    const prev = this.bySource.get(source);
    if (prev && sameAgents(prev, next)) return;
    this.bySource.set(source, next);
    this.emitAgents();
  }

  upsert(source: string, agent: Agent): void {
    const next = new Map(this.bySource.get(source) ?? []);
    next.set(agent.id, agent);
    this.bySource.set(source, next);
    this.emitAgents();
  }

  drop(source: string, agentId: string): void {
    const prev = this.bySource.get(source);
    if (!prev?.has(agentId)) return;
    this.bySource.set(source, new Map([...prev].filter(([id]) => id !== agentId)));
    this.emitAgents();
  }

  /**
   * Transient overrides layered on top of collector data (e.g. status 'waiting').
   * Keys set to undefined are removed from the override.
   */
  setOverride(agentId: string, patch: Partial<Agent>): void {
    const merged = Object.fromEntries(
      Object.entries({ ...this.overrides.get(agentId), ...patch }).filter(([, value]) => value !== undefined),
    ) as Partial<Agent>;
    const rest = [...this.overrides].filter(([id]) => id !== agentId);
    this.overrides = new Map(Object.keys(merged).length > 0 ? [...rest, [agentId, merged]] : rest);
    this.emitAgents();
  }

  list(): Agent[] {
    const merged = new Map<string, Agent>();
    for (const agents of this.bySource.values()) {
      for (const agent of agents.values()) {
        const existing = merged.get(agent.id);
        // Higher-control tiers win ('A' < 'B' < 'C') when two sources report the same agent.
        if (!existing || agent.tier < existing.tier) merged.set(agent.id, agent);
      }
    }
    return [...merged.values()]
      .map((agent) => ({ ...agent, ...this.overrides.get(agent.id) }))
      .sort((a, b) => (b.lastEventAt ?? b.startedAt ?? 0) - (a.lastEventAt ?? a.startedAt ?? 0));
  }

  get(agentId: string): Agent | undefined {
    return this.list().find((agent) => agent.id === agentId);
  }

  findBySessionId(sessionId: string): Agent | undefined {
    return this.list().find((agent) => agent.sessionId === sessionId);
  }

  pushEvent(event: AgentEvent): void {
    const prev = this.events.get(event.agentId) ?? [];
    const last = prev[prev.length - 1];
    const isDuplicate = last !== undefined && last.kind === event.kind && last.summary === event.summary
      && Math.abs(last.ts - event.ts) < DUPLICATE_EVENT_WINDOW_MS;
    if (isDuplicate) return;
    this.events.set(event.agentId, [...prev, event].slice(-MAX_EVENTS_PER_AGENT));
    this.emit('event', event);
  }

  recentEvents(agentId: string): readonly AgentEvent[] {
    return this.events.get(agentId) ?? [];
  }

  private emitAgents(): void {
    this.emit('agents', this.list());
  }
}

function sameAgents(a: ReadonlyMap<string, Agent>, b: ReadonlyMap<string, Agent>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, agent] of a) {
    const other = b.get(id);
    if (!other || JSON.stringify(other) !== JSON.stringify(agent)) return false;
  }
  return true;
}
