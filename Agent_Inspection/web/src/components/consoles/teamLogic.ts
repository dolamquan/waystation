import type { ChannelView } from './channelsApi.ts';

/** Pure decisions for the Teams panel (no React), mirroring the daemon's channel rules in daemon/channels/board.ts. */

const MAX_HANDLE = 32;
const EVERYONE = 'all';
const RESERVED: ReadonlySet<string> = new Set([EVERYONE, 'operator']);
const MEMBER_LIMIT = 12;

const slug = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, MAX_HANDLE).replace(/-+$/, '');

/** The name the daemon will give a channel (empty means invalid). */
export const channelSlug = (name: string): string => slug(name.trim());

/** The unique member handle the daemon would derive from a label, so the UI can preview it. */
export function memberHandle(label: string, taken: readonly string[]): string {
  const raw = slug(label) || 'agent';
  const base = RESERVED.has(raw) ? `${raw}-agent` : raw;
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

interface Joinable { readonly agentId: string }

/** Who may still join: each agent once, and not already a member of `channel` (omit it for a team being created). */
export function eligibleCandidates<T extends Joinable>(candidates: readonly T[], channel: ChannelView | undefined): readonly T[] {
  const inside = new Set(channel?.members.map((member) => member.agentId));
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (inside.has(candidate.agentId) || seen.has(candidate.agentId)) return false;
    seen.add(candidate.agentId);
    return true;
  });
}

export const totalUnread = (channel: ChannelView): number =>
  channel.members.reduce((sum, member) => sum + member.unread, 0);

/** Teams with waiting mail first, then newest first. Returns a new array. */
export const groupChannels = (channels: readonly ChannelView[]): readonly ChannelView[] =>
  [...channels].sort((a, b) => Number(totalUnread(b) > 0) - Number(totalUnread(a) > 0) || b.createdAt - a.createdAt);

/** "all" first, then every member, in the order the operator may address them. */
export const recipientOptions = (channel: ChannelView): readonly string[] =>
  [EVERYONE, ...channel.members.map((member) => member.name)];

export const isTeamFull = (channel: ChannelView): boolean => channel.members.length >= MEMBER_LIMIT;

/**
 * The skill is installed per user (not per project) in two folders: Claude Code reads the first, Codex and
 * Gemini the second, Copilot either. A member can message when a folder its CLI reads has the skill.
 */
export function skillCovers(vendor: string, targets: readonly { readonly installed: boolean }[]): boolean {
  const [claude, agents] = [targets[0]?.installed === true, targets[1]?.installed === true];
  if (vendor === 'claude') return claude;
  if (vendor === 'codex' || vendor === 'gemini') return agents;
  return claude || agents;
}

const FRIENDLY: readonly (readonly [RegExp, string])[] = [
  [/not running/i, 'That session has stopped. Only running sessions can join a team.'],
  [/already a member/i, 'That session is already in this team.'],
  [/at most 12 members/i, `A team holds at most ${MEMBER_LIMIT} members.`],
  [/already exists/i, 'A team with that name already exists. Pick another name.'],
  [/at least one letter or digit/i, 'Give the team a name with at least one letter or digit.'],
  [/message is empty/i, 'Write a message first.'],
  [/not a member|No member named/i, 'That member is no longer in the team.'],
  [/not found|unknown channel|no such channel/i, 'That team no longer exists.'],
];

/** Turns a daemon error into one plain sentence; unknown messages pass through untouched. */
export function friendlyError(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!text) return 'Something went wrong. Try again.';
  return FRIENDLY.find(([pattern]) => pattern.test(text))?.[1] ?? text;
}
