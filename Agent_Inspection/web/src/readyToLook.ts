import { writesFiles } from '../../shared/fileEdits.ts';
import type { Agent, AgentEvent } from './api.ts';

/**
 * "Ready to look": an agent just finished a stretch of work that changed files, so there is
 * something new to see. Tracked from the live feed inside the tower reducer, so bursts of
 * events between renders are never missed.
 */
export interface TurnWatch {
  /** Agents that wrote files since their last finished turn. */
  readonly edited: ReadonlySet<string>;
  /** When each agent finished a turn that changed files. */
  readonly ready: ReadonlyMap<string, number>;
}

export const EMPTY_TURN_WATCH: TurnWatch = { edited: new Set(), ready: new Map() };

export function watchEvent(watch: TurnWatch, event: AgentEvent): TurnWatch {
  if (event.kind !== 'tool_call' || !writesFiles(event.summary) || watch.edited.has(event.agentId)) return watch;
  return { ...watch, edited: new Set([...watch.edited, event.agentId]) };
}

/** Mid-turn states: "waiting" is a held approval or a question, so the work isn't finished yet. */
const WORKING: ReadonlySet<Agent['status']> = new Set(['busy', 'waiting']);
const FINISHED: ReadonlySet<Agent['status']> = new Set(['idle', 'stopped']);

/** Compares two agent snapshots: a finished turn with edits marks the agent ready; working again clears it. */
export function watchAgents(watch: TurnWatch, before: readonly Agent[], after: readonly Agent[], now: number): TurnWatch {
  const previous = new Map(before.map((agent) => [agent.id, agent.status] as const));
  const present = new Set(after.map((agent) => agent.id));
  const edited = new Set([...watch.edited].filter((id) => present.has(id)));
  const ready = new Map([...watch.ready].filter(([id]) => present.has(id)));
  for (const agent of after) {
    const was = previous.get(agent.id);
    if (agent.status === 'busy') {
      ready.delete(agent.id);
    } else if (FINISHED.has(agent.status) && was !== undefined && WORKING.has(was) && edited.has(agent.id)) {
      ready.set(agent.id, now);
      edited.delete(agent.id);
    }
  }
  return { edited, ready };
}

/** Agents whose newest results the operator hasn't opened yet. */
export function unseenReady(ready: ReadonlyMap<string, number>, lookedAt: Readonly<Record<string, number>>, openId?: string): ReadonlySet<string> {
  return new Set([...ready].filter(([id, at]) => id !== openId && (lookedAt[id] ?? 0) < at).map(([id]) => id));
}
