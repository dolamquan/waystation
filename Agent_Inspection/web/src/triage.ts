import type { Agent, FileContention, PendingInterception } from './api.ts';

/**
 * Keyboard triage: everything that needs the operator, in the order it should be handled, plus the
 * helpers behind the global shortcuts and the command palette. Pure, so it is tested without a DOM.
 */

export type TriageKind = 'approval' | 'question' | 'guard' | 'waiting' | 'contention';

export interface TriageItem {
  /** Stable across renders: `pending:<id>`, `agent:<id>` or `file:<path>`. */
  readonly key: string;
  readonly kind: TriageKind;
  readonly agentId: string;
  readonly pendingId?: string;
  readonly path?: string;
  readonly since: number;
  readonly label: string;
}

const ASK_TOOL = 'AskUserQuestion';

const bySince = (a: TriageItem, b: TriageItem): number => a.since - b.since;

function pendingItems(pending: readonly PendingInterception[], names: ReadonlyMap<string, string>): TriageItem[] {
  return pending.map((item): TriageItem => {
    const name = names.get(item.agentId) ?? 'An agent';
    const question = item.toolName === ASK_TOOL;
    return {
      key: `pending:${item.id}`, kind: question ? 'question' : 'approval', agentId: item.agentId, pendingId: item.id,
      since: item.createdAt, label: question ? `Question from ${name}` : `${item.toolName} from ${name}`,
    };
  }).sort(bySince);
}

function agentItems(agents: readonly Agent[], covered: ReadonlySet<string>): TriageItem[] {
  const open = agents.filter((agent) => !covered.has(agent.id));
  const guard = open.filter((agent) => agent.breaker && agent.breaker.level !== 'ok')
    .map((agent): TriageItem => ({ key: `agent:${agent.id}`, kind: 'guard', agentId: agent.id, since: agent.breaker?.since ?? 0, label: `Runaway guard: ${agent.name}` }));
  const guarded = new Set(guard.map((item) => item.agentId));
  const waiting = open.filter((agent) => agent.status === 'waiting' && !guarded.has(agent.id))
    .map((agent): TriageItem => ({ key: `agent:${agent.id}`, kind: 'waiting', agentId: agent.id, since: agent.lastEventAt ?? 0, label: `${agent.name} is waiting` }));
  return [...guard.sort(bySince), ...waiting.sort(bySince)];
}

function contentionItems(contention: readonly FileContention[], names: ReadonlyMap<string, string>): TriageItem[] {
  return contention.map((entry): TriageItem => ({
    key: `file:${entry.path}`, kind: 'contention', agentId: entry.agents[0]?.agentId ?? '', path: entry.path, since: entry.since,
    label: `${entry.agents.map((agent) => names.get(agent.agentId) ?? 'agent').join(' and ')} edited the same file`,
  })).sort(bySince);
}

/** Held calls and questions (oldest first), then guard alarms, waiting agents, and shared files. */
export function triageQueue(
  pending: readonly PendingInterception[],
  agents: readonly Agent[],
  contention: readonly FileContention[],
): TriageItem[] {
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const held = pendingItems(pending, names);
  const covered = new Set(held.map((item) => item.agentId));
  return [...held, ...agentItems(agents, covered), ...contentionItems(contention, names)];
}

/** The next (1) or previous (-1) item, wrapping; from the start when the current one is gone. */
export function stepQueue(queue: readonly TriageItem[], currentKey: string | undefined, direction: 1 | -1): TriageItem | undefined {
  if (queue.length === 0) return undefined;
  const index = queue.findIndex((item) => item.key === currentKey);
  if (index < 0) return direction === 1 ? queue[0] : queue[queue.length - 1];
  return queue[(index + direction + queue.length) % queue.length];
}

interface TargetLike {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  closest?(selector: string): unknown;
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
/** Terminals and code editors own every key typed into them. */
const KEY_OWNERS = '.xterm, .monaco-editor';

/** Whether a key press belongs to the field the operator is typing in, not to a shortcut. */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as TargetLike;
  if (el.tagName && TYPING_TAGS.has(el.tagName.toUpperCase())) return true;
  if (el.isContentEditable) return true;
  return typeof el.closest === 'function' && Boolean(el.closest(KEY_OWNERS));
}

export interface PaletteEntry {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly hint?: string;
  readonly keywords?: string;
}

const MAX_RESULTS = 60;

function rank(entry: PaletteEntry, words: readonly string[]): number | undefined {
  const label = entry.label.toLowerCase();
  const haystack = `${label} ${(entry.hint ?? '').toLowerCase()} ${(entry.keywords ?? '').toLowerCase()} ${entry.group.toLowerCase()}`;
  if (!words.every((word) => haystack.includes(word))) return undefined;
  const first = words[0];
  if (label.startsWith(first)) return 0;
  if (label.split(/[\s:·/&-]+/).some((part) => part.startsWith(first))) return 1;
  return label.includes(first) ? 2 : 3;
}

/**
 * Every word must appear (label, hint, keywords or group); label prefixes rank first, ties keep their
 * order. Results stay grouped (one heading per group), groups ordered by their best match.
 */
export function matchCommands<T extends PaletteEntry>(entries: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return entries.slice(0, MAX_RESULTS);
  const ranked = entries
    .map((entry, index) => ({ entry, index, score: rank(entry, words) }))
    .filter((row): row is { entry: T; index: number; score: number } => row.score !== undefined)
    .sort((a, b) => a.score - b.score || a.index - b.index);
  const groupOrder = new Map<string, number>();
  for (const row of ranked) if (!groupOrder.has(row.entry.group)) groupOrder.set(row.entry.group, groupOrder.size);
  return ranked
    .map((row, position) => ({ ...row, position }))
    .sort((a, b) => (groupOrder.get(a.entry.group) ?? 0) - (groupOrder.get(b.entry.group) ?? 0) || a.position - b.position)
    .slice(0, MAX_RESULTS)
    .map((row) => row.entry);
}

/** Shown in the palette footer. */
export const SHORTCUTS: ReadonlyArray<readonly [keys: string, action: string]> = [
  ['Ctrl K', 'Command palette'],
  ['N / Shift N', 'Next / previous item needing you'],
  ['A', 'Approve the focused tool call'],
  ['E', 'Edit its input'],
  ['D', 'Deny with an instruction'],
  ['Ctrl Enter', 'Send the edit or denial'],
  ['1–9, Enter', 'Pick and send a question answer'],
  ['Esc', 'Cancel or close'],
];
