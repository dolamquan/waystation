import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../daemon/domain/registry.ts';
import { TowerStore } from '../daemon/store/db.ts';
import type { ManagedAgents } from '../daemon/managed/managedAgents.ts';
import { AgentOps, type AgentOpsDeps } from '../daemon/ops/agentOps.ts';
import { DEFAULT_BREAKER } from '../daemon/guard/breaker.ts';
import { OpsInputError } from '../daemon/ops/templates.ts';
import type { VendorWindows } from '../daemon/usage/windowTypes.ts';
import { ZERO_TOKENS } from '../daemon/usage/usageMeter.ts';
import { makeAgent, tempDir } from './helpers.ts';

const at = (h: number, m: number) => new Date(2026, 9, 3, h, m).getTime(); // Saturday

function setup(overrides: Partial<AgentOpsDeps> = {}) {
  const registry = new AgentRegistry();
  const store = new TowerStore(':memory:');
  const deps: AgentOpsDeps = {
    registry, store,
    managed: { get: () => undefined, launchOf: () => undefined } as unknown as ManagedAgents,
    isTeamMember: () => false,
    launch: vi.fn((raw: unknown) => makeAgent({ id: 'managed:scheduled', name: (raw as { name?: string }).name ?? 'scheduled' })),
    instruct: vi.fn(async () => 'Sent.'),
    setIntercept: vi.fn(),
    interrupt: vi.fn(async () => undefined),
    stopAgent: vi.fn(async () => undefined),
    probes: { nodeVersion: 'v24.0.0', claudeExe: () => undefined, codexEntry: () => undefined, hooksInstalled: () => true },
    breaker: DEFAULT_BREAKER,
    resourcesDir: tempDir(),
    ...overrides,
  };
  return { ops: new AgentOps(deps), deps, registry, store };
}

const spender = (id: string, project: string, costUsd: number) => makeAgent({
  id, tier: 'A', vendor: 'claude', project, cwd: `C:\\work\\${project}`, status: 'busy', canInstruct: true,
  usage: { tokens: { ...ZERO_TOKENS, output: 100 }, costUsd },
});

describe('fleet spend cap', () => {
  // Schedules are created "before" their 09:00 slot on the test day.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at(7, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it('saves, reloads and validates the settings', () => {
    const { ops, store, deps } = setup();
    expect(ops.spendCap()).toEqual({ projects: {}, constrainRunning: true });
    ops.setSpendCap({ dailyUsd: 20, projects: { web: 4 }, quotaPausePercent: 90 });
    const fresh = new AgentOps({ ...deps, store });
    expect(fresh.spendCap()).toEqual({ dailyUsd: 20, projects: { web: 4 }, quotaPausePercent: 90, constrainRunning: true });
    expect(() => ops.setSpendCap({ dailyUsd: -3 })).toThrow(OpsInputError);
  });

  it('reports today\'s spend against each cap', () => {
    const { ops, registry } = setup();
    ops.setSpendCap({ dailyUsd: 10, projects: { web: 2 } });
    registry.upsert('test', spender('managed:a', 'web', 1.7));
    const status = ops.spendStatus();
    expect(status.scopes.map((scope) => [scope.scope, scope.state])).toEqual([['fleet', 'ok'], ['project', 'near']]);
  });

  it('constrains running agents in an exceeded project once, through the runaway guard', async () => {
    const { ops, registry, deps } = setup();
    ops.setSpendCap({ projects: { web: 2 } });
    registry.upsert('test', spender('managed:a', 'web', 2.5));
    registry.upsert('test', spender('managed:b', 'api', 9));
    ops.spendStatus();
    await vi.waitFor(() => expect(deps.setIntercept).toHaveBeenCalledWith('managed:a', true));
    expect(deps.setIntercept).not.toHaveBeenCalledWith('managed:b', true);
    expect(registry.get('managed:a')?.breaker).toMatchObject({ level: 'constrained', reason: expect.stringMatching(/Project web/) });
    // Cleared by the operator: the cap does not step straight back in today.
    ops.resetBreaker('managed:a');
    ops.spendStatus();
    expect(registry.get('managed:a')?.breaker).toBeUndefined();
  });

  it('leaves running agents alone when constrainRunning is off', () => {
    const { ops, registry, deps } = setup();
    ops.setSpendCap({ dailyUsd: 1, constrainRunning: false });
    registry.upsert('test', spender('managed:a', 'web', 3));
    ops.spendStatus();
    expect(deps.setIntercept).not.toHaveBeenCalled();
  });

  it('defers a due schedule while over the cap, and runs it once spend allows', async () => {
    const { ops, deps, store } = setup();
    const cwd = tempDir();
    const schedule = ops.createSchedule({ label: 'Nightly', time: '09:00', days: [6], launch: { vendor: 'claude', cwd, prompt: 'go' } });
    ops.setSpendCap({ dailyUsd: 1 });
    store.recordUsage(spender('managed:x', 'elsewhere', 5), at(8, 0));
    await ops.runDueSchedules(at(9, 1));
    expect(deps.launch).not.toHaveBeenCalled();
    expect(ops.schedules(at(9, 1)).find((s) => s.id === schedule.id)?.lastResult).toMatch(/^Deferred: Spend cap: All agents/);
    ops.setSpendCap({ dailyUsd: 50 });
    await ops.runDueSchedules(at(9, 2));
    expect(deps.launch).toHaveBeenCalledTimes(1);
  });

  it('defers a due schedule while its vendor\'s plan window is nearly full', async () => {
    const windows: VendorWindows[] = [{
      vendor: 'claude', week: { start: 0, end: 1, tokens: ZERO_TOKENS, totalTokens: 0, unpricedTokens: 0, requests: 0 },
      limits: [{ window: 'five_hour', label: '5-hour', usedPercent: 97, observedAt: 1, source: 'claude-sdk' }],
    }];
    const { ops, deps } = setup({ quota: async () => windows });
    ops.createSchedule({ label: 'Nightly', time: '09:00', days: [6], launch: { vendor: 'claude', cwd: tempDir(), prompt: 'go' } });
    ops.setSpendCap({ quotaPausePercent: 90 });
    await ops.runDueSchedules(at(9, 1));
    expect(deps.launch).not.toHaveBeenCalled();
    expect(ops.schedules(at(9, 1))[0].lastResult).toMatch(/Claude 5-hour window is at 97%/);
  });

  it('never blocks Run now: the operator decided', () => {
    const { ops, deps, store } = setup();
    const schedule = ops.createSchedule({ label: 'Nightly', time: '09:00', days: [6], launch: { vendor: 'claude', cwd: tempDir(), prompt: 'go' } });
    ops.setSpendCap({ dailyUsd: 1 });
    store.recordUsage(spender('managed:x', 'elsewhere', 5));
    ops.runScheduleNow(schedule.id);
    expect(deps.launch).toHaveBeenCalledTimes(1);
  });
});
