import { describe, expect, it } from 'vitest';
import { isTypingTarget, matchCommands, stepQueue, triageQueue, type PaletteEntry } from '../web/src/triage.ts';
import type { PendingInterception } from '../daemon/domain/types.ts';
import { makeAgent } from './helpers.ts';

const held = (id: string, agentId: string, createdAt: number, toolName = 'Bash'): PendingInterception =>
  ({ id, agentId, sessionId: 's', toolName, input: {}, createdAt, origin: 'hook' });

describe('triageQueue', () => {
  it('puts held calls and questions first (oldest first), then guard alarms, waiting agents and shared files', () => {
    const agents = [
      makeAgent({ id: 'a', name: 'Pip' }),
      makeAgent({ id: 'b', name: 'Mica', breaker: { level: 'warned', reason: 'loop', since: 50 } }),
      makeAgent({ id: 'c', name: 'Orbit', status: 'waiting', lastEventAt: 10 }),
      makeAgent({ id: 'd', name: 'Nova', status: 'waiting', lastEventAt: 20 }),
    ];
    const queue = triageQueue(
      [held('p2', 'a', 200), held('p1', 'd', 100, 'AskUserQuestion')],
      agents,
      [{ path: 'C:\\w\\x.ts', agents: [{ agentId: 'a', lastAt: 5 }, { agentId: 'c', lastAt: 4 }], since: 1 }],
    );
    expect(queue.map((item) => [item.kind, item.key])).toEqual([
      ['question', 'pending:p1'],
      ['approval', 'pending:p2'],
      ['guard', 'agent:b'],
      ['waiting', 'agent:c'],
      ['contention', 'file:C:\\w\\x.ts'],
    ]);
    // Nova is waiting only because of its question: listed once.
    expect(queue.filter((item) => item.agentId === 'd')).toHaveLength(1);
    expect(queue[0].label).toMatch(/Nova/);
  });

  it('is empty when nothing needs the operator', () => {
    expect(triageQueue([], [makeAgent()], [])).toEqual([]);
  });
});

describe('stepQueue', () => {
  const queue = triageQueue([held('p1', 'a', 1), held('p2', 'a', 2), held('p3', 'a', 3)], [makeAgent({ id: 'a' })], []);

  it('starts at the first item, moves both ways and wraps', () => {
    expect(stepQueue(queue, undefined, 1)?.key).toBe('pending:p1');
    expect(stepQueue(queue, undefined, -1)?.key).toBe('pending:p3');
    expect(stepQueue(queue, 'pending:p1', 1)?.key).toBe('pending:p2');
    expect(stepQueue(queue, 'pending:p3', 1)?.key).toBe('pending:p1');
    expect(stepQueue(queue, 'pending:p1', -1)?.key).toBe('pending:p3');
  });

  it('restarts from the top when the current item was resolved', () => {
    expect(stepQueue(queue, 'pending:gone', 1)?.key).toBe('pending:p1');
    expect(stepQueue([], 'pending:p1', 1)).toBeUndefined();
  });
});

describe('isTypingTarget', () => {
  const el = (tagName: string, extra: Partial<{ isContentEditable: boolean; inside: string }> = {}) => ({
    tagName, isContentEditable: extra.isContentEditable ?? false,
    closest: (selector: string) => (extra.inside && selector.includes(extra.inside) ? {} : null),
  });

  it('treats text fields, editable content, terminals and editors as typing', () => {
    expect(isTypingTarget(el('INPUT'))).toBe(true);
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(el('SELECT'))).toBe(true);
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true);
    expect(isTypingTarget(el('DIV', { inside: '.xterm' }))).toBe(true);
    expect(isTypingTarget(el('DIV', { inside: '.monaco-editor' }))).toBe(true);
  });

  it('lets plain elements and missing targets through', () => {
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
    expect(isTypingTarget(el('ARTICLE'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('matchCommands', () => {
  const entries: PaletteEntry[] = [
    { id: '1', label: 'New agent', group: 'Actions' },
    { id: '2', label: 'Open Pip', hint: 'web · working', group: 'Agents', keywords: 'claude' },
    { id: '3', label: 'Usage & schedules', group: 'Go to' },
    { id: '4', label: 'New team', group: 'Actions' },
  ];

  it('returns everything for an empty query, in order', () => {
    expect(matchCommands(entries, '  ').map((entry) => entry.id)).toEqual(['1', '2', '3', '4']);
  });

  it('requires every word, ranks label prefixes first, and searches hints and keywords', () => {
    expect(matchCommands(entries, 'new').map((entry) => entry.id)).toEqual(['1', '4']);
    expect(matchCommands(entries, 'team new').map((entry) => entry.id)).toEqual(['4']);
    expect(matchCommands(entries, 'claude').map((entry) => entry.id)).toEqual(['2']);
    expect(matchCommands(entries, 'web work').map((entry) => entry.id)).toEqual(['2']);
    expect(matchCommands(entries, 'sched').map((entry) => entry.id)).toEqual(['3']);
    expect(matchCommands(entries, 'zzz')).toEqual([]);
  });

  it('keeps each group together, ordered by its best match', () => {
    const mixed: PaletteEntry[] = [
      { id: 'q', label: 'Question from Pip', group: 'Needs you' },
      { id: 'f', label: 'Pip and Mica edited the same file', group: 'Needs you' },
      { id: 'a', label: 'Pip', group: 'Agents' },
    ];
    expect(matchCommands(mixed, 'pip').map((entry) => entry.id)).toEqual(['f', 'q', 'a']);
  });
});
