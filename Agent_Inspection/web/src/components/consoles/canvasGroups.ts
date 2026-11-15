/**
 * Teams on the canvas: a named frame around a set of tiles that moves as one. Pure logic, no React and no DOM.
 * Groups hold item keys (`console:<id>`); the tiles' geometry stays in canvasLayout. Everything read back from
 * storage is untrusted and is sanitised on the way in, as the canvas geometry is.
 */
import { TILE_GAP, TILE_HEIGHT, TILE_WIDTH, clampRect, moveRect, type Point, type Rect } from './canvasLayout.ts';

export interface CanvasGroup {
  readonly id: string;
  readonly name: string;
  /** Item keys, in the order they were launched. A tile belongs to at most one group. */
  readonly members: readonly string[];
  /** False until the members have been laid out in the team's grid (they are placed as their consoles appear). */
  readonly arranged: boolean;
}

export const GROUPS_KEY = 'waystation-canvas-groups';
export const MAX_GROUPS = 24;
export const MAX_GROUP_NAME = 40;
/** Space around the members inside the frame, and the frame's title strip above them. */
export const GROUP_PAD = 16;
export const GROUP_HEAD = 34;
const MAX_MEMBERS = 12;

type Rects = Readonly<Record<string, Rect>>;

/** The frame around a group's placed members; undefined while none of them has a rect yet. */
export function groupFrame(group: CanvasGroup, rects: Rects): Rect | undefined {
  const placed = group.members.flatMap((key) => rects[key] ?? []);
  if (placed.length === 0) return undefined;
  const minX = Math.min(...placed.map((r) => r.x));
  const minY = Math.min(...placed.map((r) => r.y));
  const maxX = Math.max(...placed.map((r) => r.x + r.width));
  const maxY = Math.max(...placed.map((r) => r.y + r.height));
  return {
    x: minX - GROUP_PAD, y: minY - GROUP_PAD - GROUP_HEAD,
    width: maxX - minX + GROUP_PAD * 2, height: maxY - minY + GROUP_PAD * 2 + GROUP_HEAD,
  };
}

/** Moves every placed member by (dx, dy) world pixels; other tiles keep their identity. */
export function moveGroup(rects: Rects, group: CanvasGroup, dx: number, dy: number): Record<string, Rect> {
  const next: Record<string, Rect> = { ...rects };
  for (const key of group.members) {
    const rect = rects[key];
    if (rect) next[key] = moveRect(rect, dx, dy);
  }
  return next;
}

/** Lays the members out in a grid from `origin`: one or two columns for up to four members, three beyond that. */
export function arrangeGroup(rects: Rects, group: CanvasGroup, origin: Point): Record<string, Rect> {
  const count = group.members.length;
  const columns = count <= 1 ? 1 : count <= 4 ? 2 : 3;
  const next: Record<string, Rect> = { ...rects };
  group.members.forEach((key, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    next[key] = clampRect({
      x: origin.x + column * (TILE_WIDTH + TILE_GAP), y: origin.y + row * (TILE_HEIGHT + TILE_GAP), width: TILE_WIDTH, height: TILE_HEIGHT,
    });
  });
  return next;
}

export const groupOf = (groups: readonly CanvasGroup[], key: string): CanvasGroup | undefined =>
  groups.find((group) => group.members.includes(key));

/** Adds a group, taking its members out of any other group (and dropping groups that end up empty). */
export function addGroup(groups: readonly CanvasGroup[], group: CanvasGroup): readonly CanvasGroup[] {
  const taken = new Set(group.members);
  const others = groups
    .map((existing) => ({ ...existing, members: existing.members.filter((key) => !taken.has(key)) }))
    .filter((existing) => existing.members.length > 0);
  return [...others, group].slice(-MAX_GROUPS);
}

export const removeGroup = (groups: readonly CanvasGroup[], id: string): readonly CanvasGroup[] => groups.filter((group) => group.id !== id);

export function renameGroup(groups: readonly CanvasGroup[], id: string, name: string): readonly CanvasGroup[] {
  const clean = name.trim().slice(0, MAX_GROUP_NAME).trim();
  if (!clean) return groups;
  return groups.map((group) => (group.id === id ? { ...group, name: clean } : group));
}

export const markArranged = (groups: readonly CanvasGroup[], id: string): readonly CanvasGroup[] =>
  groups.map((group) => (group.id === id ? { ...group, arranged: true } : group));

/** Forgets members that no longer exist and groups left empty; the same array when nothing changed. */
export function pruneGroups(groups: readonly CanvasGroup[], liveKeys: readonly string[]): readonly CanvasGroup[] {
  const live = new Set(liveKeys);
  let changed = false;
  const next = groups.flatMap((group) => {
    const members = group.members.filter((key) => live.has(key));
    if (members.length === group.members.length) return [group];
    changed = true;
    return members.length > 0 ? [{ ...group, members }] : [];
  });
  return changed ? next : groups;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function readGroup(value: unknown): CanvasGroup | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() || typeof value.name !== 'string' || !Array.isArray(value.members)) return undefined;
  const name = value.name.trim().slice(0, MAX_GROUP_NAME).trim();
  const members = [...new Set(value.members.filter((key): key is string => typeof key === 'string' && key.length > 0))].slice(0, MAX_MEMBERS);
  if (!name || members.length === 0) return undefined;
  return { id: value.id, name, members, arranged: value.arranged !== false };
}

/** Loads saved groups; anything malformed is dropped. Never throws. */
export function loadGroups(storage: Storage = localStorage): readonly CanvasGroup[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(GROUPS_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(readGroup).filter((group): group is CanvasGroup => group !== undefined).slice(0, MAX_GROUPS);
  } catch {
    return [];
  }
}

/** Saves groups; false when the browser refused (blocked or full storage). */
export function saveGroups(groups: readonly CanvasGroup[], storage: Storage = localStorage): boolean {
  try {
    storage.setItem(GROUPS_KEY, JSON.stringify(groups));
    return true;
  } catch {
    return false;
  }
}
