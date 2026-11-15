import { describe, expect, it, vi } from 'vitest';
import { CallerResolver, ChannelAuthError, ancestorAgent, parseClaim } from '../daemon/channels/callerIdentity.ts';
import type { ProcInfo } from '../daemon/collectors/processScanner.ts';
import type { Agent } from '../daemon/domain/types.ts';
import { makeAgent } from './helpers.ts';

const proc = (pid: number, ppid: number, name = 'x.exe'): ProcInfo => ({ pid, ppid, name, commandLine: name, created: '' });

// claude (100) -> bash (200) -> node ws-channel (300); codex (500) -> pwsh (600)
const PROCS = [proc(1, 0, 'explorer.exe'), proc(100, 1, 'claude.exe'), proc(200, 100, 'bash.exe'), proc(300, 200, 'node.exe'), proc(500, 1, 'codex.exe'), proc(600, 500, 'pwsh.exe')];
const CLAUDE = makeAgent({ id: 'claude:a', pid: 100, status: 'busy' });
const CODEX = makeAgent({ id: 'codex:b', vendor: 'codex', pid: 500, status: 'idle' });
const MANAGED = makeAgent({ id: 'managed:m1', pid: undefined, status: 'idle' });

const resolver = (agents: Agent[] = [CLAUDE, CODEX, MANAGED], procs: ProcInfo[] = PROCS) => {
  const processes = vi.fn(async () => procs);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  let now = 1_000;
  const instance = new CallerResolver({ agent: (id) => byId.get(id), agents: () => agents, processes, now: () => now });
  return { instance, processes, advance: (ms: number) => { now += ms; } };
};

describe('parseClaim', () => {
  it('keeps positive integer pids and a well-formed agent id', () => {
    expect(parseClaim({ pid: 300, ppid: 200, agentId: 'managed:m1' })).toEqual({ pid: 300, ppid: 200, agentId: 'managed:m1' });
    expect(parseClaim({ pid: -1, ppid: 1.5, agentId: 'x'.repeat(300) })).toEqual({});
    expect(parseClaim('nope')).toEqual({});
  });
});

describe('ancestorAgent', () => {
  it('finds the nearest live agent up the parent chain', () => {
    expect(ancestorAgent(300, PROCS, [CLAUDE, CODEX])?.id).toBe('claude:a');
    expect(ancestorAgent(600, PROCS, [CLAUDE, CODEX])?.id).toBe('codex:b');
  });

  it('ignores stopped agents and survives parent cycles', () => {
    expect(ancestorAgent(300, PROCS, [{ ...CLAUDE, status: 'stopped' }])).toBeUndefined();
    expect(ancestorAgent(7, [proc(7, 8), proc(8, 7)], [CLAUDE])).toBeUndefined();
  });
});

describe('CallerResolver', () => {
  it('trusts a known agent id from the managed environment without scanning', async () => {
    const { instance, processes } = resolver();
    expect((await instance.resolve({ agentId: 'managed:m1' })).id).toBe('managed:m1');
    expect(processes).not.toHaveBeenCalled();
  });

  it('identifies a session by process ancestry and caches the shell', async () => {
    const { instance, processes } = resolver();
    expect((await instance.resolve({ pid: 300, ppid: 200 })).id).toBe('claude:a');
    expect((await instance.resolve({ pid: 301, ppid: 200 })).id).toBe('claude:a');
    expect(processes).toHaveBeenCalledTimes(1);
  });

  it('rescans once the cache expires', async () => {
    const { instance, processes, advance } = resolver();
    await instance.resolve({ pid: 300, ppid: 200 });
    advance(10 * 60_000);
    await instance.resolve({ pid: 301, ppid: 200 });
    expect(processes).toHaveBeenCalledTimes(2);
  });

  it('refuses callers it cannot tie to a session', async () => {
    const { instance } = resolver();
    await expect(instance.resolve({})).rejects.toBeInstanceOf(ChannelAuthError);
    await expect(instance.resolve({ agentId: 'managed:unknown' })).rejects.toThrow(/Waystation does not know/);
    await expect(instance.resolve({ pid: 999, ppid: 998 })).rejects.toThrow(/not running inside an agent session/);
  });

  it('reports a failed process scan as an identification failure', async () => {
    const { instance, processes } = resolver();
    processes.mockRejectedValueOnce(new Error('powershell missing'));
    await expect(instance.resolve({ pid: 300, ppid: 200 })).rejects.toThrow(/powershell missing/);
  });
});
