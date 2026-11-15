import { folder, officeName } from '../../stationOffices.ts';
import { itemCwd, itemStatus, type BoardItem } from './boardItems.ts';

export const UNASSIGNED_KEY = 'unassigned';

/** One project folder on the console board: the sessions whose working folder is the same place. */
export interface BoardFolder {
  readonly key: string;
  readonly name: string;
  readonly path?: string;
  readonly items: readonly BoardItem[];
  readonly needsYou: number;
  readonly running: number;
}

/** When a session last did anything, for picking the project the user most likely cares about. */
export function itemActivity(item: BoardItem): number {
  return item.console ? item.console.lastOutputAt : item.agent?.lastEventAt ?? item.agent?.startedAt ?? 0;
}

/**
 * Groups sessions by working folder with the same normalisation and naming as the agent overview's offices.
 * Sessions without a folder go to 'Unassigned', which sorts last. `now` feeds the working/needs-you status.
 */
export function groupByFolder(items: readonly BoardItem[], now: number): BoardFolder[] {
  const groups = new Map<string, { path?: string; items: BoardItem[] }>();
  for (const item of items) {
    const location = folder(itemCwd(item));
    const key = location?.key ?? UNASSIGNED_KEY;
    const group = groups.get(key) ?? { path: location?.path, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const paths = [...groups.values()].flatMap((group) => (group.path ? [group.path] : []));
  return [...groups.entries()].map(([key, group]): BoardFolder => {
    const statuses = group.items.map((item) => itemStatus(item, now));
    return {
      key, path: group.path, items: group.items, name: officeName(group.path, paths),
      needsYou: statuses.filter((status) => status === 'needs-you').length,
      running: statuses.filter((status) => status !== 'exited').length,
    };
  }).sort((a, b) => Number(a.key === UNASSIGNED_KEY) - Number(b.key === UNASSIGNED_KEY)
    || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** The wanted folder while it still exists, else the one with the most recent activity, else the first. */
export function pickFolder(folders: readonly BoardFolder[], wanted: string | undefined): BoardFolder | undefined {
  const match = folders.find((candidate) => candidate.key === wanted);
  if (match) return match;
  let best: BoardFolder | undefined;
  let bestActivity = 0;
  for (const candidate of folders) {
    const activity = Math.max(0, ...candidate.items.map(itemActivity));
    if (activity > bestActivity) { best = candidate; bestActivity = activity; }
  }
  return best ?? folders[0];
}
