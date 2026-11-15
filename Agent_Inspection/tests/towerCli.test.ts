import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CliHandoffs } from '../daemon/actions/cliHandoffs.ts';
import { TowerCli, type TowerCliDeps } from '../daemon/towerCli.ts';
import { tempDir } from './helpers.ts';

beforeAll(() => { process.env.AGENT_TOWER_CLAUDE_EXE = process.execPath; });
afterEach(() => vi.restoreAllMocks());

/** A TowerCli over fakes: one idle managed Claude agent, and a console launcher the test controls. */
function setup(opts: { stopRunner?: (cliSessions: CliHandoffs, ticketId: () => string) => void } = {}) {
  let now = 1_000;
  const cliSessions = new CliHandoffs({ ticketsDir: tempDir('towercli-'), now: () => now, isAlive: () => false, startTimeoutMs: 60_000 });
  let ticket = '';
  let consoleExit: () => void = () => undefined;
  let shuttingDown = false;
  const launch = vi.fn();
  const forget = vi.fn();
  const upsert = vi.fn();
  const endConsole = vi.fn();
  const launch0 = { vendor: 'claude', agentId: 'a1', prompt: '', cwd: process.cwd() };
  const runner = {
    sessionId: 's1', model: undefined, launch: launch0,
    snapshot: () => ({ id: 'a1', name: 'A', status: 'idle' }),
    stop: async () => { opts.stopRunner?.(cliSessions, () => ticket); },
  };
  const deps = {
    registry: { upsert, drop: vi.fn(), pushEvent: vi.fn() },
    store: { audit: vi.fn() },
    managed: { get: () => runner, forget, launch },
    notifier: { attachDefaults: () => ({}), revoke: vi.fn() },
    cliSessions,
    hooksOn: () => false,
    launchCliTab: async () => undefined,
    launchCliConsole: async (ticketId: string, _vendor: string, _title: string, _agent: string | undefined, onExit: () => void) => {
      ticket = ticketId; consoleExit = onExit; return 'console-1';
    },
    endConsole,
    isShuttingDown: () => shuttingDown,
    requireAgent: () => ({ id: 'a1', name: 'A', vendor: 'claude', status: 'idle', cwd: process.cwd(), project: 'p' }),
    queueHookMessage: vi.fn(),
    openTeamMember: () => undefined,
  } as unknown as TowerCliDeps;
  return {
    cli: new TowerCli(deps), cliSessions, launch, forget, upsert, endConsole,
    exitConsole: () => consoleExit(), ticket: () => ticket,
    shutDown: () => { shuttingDown = true; }, advance: (ms: number) => { now += ms; },
  };
}

describe('TowerCli console hand-off', () => {
  it('does not relaunch the agent when its console exits during shutdown', async () => {
    const t = setup();
    await t.cli.open('a1', 'console');
    t.shutDown();
    t.exitConsole();
    expect(t.launch).not.toHaveBeenCalled();
  });

  it('brings the agent back when its console exits normally', async () => {
    const t = setup();
    await t.cli.open('a1', 'console');
    t.exitConsole();
    expect(t.launch).toHaveBeenCalledTimes(1);
  });

  it('aborts cleanly when the launcher dies while the runner is stopping', async () => {
    const t = setup({ stopRunner: (sessions, ticket) => sessions.ended(ticket()) });
    await expect(t.cli.open('a1', 'console')).rejects.toThrow(/ended before it started/);
    expect(t.launch).toHaveBeenCalledTimes(1);
    expect(t.forget).not.toHaveBeenCalled();
    expect(t.upsert).not.toHaveBeenCalled();
    expect(t.cli.isParked('a1')).toBe(false);
  });

  it('ends the console and brings the agent back when the launcher never checks in', async () => {
    const t = setup();
    await t.cli.open('a1', 'console');
    t.advance(5 * 60_000);
    t.cliSessions.sweep();
    expect(t.endConsole).toHaveBeenCalledWith('console-1');
    expect(t.launch).toHaveBeenCalledTimes(1);
  });
});
