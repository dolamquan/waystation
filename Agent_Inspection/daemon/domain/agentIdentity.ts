import type { Agent } from './types.ts';

const sessionKey = (agent: Agent): string | undefined => {
  const sessionId = agent.sessionId?.trim();
  return sessionId ? `${agent.vendor}:${sessionId}` : undefined;
};

/** A managed session's transcript observation represents the same agent, under another id. */
export function uniqueAgents(agents: readonly Agent[]): Agent[] {
  const byId = new Map<string, Agent>();
  for (const agent of agents) {
    const current = byId.get(agent.id);
    if (!current || agent.tier < current.tier) byId.set(agent.id, agent);
  }
  const owners = new Map<string, Agent>();
  for (const agent of byId.values()) {
    const key = sessionKey(agent);
    if (agent.tier === 'A' && key && !owners.has(key)) owners.set(key, agent);
  }
  const aliases = new Map<string, string>();
  const visible = [...byId.values()].filter(agent => {
    const key = sessionKey(agent);
    const owner = key ? owners.get(key) : undefined;
    if (agent.tier !== 'A' && owner && owner.id !== agent.id) {
      aliases.set(agent.id, owner.id);
      return false;
    }
    return true;
  });
  // A real helper may still refer to the observed id of its parent while discovery catches up.
  return visible.map(agent => {
    const parentId = agent.parentId ? aliases.get(agent.parentId) : undefined;
    return parentId ? { ...agent, parentId } : agent;
  });
}
