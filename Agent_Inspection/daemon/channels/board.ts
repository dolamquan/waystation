import { randomUUID } from 'node:crypto';
import { CHANNEL_EVERYONE, CHANNEL_OPERATOR, type ChannelMember, type ChannelMessage, type ChannelState } from './types.ts';

/** Pure channel state transitions. Every function returns a new state and never changes its input. */

export class ChannelError extends Error {}

export const MAX_CHANNEL_MESSAGES = 300;
export const MAX_CHANNEL_TEXT = 8000;
export const MAX_CHANNEL_MEMBERS = 12;
/** Loop guard: automatic wake-ups per channel per window, so two agents cannot keep waking each other. */
export const WAKE_WINDOW_MS = 10 * 60_000;
export const MAX_WAKES_PER_WINDOW = 30;
const MAX_HANDLE = 32;
const RESERVED = new Set([CHANNEL_EVERYONE, CHANNEL_OPERATOR]);

const slug = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, MAX_HANDLE).replace(/-+$/, '');

export function createChannel(input: { id: string; name: string; purpose: string; now: number }): ChannelState {
  const name = slug(input.name);
  if (!name) throw new ChannelError('A channel name needs at least one letter or digit.');
  return {
    id: input.id, name, purpose: input.purpose.trim(), createdAt: input.now,
    members: [], messages: [], nextSeq: 1, readUpTo: {}, recentWakes: [],
  };
}

/** A unique handle from a suggested name: lowercase, reserved words avoided, suffixed -2, -3… on clashes. */
export function memberName(suggested: string, taken: readonly string[]): string {
  const raw = slug(suggested) || 'agent';
  const base = RESERVED.has(raw) ? `${raw}-agent` : raw;
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export const memberByAgent = (state: ChannelState, agentId: string): ChannelMember | undefined =>
  state.members.find((member) => member.agentId === agentId);

export const memberByName = (state: ChannelState, name: string): ChannelMember | undefined =>
  state.members.find((member) => member.name === name);

export function addMember(state: ChannelState, input: { agentId: string; vendor: string; name: string }, now: number): ChannelState {
  if (memberByAgent(state, input.agentId)) throw new ChannelError('That session is already a member of this channel.');
  if (state.members.length >= MAX_CHANNEL_MEMBERS) throw new ChannelError(`A channel holds at most ${MAX_CHANNEL_MEMBERS} members.`);
  const name = memberName(input.name, state.members.map((member) => member.name));
  const member: ChannelMember = { name, agentId: input.agentId, vendor: input.vendor, joinedAt: now };
  // Earlier messages are history for a newcomer, not unread mail.
  return { ...state, members: [...state.members, member], readUpTo: { ...state.readUpTo, [name]: state.nextSeq - 1 } };
}

export function removeMember(state: ChannelState, name: string): ChannelState {
  if (!memberByName(state, name)) throw new ChannelError(`"${name}" is not a member of #${state.name}.`);
  const { [name]: _dropped, ...readUpTo } = state.readUpTo;
  return { ...state, members: state.members.filter((member) => member.name !== name), readUpTo };
}

export function postMessage(
  state: ChannelState, from: string, to: string, rawText: string, now: number, replyTo?: string,
): { state: ChannelState; message: ChannelMessage } {
  if (from !== CHANNEL_OPERATOR && !memberByName(state, from)) throw new ChannelError(`"${from}" is not a member of #${state.name}.`);
  if (to !== CHANNEL_EVERYONE && !memberByName(state, to)) {
    const names = state.members.map((member) => member.name).join(', ') || 'none';
    throw new ChannelError(`No member named "${to}" in #${state.name}. Members: ${names}. Use "${CHANNEL_EVERYONE}" to message everyone.`);
  }
  if (to === from) throw new ChannelError('You cannot message yourself.');
  const text = rawText.trim();
  if (!text) throw new ChannelError('The message is empty.');
  if (text.length > MAX_CHANNEL_TEXT) throw new ChannelError('Messages are limited to 8,000 characters.');
  const message: ChannelMessage = {
    seq: state.nextSeq, id: `m_${randomUUID().slice(0, 8)}`, ts: now, from, to, text, ...(replyTo ? { replyTo } : {}),
  };
  const messages = [...state.messages, message].slice(-MAX_CHANNEL_MESSAGES);
  return { state: { ...state, messages, nextSeq: state.nextSeq + 1 }, message };
}

/** Is this message addressed to `name` (directly or to everyone) and not written by it? */
export const isFor = (message: ChannelMessage, name: string): boolean =>
  message.from !== name && (message.to === name || message.to === CHANNEL_EVERYONE);

export function unreadFor(state: ChannelState, name: string): ChannelMessage[] {
  const upTo = state.readUpTo[name] ?? 0;
  return state.messages.filter((message) => message.seq > upTo && isFor(message, name));
}

/** Recent messages a member can see (to or from it, or to everyone), oldest first. */
export function historyFor(state: ChannelState, name: string, limit: number): ChannelMessage[] {
  return state.messages.filter((message) => message.from === name || isFor(message, name)).slice(-limit);
}

export function markRead(state: ChannelState, name: string, seq: number): ChannelState {
  const current = state.readUpTo[name] ?? 0;
  if (seq <= current) return state;
  return { ...state, readUpTo: { ...state.readUpTo, [name]: seq } };
}

/** Spend one automatic wake-up if the channel's window allows it. */
export function takeWake(state: ChannelState, now: number): { state: ChannelState; allowed: boolean } {
  const recent = state.recentWakes.filter((ts) => now - ts < WAKE_WINDOW_MS);
  if (recent.length >= MAX_WAKES_PER_WINDOW) return { state: { ...state, recentWakes: recent }, allowed: false };
  return { state: { ...state, recentWakes: [...recent, now] }, allowed: true };
}
