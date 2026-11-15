import type { Agent, ConsoleInfo } from '../../api.ts';
import type { ChannelCandidate } from './ChannelsPanel.tsx';
import { statusOf, type Status } from './consoleStatus.ts';

export type BoardOrigin = 'console' | 'managed' | 'observed';
export type BoardFilter = 'all' | 'consoles' | 'agents' | 'observed';

/** One tile on the board: a real terminal, or an agent session that has no terminal of its own. */
export interface BoardItem {
  /** Stable across polls; canvas geometry is stored under it. */
  readonly key: string;
  readonly origin: BoardOrigin;
  readonly console?: ConsoleInfo;
  readonly agent?: Agent;
}

const recency = (agent: Agent): number => agent.lastEventAt ?? agent.startedAt ?? 0;
/** Last path segment of a Windows or POSIX folder; the one shared implementation. */
export const folderName = (cwd: string): string => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;

/** Tier A is launched in Waystation; `source` is only a human label ("Claude Agent SDK · launched here"). */
const isManaged = (agent: Agent): boolean => agent.tier === 'A';

/**
 * A runtime an editor keeps alive (e.g. VS Code's copilot-runtime.exe) is a background process with no folder and no
 * conversation, so on the board it was only an empty "Unassigned" tile. The station view still lists it.
 */
const isEditorRuntime = (agent: Agent): boolean => agent.observation?.host === 'editor';

/**
 * Merges PTY consoles and registry agents into one list. An agent that runs inside a console (console.agentId)
 * is that console, not a second tile. Subagents are left out unless asked for: they belong to their parent.
 */
export function buildBoardItems(
  consoles: readonly ConsoleInfo[],
  agents: readonly Agent[],
  options: { readonly subagents?: boolean } = {},
): readonly BoardItem[] {
  // Only a running console stands in for its agent: after the CLI exits the agent is relaunched under the same id
  // and must not vanish behind an "exited" tile.
  const inConsole = new Set(consoles.filter((info) => info.state === 'running').map((info) => info.agentId).filter((id): id is string => Boolean(id)));
  const listed = agents.filter((agent) => !inConsole.has(agent.id) && !isEditorRuntime(agent) && (options.subagents || !agent.parentId));
  const managed = listed.filter(isManaged);
  const observed = listed.filter((agent) => !isManaged(agent)).sort((a, b) => recency(b) - recency(a));
  return [
    ...[...consoles].sort((a, b) => a.createdAt - b.createdAt)
      .map((info): BoardItem => ({ key: `console:${info.id}`, origin: 'console', console: info })),
    ...managed.map((agent): BoardItem => ({ key: `agent:${agent.id}`, origin: 'managed', agent })),
    ...observed.map((agent): BoardItem => ({ key: `agent:${agent.id}`, origin: 'observed', agent })),
  ];
}

export function filterItems(items: readonly BoardItem[], filter: BoardFilter): readonly BoardItem[] {
  if (filter === 'all') return items;
  const wanted: BoardOrigin = filter === 'consoles' ? 'console' : filter === 'agents' ? 'managed' : 'observed';
  return items.filter((item) => item.origin === wanted);
}

export const countItems = (items: readonly BoardItem[]): Readonly<Record<BoardFilter, number>> => ({
  all: items.length,
  consoles: filterItems(items, 'consoles').length,
  agents: filterItems(items, 'agents').length,
  observed: filterItems(items, 'observed').length,
});

/** The registry agent behind an item, when there is one (a console only has one once the daemon has linked it). */
export const itemAgentId = (item: BoardItem): string | undefined => item.agent?.id ?? item.console?.agentId;

export const itemName = (item: BoardItem): string => item.console?.name ?? item.agent?.name ?? item.key;

export const itemCwd = (item: BoardItem): string => item.console?.cwd ?? item.agent?.cwd ?? '';

/** Items that can join a channel; each is labelled "name · folder". */
export function channelCandidates(items: readonly BoardItem[]): readonly ChannelCandidate[] {
  return items.flatMap((item) => {
    if (item.console && item.console.state !== 'running') return [];
    const agentId = itemAgentId(item);
    if (!agentId) return [];
    const cwd = itemCwd(item);
    return [{ agentId, origin: item.origin, label: cwd ? `${itemName(item)} · ${folderName(cwd)}` : itemName(item) }];
  });
}

/** The dot colour for an item: a console reads its own signals; an agent maps the registry status. */
export function itemStatus(item: BoardItem, now: number): Status {
  if (item.console) return statusOf(item.console, now);
  switch (item.agent?.status) {
    case 'busy': return 'working';
    case 'waiting': return 'needs-you';
    case 'idle': return 'idle';
    default: return 'exited';
  }
}

/** Only sessions that can be taken over in a real terminal: not consoles, not subagents. */
export const canOpenAsTerminal = (item: BoardItem): boolean =>
  item.origin !== 'console' && Boolean(item.agent) && !item.agent?.parentId;
