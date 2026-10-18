import type { TeamLogEntry, TeamView } from '../../api.ts';
import { actorName } from './teamUi.ts';

export const MAX_LOG = 400;

export const sameEntry = (a: TeamLogEntry, b: TeamLogEntry): boolean =>
  a.ts === b.ts && a.summary === b.summary && a.actor === b.actor && a.messageId === b.messageId;

/** Adds entries not already present, oldest first, keeping the newest MAX_LOG. */
export function mergeEntries(previous: readonly TeamLogEntry[], incoming: readonly TeamLogEntry[]): TeamLogEntry[] {
  const fresh = incoming.filter((entry) => !previous.some((e) => sameEntry(e, entry)));
  if (fresh.length === 0) return [...previous];
  return [...previous, ...fresh].sort((a, b) => a.ts - b.ts).slice(-MAX_LOG);
}

/** A message is queued while a recipient still has it waiting (for 'all': while any member does). */
export function isQueued(team: TeamView, entry: TeamLogEntry): boolean {
  if (entry.kind !== 'message' || !entry.messageId || !entry.to) return false;
  const waitingFor = (memberId: string) => team.pendingIds?.[memberId]?.includes(entry.messageId!) ?? false;
  if (entry.to === 'all') return team.members.some((m) => waitingFor(m.id));
  const recipient = team.members.find((m) => m.id === entry.to || m.name === entry.to);
  return recipient ? waitingFor(recipient.id) : false;
}

/** The line above an entry's text: who said it to whom, or what kind of notice it is. */
export function entryHeading(team: TeamView, entry: TeamLogEntry): { title: string; kind: string } {
  const from = actorName(team, entry.actor);
  switch (entry.kind) {
    case 'message':
      return { title: entry.to ? `${from} → ${actorName(team, entry.to)}` : from, kind: 'Message' };
    case 'reply':
      return { title: from, kind: entry.to === 'operator' ? 'Reply to you' : 'Reply · not sent to teammates' };
    case 'task':
      return { title: from, kind: 'Task update' };
    case 'merge':
      return { title: from, kind: 'Work merged' };
    case 'activity':
      return { title: from, kind: 'Tool activity' };
    default:
      return { title: from, kind: 'Team update' };
  }
}

/** Whether an entry involves a member: written by them, addressed to them, or sent to everyone. */
export function involves(team: TeamView, entry: TeamLogEntry, memberId: string): boolean {
  const member = team.members.find((m) => m.id === memberId);
  const refs = new Set([memberId, member?.name]);
  return refs.has(entry.actor) || (entry.to !== undefined && (refs.has(entry.to) || entry.to === 'all'));
}

export interface LogView {
  readonly showActivity: boolean;
  /** A member id, 'operator', or undefined for everyone. */
  readonly member?: string;
}

/** Oldest first, numbered by position in the full log so row keys stay stable. */
export function visibleEntries(team: TeamView, log: readonly TeamLogEntry[], view: LogView): Array<{ entry: TeamLogEntry; position: number }> {
  return log
    .map((entry, position) => ({ entry, position }))
    .filter(({ entry }) => view.showActivity || entry.kind !== 'activity')
    .filter(({ entry }) => {
      if (!view.member) return true;
      if (view.member === 'operator') return entry.actor === 'operator' || entry.to === 'operator';
      return involves(team, entry, view.member);
    });
}
