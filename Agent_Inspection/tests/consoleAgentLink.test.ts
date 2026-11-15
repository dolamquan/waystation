import { describe, expect, it, vi } from 'vitest';
import { ConsoleAgentLinker, computeLinks, guessLinks, type LinkAgent, type LinkConsole } from '../daemon/pty/consoleAgentLink.ts';
import type { ConsoleInfo } from '../daemon/pty/types.ts';

const agent = (id: string, pid: number | undefined, extra: Partial<LinkAgent> = {}): LinkAgent => ({ id, vendor: 'claude', pid, ...extra });
const term = (id: string, ptyPid: number, kind: LinkConsole['kind'] = 'claude'): LinkConsole => ({ id, kind, ptyPid });
// pty 100 -> powershell 101 -> claude 102 ; pty 200 -> shell 201 -> node 202 -> claude 203
const parents = new Map<number, number>([[102, 101], [101, 100], [203, 202], [202, 201], [201, 200], [100, 1], [200, 1]]);
const rows = [...parents].map(([pid, ppid]) => ({ pid, ppid }));

describe('computeLinks', () => {
  it('links an agent to the console whose pty is an ancestor of its process', () => {
    const links = computeLinks([agent('a', 102), agent('b', 203)], [term('c1', 100), term('c2', 200)], parents);
    expect(Object.fromEntries(links)).toEqual({ c1: 'a', c2: 'b' });
  });

  it('only links claude and codex consoles, and only agents of the same vendor', () => {
    expect(computeLinks([agent('a', 102)], [term('c1', 100, 'shell')], parents).size).toBe(0);
    expect(computeLinks([agent('a', 102, { vendor: 'codex' })], [term('c1', 100, 'claude')], parents).size).toBe(0);
    expect(Object.fromEntries(computeLinks([agent('a', 102, { vendor: 'codex' })], [term('c1', 100, 'codex')], parents))).toEqual({ c1: 'a' });
  });

  it('ignores agents without a pid and unrelated processes', () => {
    expect(computeLinks([agent('a', undefined), agent('b', 999)], [term('c1', 100)], parents).size).toBe(0);
  });

  it('prefers a top-level agent over a sub-agent in the same console', () => {
    const links = computeLinks([agent('sub', 102, { parentId: 'a' }), agent('a', 102)], [term('c1', 100)], parents);
    expect(links.get('c1')).toBe('a');
  });

  it('survives a parent cycle', () => {
    const cyclic = new Map<number, number>([[5, 6], [6, 5]]);
    expect(computeLinks([agent('a', 5)], [term('c1', 100)], cyclic).size).toBe(0);
  });
});

function fakeConsoles(initial: ConsoleInfo[], pids: Record<string, number>) {
  let list = initial;
  return {
    list: () => list,
    pidOf: (id: string) => pids[id],
    setAgentId: vi.fn((id: string, agentId: string | undefined) => {
      list = list.map((info) => {
        if (info.id !== id) return info;
        const { agentId: _old, ...rest } = info;
        return agentId ? { ...rest, agentId } : rest;
      });
    }),
  };
}
const info = (id: string, extra: Partial<ConsoleInfo> = {}): ConsoleInfo =>
  ({ id, name: id, kind: 'claude', cwd: '/', state: 'running', createdAt: 0, lastOutputAt: 0, ...extra });

describe('ConsoleAgentLinker', () => {
  it('sets, keeps and clears links it made, and never touches a directly linked console', async () => {
    const consoles = fakeConsoles([info('c1'), info('c2', { agentId: 'direct' })], { c1: 100, c2: 200 });
    let agents = [agent('a', 102), agent('b', 203)];
    const linker = new ConsoleAgentLinker({ agents: () => agents, consoles, processes: async () => rows, isAlive: () => true });
    await linker.run();
    expect(consoles.setAgentId).toHaveBeenCalledTimes(1);
    expect(consoles.list().find((c) => c.id === 'c1')?.agentId).toBe('a');
    expect(consoles.list().find((c) => c.id === 'c2')?.agentId).toBe('direct');

    await linker.run();
    expect(consoles.setAgentId).toHaveBeenCalledTimes(1);

    agents = [];
    await linker.run();
    expect(consoles.list().find((c) => c.id === 'c1')?.agentId).toBeUndefined();
    expect(consoles.list().find((c) => c.id === 'c2')?.agentId).toBe('direct');
  });

  it('degrades silently when the process table is unavailable and keeps existing links', async () => {
    const consoles = fakeConsoles([info('c1')], { c1: 100 });
    let fail = false;
    const linker = new ConsoleAgentLinker({
      agents: () => [agent('a', 102)], consoles,
      processes: async () => { if (fail) throw new Error('blocked'); return rows; },
    });
    await linker.run();
    fail = true;
    await expect(linker.run()).resolves.toBeUndefined();
    expect(consoles.list()[0]?.agentId).toBe('a');
  });

  it('does not read the process table when no agent console is running', async () => {
    const consoles = fakeConsoles([info('s', { kind: 'shell' })], { s: 100 });
    const table = vi.fn(async () => rows);
    await new ConsoleAgentLinker({ agents: () => [agent('a', 102)], consoles, processes: table }).run();
    expect(table).not.toHaveBeenCalled();
  });

  it('throttles request() into one trailing run', async () => {
    vi.useFakeTimers();
    try {
      const consoles = fakeConsoles([info('c1')], { c1: 100 });
      const table = vi.fn(async () => rows);
      const linker = new ConsoleAgentLinker({ agents: () => [agent('a', 102)], consoles, processes: table, throttleMs: 500 });
      linker.request(); linker.request(); linker.request();
      expect(table).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600);
      expect(table).toHaveBeenCalledTimes(1);
      expect(consoles.list()[0]?.agentId).toBe('a');
      linker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not rescan while every link is intact, and rescans when a linked agent vanishes', async () => {
    const consoles = fakeConsoles([info('c1')], { c1: 100 });
    const table = vi.fn(async () => rows);
    let alive = true;
    const linker = new ConsoleAgentLinker({
      agents: () => [agent('a', 102)], consoles, processes: table, tableTtlMs: 0, isAlive: () => alive,
    });
    await linker.run();
    await linker.run();
    await linker.run();
    expect(table).toHaveBeenCalledTimes(1);
    alive = false;
    await linker.run();
    expect(table).toHaveBeenCalledTimes(2);
  });

  it('caches the process table for a few seconds', async () => {
    let now = 0;
    const consoles = fakeConsoles([info('c1'), info('c2')], { c1: 100, c2: 200 });
    const table = vi.fn(async () => rows);
    const linker = new ConsoleAgentLinker({
      agents: () => [agent('a', 102), agent('b', 999)], consoles, processes: table, now: () => now, tableTtlMs: 5000, isAlive: () => true,
    });
    await linker.run();
    now = 1000;
    await linker.run(); // c2 stays unlinked, so it wants a scan, but the table is fresh
    expect(table).toHaveBeenCalledTimes(1);
    now = 6000;
    await linker.run();
    expect(table).toHaveBeenCalledTimes(2);
  });

  it('logs a failure once per distinct message and still never throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const consoles = fakeConsoles([info('c1')], { c1: 100 });
      const linker = new ConsoleAgentLinker({
        agents: () => [agent('a', 102)], consoles, tableTtlMs: 0,
        processes: async () => { throw new Error('blocked'); },
      });
      await linker.run();
      await linker.run();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('checks a newly discovered process even when the process table is still cached', async () => {
    const consoles = fakeConsoles([info('c1')], { c1: 100 });
    let agents = [agent('outside', 999)];
    const table = vi.fn(async () => rows);
    const linker = new ConsoleAgentLinker({ agents: () => agents, consoles, processes: table, now: () => 1_000, isAlive: () => true });
    await linker.run();
    expect(consoles.list()[0]?.agentId).toBeUndefined();
    agents = [agent('new', 103)];
    table.mockResolvedValue([...rows, { pid: 103, ppid: 101 }]);
    await linker.run();
    expect(table).toHaveBeenCalledTimes(2);
    expect(consoles.list()[0]?.agentId).toBe('new');
  });

  it('finishes linking agents discovered during a slow scan before resolving joined callers', async () => {
    const consoles = fakeConsoles([info('c1'), info('c2')], { c1: 100, c2: 200 });
    let agents = [agent('a', 102)];
    let release!: (value: typeof rows) => void;
    const table = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValue([...rows, { pid: 204, ppid: 201 }]);
    const linker = new ConsoleAgentLinker({ agents: () => agents, consoles, processes: table, isAlive: () => true });
    const first = linker.run();
    agents = [...agents, agent('new', 204)];
    linker.request();
    const joined = linker.run();
    release(rows);
    await Promise.all([first, joined]);
    expect(consoles.list().map(console => console.agentId)).toEqual(['a', 'new']);
    expect(table).toHaveBeenCalledTimes(2);
    linker.stop();
  });

  it('does not repeat discovery in response to its own provisional console updates', async () => {
    const consoles = fakeConsoles([info('c1', { cwd: 'C:\\A', createdAt: 1_000 })], { c1: 100 });
    let linker!: ConsoleAgentLinker;
    const table = vi.fn(async () => {
      // Bound a failing regression so a feedback loop cannot starve the test runner's timers.
      if (table.mock.calls.length > 3) linker.stop();
      return rows;
    });
    linker = new ConsoleAgentLinker({
      agents: () => [agent('outside', 999, { cwd: 'C:\\A', startedAt: 2_000 })],
      consoles, processes: table, tableTtlMs: 0, isAlive: () => true,
    });
    const update = consoles.setAgentId.getMockImplementation()!;
    consoles.setAgentId.mockImplementation((id, agentId) => { update(id, agentId); linker.request(); });
    try {
      await linker.run();
      expect(consoles.list()[0]?.agentId).toBeUndefined();
      expect(table).toHaveBeenCalledTimes(1);
    } finally { linker.stop(); }
  });
});

describe('guessLinks (agents with no process id, e.g. Codex rollout threads)', () => {
  const codexTerm = (id: string, cwd: string, createdAt: number): LinkConsole => ({ id, kind: 'codex', ptyPid: 0, cwd, createdAt });
  const thread = (id: string, cwd: string, startedAt: number, extra: Partial<LinkAgent> = {}): LinkAgent =>
    ({ id, vendor: 'codex', pid: undefined, cwd, startedAt, source: 'Codex · codex_cli_rs (likely live)', ...extra });

  it('links a thread to the console opened in its folder before it started', () => {
    const links = guessLinks([thread('t', 'C:\\Work\\App', 5_000)], [codexTerm('c1', 'c:/work/app/', 4_000)], new Map());
    expect(Object.fromEntries(links)).toEqual({ c1: 't' });
  });

  it('pairs each thread with the latest console opened before it, in the same folder', () => {
    const links = guessLinks(
      [thread('late', 'C:\\A', 9_000), thread('early', 'C:\\A', 3_000)],
      [codexTerm('c1', 'C:\\A', 1_000), codexTerm('c2', 'C:\\A', 8_000), codexTerm('other', 'C:\\B', 8_500)],
      new Map(),
    );
    expect(Object.fromEntries(links)).toEqual({ c1: 'early', c2: 'late' });
  });

  it('skips threads from another folder, older than the console, editor threads, sub-agents and taken links', () => {
    const consoles = [codexTerm('c1', 'C:\\A', 10_000)];
    expect(guessLinks([thread('t', 'C:\\B', 11_000)], consoles, new Map()).size).toBe(0);
    expect(guessLinks([thread('t', 'C:\\A', 1_000)], consoles, new Map()).size).toBe(0);
    expect(guessLinks([thread('t', 'C:\\A', 11_000, { source: 'Codex · codex_vscode (likely live)' })], consoles, new Map()).size).toBe(0);
    expect(guessLinks([thread('t', 'C:\\A', 11_000, { parentId: 'p' })], consoles, new Map()).size).toBe(0);
    expect(guessLinks([thread('t', 'C:\\A', 11_000)], consoles, new Map([['c1', 'x']])).get('c1')).toBe('x');
    expect(guessLinks([thread('t', 'C:\\A', 11_000)], consoles, new Map([['c9', 't']])).has('c1')).toBe(false);
  });

  it('links a resumed thread (started before the console) that has been active since the console launched', () => {
    // A console restored after a restart keeps its createdAt but runs `codex resume --last` from launchedAt.
    const restored: LinkConsole = { ...codexTerm('c1', 'C:\\A', 1_000), launchedAt: 50_000 };
    const links = guessLinks([thread('t', 'C:\\A', 500, { lastEventAt: 51_000 })], [restored], new Map());
    expect(Object.fromEntries(links)).toEqual({ c1: 't' });
  });

  it('does not treat an old thread as resumed when it has been quiet since the console launched', () => {
    const consoles = [{ ...codexTerm('c1', 'C:\\A', 10_000), launchedAt: 10_000 }];
    expect(guessLinks([thread('t', 'C:\\A', 500, { lastEventAt: 2_000 })], consoles, new Map()).size).toBe(0);
    expect(guessLinks([thread('t', 'C:\\B', 500, { lastEventAt: 20_000 })], consoles, new Map()).size).toBe(0);
  });

  it('prefers a thread that started in the console over a resumed one', () => {
    const consoles = [codexTerm('c1', 'C:\\A', 10_000)];
    const links = guessLinks(
      [thread('old', 'C:\\A', 500, { lastEventAt: 30_000 }), thread('fresh', 'C:\\A', 11_000, { lastEventAt: 12_000 })],
      consoles, new Map(),
    );
    expect(Object.fromEntries(links)).toEqual({ c1: 'fresh' });
  });

  it('links a Codex console to its pid-less thread without needing the process table', async () => {
    const consoles = fakeConsoles([info('c1', { kind: 'codex', cwd: 'C:\\A', createdAt: 1_000 })], { c1: 100 });
    const table = vi.fn(async () => rows);
    const linker = new ConsoleAgentLinker({ agents: () => [thread('t', 'C:\\A', 2_000)], consoles, processes: table, isAlive: () => true });
    await linker.run();
    await linker.run();
    expect(consoles.list()[0]?.agentId).toBe('t');
    expect(table).not.toHaveBeenCalled();
  });

  it('links a new Claude console before the process scan finishes, then trusts the scan', async () => {
    const consoles = fakeConsoles([info('c1', { cwd: 'C:\\A', createdAt: 1_000 })], { c1: 100 });
    let release: (value: typeof rows) => void = () => undefined;
    const linker = new ConsoleAgentLinker({
      agents: () => [agent('a', 102, { cwd: 'C:\\A', startedAt: 2_000 })], consoles,
      processes: () => new Promise((resolve) => { release = resolve; }), isAlive: () => true,
    });
    const pass = linker.run();
    await vi.waitFor(() => expect(consoles.list()[0]?.agentId).toBe('a'));
    release(rows);
    await pass;
    expect(consoles.list()[0]?.agentId).toBe('a');
  });

  it('drops a provisional Claude link the process scan contradicts', async () => {
    const consoles = fakeConsoles([info('c1', { cwd: 'C:\\A', createdAt: 1_000 })], { c1: 100 });
    const linker = new ConsoleAgentLinker({
      agents: () => [agent('outside', 999, { cwd: 'C:\\A', startedAt: 2_000 })], consoles, processes: async () => rows, isAlive: () => true,
    });
    await linker.run();
    expect(consoles.list()[0]?.agentId).toBeUndefined();
  });
});

describe('computeLinks start times', () => {
  it('skips an agent that started before the console, and links when the time is unknown', () => {
    const consoles = [{ ...term('c1', 100), createdAt: 100_000 }];
    const old = new Map([[102, 1_000]]);
    expect(computeLinks([agent('a', 102)], consoles, parents, old).size).toBe(0);
    expect(computeLinks([agent('a', 102)], consoles, parents, new Map([[102, 100_500]])).get('c1')).toBe('a');
    expect(computeLinks([agent('a', 102)], consoles, parents, new Map()).get('c1')).toBe('a');
  });
});
