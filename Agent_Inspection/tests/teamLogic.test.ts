import { describe, expect, it } from 'vitest';
import {
  channelSlug, eligibleCandidates, friendlyError, groupChannels, memberHandle, recipientOptions, skillCovers, totalUnread,
} from '../web/src/components/consoles/teamLogic.ts';
import type { ChannelView } from '../web/src/components/consoles/channelsApi.ts';

const member = (name: string, agentId: string, unread = 0) => ({
  name, agentId, vendor: 'claude', joinedAt: 1, agentName: name, status: 'idle' as const, unread,
});
const channel = (id: string, createdAt: number, members: ReturnType<typeof member>[] = []): ChannelView =>
  ({ id, name: id, purpose: '', createdAt, members, messages: [] });

describe('memberHandle', () => {
  it('lowercases and slugs a label like the daemon does', () => {
    expect(memberHandle('Claude Code: API!', [])).toBe('claude-code-api');
  });
  it('avoids reserved words and clashes', () => {
    expect(memberHandle('all', [])).toBe('all-agent');
    expect(memberHandle('operator', [])).toBe('operator-agent');
    expect(memberHandle('Bob', ['bob', 'bob-2'])).toBe('bob-3');
  });
  it('falls back to "agent" and caps the length', () => {
    expect(memberHandle('???', [])).toBe('agent');
    expect(memberHandle('x'.repeat(80), [])).toHaveLength(32);
  });
});

describe('channelSlug', () => {
  it('matches the daemon channel name rule', () => {
    expect(channelSlug('  Fix The Build ')).toBe('fix-the-build');
    expect(channelSlug('!!!')).toBe('');
  });
});

describe('eligibleCandidates', () => {
  const candidates = [
    { agentId: 'a', label: 'A', origin: 'console' as const },
    { agentId: 'b', label: 'B', origin: 'managed' as const },
  ];
  it('drops agents already in the channel', () => {
    expect(eligibleCandidates(candidates, channel('t', 1, [member('a', 'a')])).map((c) => c.agentId)).toEqual(['b']);
  });
  it('keeps everyone for a new team and ignores duplicate ids', () => {
    expect(eligibleCandidates([...candidates, candidates[0]], undefined)).toHaveLength(2);
  });
});

describe('groupChannels and unread', () => {
  it('sums unread across members', () => {
    expect(totalUnread(channel('t', 1, [member('a', 'a', 2), member('b', 'b', 3)]))).toBe(5);
  });
  it('puts channels with unread first, then newest first', () => {
    const list = [channel('old', 1), channel('new', 5), channel('busy', 2, [member('a', 'a', 1)])];
    expect(groupChannels(list).map((c) => c.id)).toEqual(['busy', 'new', 'old']);
  });
  it('does not mutate its input', () => {
    const list = [channel('old', 1), channel('new', 5)];
    groupChannels(list);
    expect(list[0].id).toBe('old');
  });
});

describe('recipientOptions', () => {
  it('offers everyone first, then each member', () => {
    expect(recipientOptions(channel('t', 1, [member('a', 'a'), member('b', 'b')]))).toEqual(['all', 'a', 'b']);
  });
});

describe('skillCovers', () => {
  const targets = [{ installed: true, current: true }, { installed: false, current: false }];
  it('maps vendors to the skill folders their CLI reads', () => {
    expect(skillCovers('claude', targets)).toBe(true);
    expect(skillCovers('codex', targets)).toBe(false);
    expect(skillCovers('copilot', targets)).toBe(true);
  });
  it('is false when nothing is known', () => {
    expect(skillCovers('claude', [])).toBe(false);
  });
});

describe('friendlyError', () => {
  it('explains a stopped session', () => {
    expect(friendlyError('That session is not running. Only running sessions can join a channel.')).toMatch(/running/i);
  });
  it('explains the member limit and duplicate name', () => {
    expect(friendlyError('A channel holds at most 12 members.')).toMatch(/12/);
    expect(friendlyError('A channel named #x already exists.')).toMatch(/already/);
  });
  it('passes unknown text through and handles non-strings', () => {
    expect(friendlyError('boom')).toBe('boom');
    expect(friendlyError(undefined)).toMatch(/went wrong/i);
  });
});
