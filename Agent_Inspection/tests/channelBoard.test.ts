import { describe, expect, it } from 'vitest';
import {
  ChannelError, MAX_CHANNEL_MESSAGES, MAX_WAKES_PER_WINDOW, WAKE_WINDOW_MS, addMember, createChannel, markRead, memberByAgent,
  memberName, postMessage, removeMember, takeWake, unreadFor,
} from '../daemon/channels/board.ts';
import { CHANNEL_EVERYONE, CHANNEL_OPERATOR } from '../daemon/channels/types.ts';

const T0 = 1_761_200_000_000;

const twoMembers = () => {
  const base = createChannel({ id: 'ch_1', name: 'Frontend sync', purpose: 'api contract', now: T0 });
  const one = addMember(base, { agentId: 'claude:a', vendor: 'claude', name: 'ui' }, T0);
  return addMember(one, { agentId: 'codex:b', vendor: 'codex', name: 'api' }, T0);
};

describe('createChannel', () => {
  it('slugs the name and starts empty', () => {
    const channel = createChannel({ id: 'ch_1', name: '  Frontend Sync! ', purpose: '', now: T0 });
    expect(channel).toMatchObject({ id: 'ch_1', name: 'frontend-sync', members: [], messages: [], nextSeq: 1, recentWakes: [] });
  });

  it('refuses a name with nothing usable in it', () => {
    expect(() => createChannel({ id: 'ch_1', name: '!!!', purpose: '', now: T0 })).toThrow(ChannelError);
  });
});

describe('memberName', () => {
  it('derives a unique handle and avoids reserved names', () => {
    expect(memberName('Claude · Agents', [])).toBe('claude-agents');
    expect(memberName('ui', ['ui'])).toBe('ui-2');
    expect(memberName('ui', ['ui', 'ui-2'])).toBe('ui-3');
    expect(memberName('All', [])).toBe('all-agent');
    expect(memberName('operator', [])).toBe('operator-agent');
    expect(memberName('···', [])).toBe('agent');
  });
});

describe('addMember / removeMember', () => {
  it('adds members without changing the original state', () => {
    const base = createChannel({ id: 'ch_1', name: 'x', purpose: '', now: T0 });
    const next = addMember(base, { agentId: 'claude:a', vendor: 'claude', name: 'UI' }, T0);
    expect(base.members).toHaveLength(0);
    expect(next.members).toEqual([{ name: 'ui', agentId: 'claude:a', vendor: 'claude', joinedAt: T0 }]);
    expect(memberByAgent(next, 'claude:a')?.name).toBe('ui');
  });

  it('refuses the same session twice', () => {
    const channel = twoMembers();
    expect(() => addMember(channel, { agentId: 'claude:a', vendor: 'claude', name: 'again' }, T0)).toThrow(/already/);
  });

  it('does not show earlier messages to a new member as unread', () => {
    const { state } = postMessage(twoMembers(), 'ui', CHANNEL_EVERYONE, 'hello', T0);
    const joined = addMember(state, { agentId: 'gemini:c', vendor: 'gemini', name: 'docs' }, T0);
    expect(unreadFor(joined, 'docs')).toEqual([]);
  });

  it('removes a member and its read position', () => {
    const next = removeMember(twoMembers(), 'api');
    expect(next.members.map((m) => m.name)).toEqual(['ui']);
    expect(next.readUpTo).not.toHaveProperty('api');
    expect(() => removeMember(next, 'api')).toThrow(/not a member/);
  });
});

describe('postMessage', () => {
  it('numbers messages and addresses a member or everyone', () => {
    const first = postMessage(twoMembers(), 'ui', 'api', 'GET /users shape?', T0);
    const second = postMessage(first.state, 'api', 'ui', '{ id, name }', T0 + 1, first.message.id);
    expect(first.message).toMatchObject({ seq: 1, from: 'ui', to: 'api', text: 'GET /users shape?' });
    expect(second.message).toMatchObject({ seq: 2, replyTo: first.message.id });
    expect(second.state.nextSeq).toBe(3);
  });

  it('accepts the operator as a sender', () => {
    const { message } = postMessage(twoMembers(), CHANNEL_OPERATOR, CHANNEL_EVERYONE, 'sync at 3', T0);
    expect(message.from).toBe(CHANNEL_OPERATOR);
  });

  it('rejects unknown recipients, self-messages, empty and oversized text', () => {
    const channel = twoMembers();
    expect(() => postMessage(channel, 'ui', 'nobody', 'hi', T0)).toThrow(/No member named "nobody"/);
    expect(() => postMessage(channel, 'ui', 'ui', 'hi', T0)).toThrow(/yourself/);
    expect(() => postMessage(channel, 'ui', 'api', '   ', T0)).toThrow(/empty/);
    expect(() => postMessage(channel, 'ui', 'api', 'x'.repeat(8001), T0)).toThrow(/8,000/);
    expect(() => postMessage(channel, 'ghost', 'api', 'hi', T0)).toThrow(/not a member/);
  });

  it('keeps only the most recent messages', () => {
    let state = twoMembers();
    for (let i = 0; i < MAX_CHANNEL_MESSAGES + 5; i++) state = postMessage(state, 'ui', 'api', `m${i}`, T0 + i).state;
    expect(state.messages).toHaveLength(MAX_CHANNEL_MESSAGES);
    expect(state.messages[0].text).toBe('m5');
  });
});

describe('unreadFor / markRead', () => {
  it('lists mail to the member or to everyone, never its own', () => {
    let state = twoMembers();
    state = postMessage(state, 'ui', 'api', 'direct', T0).state;
    state = postMessage(state, 'ui', CHANNEL_EVERYONE, 'broadcast', T0).state;
    state = postMessage(state, 'api', CHANNEL_EVERYONE, 'own', T0).state;
    expect(unreadFor(state, 'api').map((m) => m.text)).toEqual(['direct', 'broadcast']);
    expect(unreadFor(state, 'ui').map((m) => m.text)).toEqual(['own']);
  });

  it('marks read up to a sequence number and never moves back', () => {
    let state = twoMembers();
    state = postMessage(state, 'ui', 'api', 'one', T0).state;
    state = postMessage(state, 'ui', 'api', 'two', T0).state;
    const read = markRead(state, 'api', 1);
    expect(unreadFor(read, 'api').map((m) => m.text)).toEqual(['two']);
    expect(markRead(markRead(read, 'api', 2), 'api', 1).readUpTo.api).toBe(2);
  });
});

describe('takeWake', () => {
  it('allows a bounded number of wake-ups per window', () => {
    let state = twoMembers();
    for (let i = 0; i < MAX_WAKES_PER_WINDOW; i++) {
      const taken = takeWake(state, T0 + i);
      expect(taken.allowed).toBe(true);
      state = taken.state;
    }
    expect(takeWake(state, T0 + MAX_WAKES_PER_WINDOW).allowed).toBe(false);
    const later = takeWake(state, T0 + WAKE_WINDOW_MS + MAX_WAKES_PER_WINDOW);
    expect(later.allowed).toBe(true);
    expect(later.state.recentWakes).toHaveLength(1);
  });
});
