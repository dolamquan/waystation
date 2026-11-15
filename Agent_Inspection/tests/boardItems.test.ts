import { describe, expect, it } from 'vitest';
import type { Agent, ConsoleInfo } from '../web/src/api.ts';
import { buildBoardItems, canOpenAsTerminal, channelCandidates, countItems, filterItems, folderName, itemStatus } from '../web/src/components/consoles/boardItems.ts';

const con = (id: string, createdAt: number, extra: Partial<ConsoleInfo> = {}): ConsoleInfo =>
  ({ id, name: `Claude Code ${id}`, kind: 'claude', cwd: 'C:\\work\\my-folder', state: 'running', createdAt, lastOutputAt: 0, ...extra });
const agent = (id: string, extra: Partial<Agent> = {}): Agent =>
  ({ id, vendor: 'claude', tier: 'C', name: id, project: 'p', status: 'idle', source: 'GitHub Copilot · editor runtime', hooked: false, intercepting: false, canInstruct: false, ...extra }) as Agent;

describe('buildBoardItems', () => {
  it('lists consoles first by creation, then managed, then observed by recency', () => {
    const items = buildBoardItems(
      [con('b', 20), con('a', 10)],
      [agent('o1', { lastEventAt: 5 }), agent('m1', { tier: 'A', source: 'Claude Agent SDK · launched here' }), agent('o2', { lastEventAt: 9 })],
    );
    expect(items.map((item) => item.key)).toEqual(['console:a', 'console:b', 'agent:m1', 'agent:o2', 'agent:o1']);
    expect(items.map((item) => item.origin)).toEqual(['console', 'console', 'managed', 'observed', 'observed']);
  });

  it('does not list an agent that runs inside a console again', () => {
    const items = buildBoardItems([con('a', 1, { agentId: 'x' })], [agent('x'), agent('y')]);
    expect(items.map((item) => item.key)).toEqual(['console:a', 'agent:y']);
  });

  it('leaves editor runtimes (a background process, not a session) off the board', () => {
    const runtime = agent('copilot', { observation: { processName: 'copilot-runtime.exe', created: 'x', host: 'editor' } });
    const cli = agent('gemini', { observation: { processName: 'gemini.exe', created: 'y', host: 'cli' } });
    expect(buildBoardItems([], [runtime, cli]).map((item) => item.key)).toEqual(['agent:gemini']);
  });

  it('skips subagents by default and includes them on request', () => {
    const agents = [agent('p'), agent('s', { parentId: 'p' })];
    expect(buildBoardItems([], agents).map((item) => item.key)).toEqual(['agent:p']);
    expect(buildBoardItems([], agents, { subagents: true })).toHaveLength(2);
  });
});

describe('filterItems and countItems', () => {
  const items = buildBoardItems([con('a', 1)], [agent('m', { tier: 'A', source: 'Claude Agent SDK · launched here' }), agent('o')]);
  it('filters by kind', () => {
    expect(filterItems(items, 'all')).toHaveLength(3);
    expect(filterItems(items, 'consoles').map((i) => i.origin)).toEqual(['console']);
    expect(filterItems(items, 'agents').map((i) => i.origin)).toEqual(['managed']);
    expect(filterItems(items, 'observed').map((i) => i.origin)).toEqual(['observed']);
  });
  it('counts every filter', () => {
    expect(countItems(items)).toEqual({ all: 3, consoles: 1, agents: 1, observed: 1 });
  });
});

describe('channelCandidates', () => {
  it('keeps only items that resolve to a registry agent', () => {
    const items = buildBoardItems([con('a', 1, { agentId: 'x' }), con('b', 2)], [agent('m', { tier: 'A', source: 'Claude Agent SDK · launched here', name: 'Helper', cwd: 'C:/w/proj' })]);
    const list = channelCandidates(items);
    expect(list.map((c) => c.agentId)).toEqual(['x', 'm']);
    expect(list[0]).toMatchObject({ origin: 'console', label: 'Claude Code a · my-folder' });
    expect(list[1]).toMatchObject({ origin: 'managed', label: 'Helper · proj' });
  });
});

describe('itemStatus and canOpenAsTerminal', () => {
  it('maps registry status onto board status', () => {
    const status = (value: Agent['status']) => itemStatus(buildBoardItems([], [agent('a', { status: value })])[0]!, 0);
    expect([status('busy'), status('waiting'), status('idle'), status('stopped')]).toEqual(['working', 'needs-you', 'idle', 'exited']);
  });
  it('offers a terminal for agents but not consoles or subagents', () => {
    const [item] = buildBoardItems([con('a', 1)], []);
    expect(canOpenAsTerminal(item!)).toBe(false);
    const [sub] = buildBoardItems([], [agent('s', { parentId: 'p' })], { subagents: true });
    expect(canOpenAsTerminal(sub!)).toBe(false);
    expect(canOpenAsTerminal(buildBoardItems([], [agent('o')])[0]!)).toBe(true);
  });
});

describe('origin by tier', () => {
  const origin = (tier: Agent['tier']) => buildBoardItems([], [agent('t', { tier })])[0]!.origin;
  it('treats only tier A (launched in Waystation) as managed', () => {
    expect([origin('A'), origin('B'), origin('C')]).toEqual(['managed', 'observed', 'observed']);
  });
  it('ignores the human source label', () => {
    const items = buildBoardItems([], [agent('m', { tier: 'A', source: 'managed-ish' }), agent('o', { tier: 'C', source: 'managed' })]);
    expect(items.map((i) => i.origin)).toEqual(['managed', 'observed']);
  });
});

describe('exited consoles', () => {
  it('only a running console hides its linked agent', () => {
    const exited = buildBoardItems([con('a', 1, { agentId: 'x', state: 'exited' })], [agent('x')]);
    expect(exited.map((i) => i.key)).toEqual(['console:a', 'agent:x']);
    const running = buildBoardItems([con('a', 1, { agentId: 'x' })], [agent('x')]);
    expect(running.map((i) => i.key)).toEqual(['console:a']);
  });
  it('does not offer an exited console as a channel member', () => {
    const items = buildBoardItems([con('a', 1, { agentId: 'x', state: 'exited' })], []);
    expect(channelCandidates(items)).toEqual([]);
  });
});

describe('folderName', () => {
  it('handles Windows, POSIX and trailing separators', () => {
    expect(folderName(String.raw`C:\Users\me\proj`)).toBe('proj');
    expect(folderName('/home/me/proj/')).toBe('proj');
    expect(folderName('')).toBe('');
  });
});
