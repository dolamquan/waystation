import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRegistry } from '../daemon/domain/registry.ts';
import type { Agent, AgentUsage } from '../daemon/domain/types.ts';
import { TowerStore, localDay } from '../daemon/store/db.ts';
import type { ManagedAgents } from '../daemon/managed/managedAgents.ts';
import type { ManagedLaunch, ManagedRunner } from '../daemon/managed/types.ts';
import { AgentOps, type AgentOpsDeps } from '../daemon/ops/agentOps.ts';
import { DEFAULT_BREAKER } from '../daemon/guard/breaker.ts';
import { CATCH_UP_MS, dueSlot, newSchedule, nextRun, validateScheduleFields } from '../daemon/ops/schedules.ts';
import { OpsInputError, validateTemplate } from '../daemon/ops/templates.ts';
import { checkPrerequisites } from '../daemon/ops/prerequisites.ts';
import { ZERO_TOKENS } from '../daemon/usage/usageMeter.ts';
import { makeAgent, tempDir } from './helpers.ts';

const usage = (output: number, costUsd?: number): AgentUsage => ({ tokens: { ...ZERO_TOKENS, output }, ...(costUsd !== undefined ? { costUsd } : {}) });

describe('usage ledger', () => {
  it('adds only what was spent since the last record, and survives a re-read', () => {
    const store = new TowerStore(':memory:');
    const now = new Date(2026, 9, 3, 12).getTime();
    const managed = (u: AgentUsage) => makeAgent({ tier: 'A', usage: u });
    store.recordUsage(managed(usage(100, 1)), now);
    store.recordUsage(managed(usage(100, 1)), now);
    store.recordUsage(managed(usage(150, 1.5)), now);
    const summary = store.usageSummary(7, now);
    expect(summary.today).toEqual({ tokens: 150, costUsd: 1.5 });
    expect(summary.byAgent[0]).toMatchObject({ name: 'Test agent', tokens: 150, priced: true });
  });

  it('does not book an observed session\'s earlier history, and ignores a partial (smaller) read', () => {
    const store = new TowerStore(':memory:');
    const now = new Date(2026, 9, 3, 12).getTime();
    store.recordUsage(makeAgent({ usage: usage(10_000, 40) }), now); // first sight: baseline only
    store.recordUsage(makeAgent({ usage: usage(300, 1) }), now); // a tail-only read: nothing booked
    store.recordUsage(makeAgent({ usage: usage(10_500, 42) }), now); // real new work
    expect(store.usageSummary(7, now).today).toEqual({ tokens: 500, costUsd: 2 });
  });

  it('starts a fresh baseline when a tower-launched agent restarts from zero, and splits by day', () => {
    const store = new TowerStore(':memory:');
    const day1 = new Date(2026, 9, 2, 12).getTime();
    const day2 = new Date(2026, 9, 3, 12).getTime();
    store.recordUsage(makeAgent({ tier: 'A', usage: usage(500) }), day1);
    store.recordUsage(makeAgent({ tier: 'A', usage: usage(20) }), day2);
    const summary = store.usageSummary(7, day2);
    expect(summary.byDay).toEqual([
      { day: localDay(day1), tokens: 500, costUsd: 0 },
      { day: localDay(day2), tokens: 20, costUsd: 0 },
    ]);
    expect(summary.byAgent[0].priced).toBe(false);
  });
});

describe('schedules', () => {
  const at = (h: number, m: number, day = 3) => new Date(2026, 9, day, h, m).getTime(); // Oct 3 2026 is a Saturday
  const fields = validateScheduleFields({ label: 'Nightly', time: '09:00', days: [6, 6, 1] });

  it('validates fields', () => {
    expect(fields).toEqual({ label: 'Nightly', enabled: true, days: [1, 6], time: '09:00' });
    expect(() => validateScheduleFields({ label: 'x', time: '9am', days: [1] })).toThrow(/HH:MM/);
    expect(() => validateScheduleFields({ label: 'x', time: '09:00', days: [] })).toThrow(/weekday/);
    expect(() => validateScheduleFields({ label: 'x', time: '09:00', days: [7] })).toThrow(/weekday/);
  });

  it('is due once, inside the catch-up window, and never for a slot before it was created', () => {
    const launch = { vendor: 'claude' as const, cwd: 'C:\\w', prompt: 'p' };
    const schedule = newSchedule(fields, launch, at(8, 0));
    expect(dueSlot(schedule, at(8, 59))).toBeUndefined();
    expect(dueSlot(schedule, at(9, 1))).toBe(at(9, 0));
    expect(dueSlot({ ...schedule, lastRunAt: at(9, 1) }, at(9, 2))).toBeUndefined();
    expect(dueSlot(schedule, at(9, 0) + CATCH_UP_MS)).toBeUndefined();
    expect(dueSlot(newSchedule(fields, launch, at(9, 5)), at(9, 6))).toBeUndefined();
    expect(dueSlot({ ...schedule, enabled: false }, at(9, 1))).toBeUndefined();
    expect(dueSlot(schedule, at(9, 1, 4))).toBeUndefined(); // Sunday is not chosen
  });

  it('catches up a slot just before midnight after the date has changed', () => {
    const late = newSchedule(validateScheduleFields({ label: 'Late', time: '23:58', days: [6] }), { vendor: 'claude', cwd: 'C:\\w', prompt: 'p' }, at(8, 0));
    expect(dueSlot(late, at(0, 3, 4))).toBe(at(23, 58)); // Sunday 00:03, Saturday's slot
    expect(dueSlot(late, at(0, 9, 4))).toBeUndefined();
  });

  it('finds the next run', () => {
    const schedule = newSchedule(fields, { vendor: 'claude', cwd: 'C:\\w', prompt: 'p' }, at(8, 0));
    expect(nextRun(schedule, at(8, 0))).toBe(at(9, 0));
    expect(nextRun(schedule, at(10, 0))).toBe(at(9, 0, 5)); // Monday the 5th
  });
});

describe('templates and prerequisites', () => {
  it('validates a template', () => {
    expect(validateTemplate({ label: ' Reviewer ', vendor: 'codex', model: 'gpt-6.1-sol', intercept: true }))
      .toMatchObject({ label: 'Reviewer', vendor: 'codex', model: 'gpt-6.1-sol', intercept: false });
    expect(() => validateTemplate({ label: '', vendor: 'claude' })).toThrow(OpsInputError);
    expect(() => validateTemplate({ label: 'x', vendor: 'claude', model: '-c x' })).toThrow(/model/);
  });

  it('reports what is missing without changing anything', () => {
    const results = checkPrerequisites({
      nodeVersion: 'v24.1.0', claudeExe: () => 'C:\\claude.exe', codexEntry: () => undefined, hooksInstalled: () => false,
      run: (command) => (command === 'git' ? 'git version 2.50' : undefined),
    });
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId.node.ok).toBe(true);
    expect(byId.git).toMatchObject({ ok: true, detail: 'git version 2.50' });
    expect(byId.codex.ok).toBe(false);
    expect(byId.terminal.ok).toBe(false);
    expect(byId.hooks.ok).toBe(false);
  });
});

class FakeRunner implements ManagedRunner {
  status: Agent['status'] = 'busy';
  constructor(readonly id: string, readonly sessionId: string | undefined, readonly launch: ManagedLaunch) {}
  snapshot(): Agent {
    return makeAgent({ id: this.id, tier: 'A', status: this.status, name: this.launch.name ?? 'managed', model: this.launch.model });
  }
  async send(): Promise<void> {}
  async interrupt(): Promise<void> {}
  setIntercepting(): void {}
  async stop(): Promise<void> {
    this.status = 'stopped';
  }
}

function setup(overrides: Partial<AgentOpsDeps> = {}) {
  const registry = new AgentRegistry();
  const store = new TowerStore(':memory:');
  const runners = new Map<string, FakeRunner>();
  const launches: ManagedLaunch[] = [];
  const managed = {
    get: (id: string) => runners.get(id),
    launchOf: (id: string) => runners.get(id)?.launch,
    launch: (launch: ManagedLaunch) => {
      launches.push(launch);
      const runner = new FakeRunner(launch.agentId ?? 'managed:new', launch.resumeSessionId, launch);
      runners.set(runner.id, runner);
      return runner;
    },
  } as unknown as ManagedAgents;
  const deps: AgentOpsDeps = {
    registry, store, managed,
    isTeamMember: () => false,
    launch: vi.fn((raw: unknown) => makeAgent({ name: (raw as { name: string }).name })),
    instruct: vi.fn(async () => 'Sent.'),
    setIntercept: vi.fn(),
    interrupt: vi.fn(async () => undefined),
    stopAgent: vi.fn(async () => undefined),
    probes: { nodeVersion: 'v24.0.0', claudeExe: () => undefined, codexEntry: () => undefined, hooksInstalled: () => true },
    breaker: { ...DEFAULT_BREAKER, repeatLimit: 2 },
    ...overrides,
  };
  return { ops: new AgentOps(deps), deps, registry, store, runners, launches };
}

describe('AgentOps', () => {
  it('renames an agent, keeps the name across a restart of the tower, and clears it', () => {
    const { ops, registry, store } = setup();
    registry.upsert('test', makeAgent());
    const id = makeAgent().id;
    expect(ops.renameAgent(id, '  Bug hunter ')).toBe('Bug hunter');
    expect(registry.get(id)?.name).toBe('Bug hunter');
    expect(store.agentNames().get(id)).toBe('Bug hunter');
    const fresh = new AgentOps({ ...setup().deps, registry, store });
    fresh.start();
    fresh.stop();
    expect(registry.get(id)?.name).toBe('Bug hunter');
    ops.renameAgent(id, '');
    expect(registry.get(id)?.name).toBe('Test agent');
    expect(() => ops.renameAgent('nope', 'x')).toThrow(/not found/);
  });

  it('restarts a managed agent on the same session and id, optionally on a new model', async () => {
    const { ops, runners, launches } = setup();
    const launch: ManagedLaunch = { vendor: 'claude', cwd: 'C:\\w', prompt: 'first', name: 'Fixer', model: 'claude-sonnet-5-5' };
    const old = new FakeRunner('managed:1', 'sess-1', launch);
    runners.set(old.id, old);
    const agent = await ops.restartAgent('managed:1', { model: 'claude-opus-5-5' });
    expect(old.status).toBe('stopped');
    expect(launches[0]).toMatchObject({ agentId: 'managed:1', resumeSessionId: 'sess-1', fork: false, model: 'claude-opus-5-5', name: 'Fixer' });
    expect(launches[0].prompt).toMatch(/Continue where you left off/);
    expect(agent.id).toBe('managed:1');
  });

  it('refuses to restart what it cannot continue', async () => {
    const { ops, runners } = setup({ isTeamMember: (id) => id === 'managed:team' });
    const launch: ManagedLaunch = { vendor: 'claude', cwd: 'C:\\w', prompt: 'x' };
    runners.set('managed:nosession', new FakeRunner('managed:nosession', undefined, launch));
    runners.set('managed:team', new FakeRunner('managed:team', 's', launch));
    await expect(ops.restartAgent('claude:observed', {})).rejects.toThrow(/launched from the tower/);
    await expect(ops.restartAgent('managed:nosession', {})).rejects.toThrow(/no conversation/);
    await expect(ops.restartAgent('managed:team', {})).rejects.toThrow(/team/);
  });

  it('steers a looping agent, then constrains it, and the operator can clear it', async () => {
    const { ops, deps, registry } = setup();
    const agent = makeAgent();
    registry.upsert('test', agent);
    const loop = () => {
      for (let i = 0; i < 2; i++) ops.onEvent({ agentId: agent.id, ts: Date.now(), kind: 'tool_call', summary: 'Bash: npm test' });
    };
    loop();
    await vi.waitFor(() => expect(deps.instruct).toHaveBeenCalledWith(agent.id, expect.stringMatching(/runaway guard noticed/)));
    expect(registry.get(agent.id)?.breaker?.level).toBe('warned');
    loop();
    await vi.waitFor(() => expect(deps.setIntercept).toHaveBeenCalledWith(agent.id, true));
    expect(registry.get(agent.id)?.breaker?.level).toBe('constrained');
    ops.resetBreaker(agent.id);
    expect(registry.get(agent.id)?.breaker).toBeUndefined();
  });

  it('saves templates, and runs due schedules once, recording the result', async () => {
    const { ops, deps, store } = setup();
    const template = ops.createTemplate({ label: 'Reviewer', vendor: 'claude', model: 'claude-haiku-4-5' });
    expect(ops.templates()).toEqual([template]);
    ops.deleteTemplate(template.id);
    expect(ops.templates()).toEqual([]);
    expect(() => ops.deleteTemplate(template.id)).toThrow(/not found/);

    const cwd = tempDir();
    const schedule = ops.createSchedule({ label: 'Daily', time: '00:00', days: [0, 1, 2, 3, 4, 5, 6], launch: { vendor: 'claude', cwd, prompt: 'go' } });
    expect(() => ops.createSchedule({ label: 'Bad', time: '00:00', days: [1], launch: { vendor: 'claude', cwd: 'C:\\missing\\x', prompt: 'go' } }))
      .toThrow(OpsInputError);
    const slot = new Date();
    slot.setHours(0, 0, 0, 0);
    // Pretend it was created before today's midnight slot.
    store.saveRecord('schedules', { ...schedule, createdAt: slot.getTime() - 1000 });
    await ops.runDueSchedules(slot.getTime() + 1000);
    await ops.runDueSchedules(slot.getTime() + 2000);
    expect(deps.launch).toHaveBeenCalledTimes(1);
    expect(ops.schedules()[0]).toMatchObject({ lastResult: 'Launched Daily' });
  });
});

describe('AgentOps schedules with resources and notifications', () => {
  const notifier = () => ({ send: vi.fn(async (ids: readonly string[]) => ids.map((channelId) => ({ channelId, ok: true }))) });
  const body = (cwd: string, extra: Record<string, unknown> = {}) => ({
    label: 'Sync', time: '09:00', days: [1], launch: { vendor: 'claude', cwd, prompt: 'Check for updates.' }, ...extra,
  });

  it('creates with resources, notify and loadout, and keeps old records working', () => {
    const resourcesDir = tempDir('res-');
    const { ops, store } = setup({ resourcesDir });
    const cwd = tempDir();
    const schedule = ops.createSchedule(body(cwd, {
      resources: [{ kind: 'github', value: 'https://github.com/octo/hello' }, { kind: 'folder', value: cwd }],
      notify: { channelIds: ['slack1'], when: 'failure' },
      stopWhenDone: false,
      maxMinutes: 15,
      launch: { vendor: 'claude', cwd, prompt: 'p', loadout: { skillIds: ['s1'] } },
    }));
    expect(schedule).toMatchObject({ stopWhenDone: false, maxMinutes: 15, notify: { channelIds: ['slack1'], when: 'failure' } });
    expect(schedule.resources.map((r) => r.value)).toEqual(['octo/hello', cwd]);
    expect(schedule.launch.loadout).toEqual({ skillIds: ['s1'] });
    expect(() => ops.createSchedule(body(cwd, { launch: { vendor: 'claude', cwd, prompt: 'p', loadout: { skillIds: 'x' } } }))).toThrow(OpsInputError);
    expect(() => ops.createSchedule(body(cwd, { resources: [{ kind: 'url', value: 'file:///x' }] }))).toThrow(OpsInputError);
    expect(() => ops.createSchedule(body(cwd, { maxMinutes: 601 }))).toThrow(/600/);

    store.saveRecord('schedules', { id: 'sch_0ld00000', label: 'Old', enabled: true, days: [1], time: '09:00', launch: { vendor: 'claude', cwd, prompt: 'p' }, createdAt: 1 });
    expect(ops.schedules().find((s) => s.id === 'sch_0ld00000')).toMatchObject({ resources: [], stopWhenDone: true, maxMinutes: 60 });
  });

  it('edits a schedule, keeping id, createdAt and run history', () => {
    const { ops, store } = setup({ resourcesDir: tempDir('res-') });
    const cwd = tempDir();
    const created = ops.createSchedule(body(cwd));
    store.saveRecord('schedules', { ...ops.schedules()[0], lastRunAt: 5, lastResult: 'Launched Sync', nextRunAt: undefined });
    const edited = ops.updateSchedule(created.id, body(cwd, { label: 'Renamed', resources: [{ kind: 'note', value: 'hi' }] }));
    expect(edited).toMatchObject({ id: created.id, createdAt: created.createdAt, label: 'Renamed', lastRunAt: 5, lastResult: 'Launched Sync' });
    expect(edited.resources).toHaveLength(1);
    expect(() => ops.updateSchedule('sch_nope0000', body(cwd))).toThrow(/not found/);
  });

  it('uploads a file resource and removes the folder when the schedule is deleted', () => {
    const resourcesDir = tempDir('res-');
    const { ops } = setup({ resourcesDir });
    const created = ops.createSchedule(body(tempDir()));
    const updated = ops.uploadScheduleResource(created.id, { filename: '../feed.json', contentBase64: Buffer.from('{}').toString('base64') });
    expect(updated.resources[0]).toMatchObject({ kind: 'file', value: join(resourcesDir, created.id, 'feed.json') });
    expect(existsSync(updated.resources[0].value)).toBe(true);
    expect(() => ops.uploadScheduleResource(created.id, { filename: 'x', contentBase64: '!!' })).toThrow(/base64/);
    ops.deleteSchedule(created.id);
    expect(existsSync(join(resourcesDir, created.id))).toBe(false);
  });

  it('fires with the composed prompt and loadout, then reports the run when the agent goes idle', async () => {
    const send = notifier();
    let now = 1_000;
    const { ops, deps, registry } = setup({ resourcesDir: tempDir('res-'), notifier: send, now: () => now });
    (deps.launch as ReturnType<typeof vi.fn>).mockImplementation((raw: unknown) => makeAgent({ id: 'managed:s1', tier: 'A', name: (raw as { name: string }).name }));
    const created = ops.createSchedule(body(tempDir(), {
      resources: [{ kind: 'url', value: 'https://example.com/news' }],
      notify: { channelIds: ['slack1'], when: 'always' },
    }));
    ops.start();
    const agent = ops.runScheduleNow(created.id);
    const launched = (deps.launch as ReturnType<typeof vi.fn>).mock.calls[0][0] as { prompt: string; name: string; loadout: unknown };
    expect(launched.prompt).toContain('## Resources for this task');
    expect(launched.prompt).toContain('https://example.com/news');
    expect(launched.loadout).toEqual({ notifyChannelIds: ['inbox'] });
    expect(ops.schedules()[0]).toMatchObject({ lastRunAgentId: agent.id, runs: [{ agentId: agent.id, startedAt: 1_000 }] });

    registry.upsert('managed', makeAgent({ id: agent.id, tier: 'A', status: 'busy' }));
    registry.pushEvent({ agentId: agent.id, ts: 2, kind: 'assistant', summary: 'Two new posts about the release.' });
    now += 3 * 60_000;
    registry.upsert('managed', makeAgent({ id: agent.id, tier: 'A', status: 'idle' }));
    await vi.waitFor(() => expect(send.send).toHaveBeenCalledTimes(1));
    await ops.runs.check();
    ops.stop();
    expect(send.send).toHaveBeenCalledWith(['slack1'], expect.objectContaining({ title: 'Sync: finished', body: expect.stringContaining('Two new posts') }));
    expect(deps.stopAgent).toHaveBeenCalledWith(agent.id);
    expect(ops.schedules()[0].lastResult).toBe('Finished in 3m · notified inbox + 1 channel');
    expect(ops.scheduleRuns(created.id)[0]).toMatchObject({ outcome: 'finished' });
  });

  it('notifies when the launch itself fails', async () => {
    const send = notifier();
    const { ops, deps } = setup({ resourcesDir: tempDir('res-'), notifier: send });
    (deps.launch as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('no claude'); });
    const created = ops.createSchedule(body(tempDir(), { notify: { channelIds: [], when: 'failure' } }));
    expect(() => ops.runScheduleNow(created.id)).toThrow(/no claude/);
    await vi.waitFor(() => expect(send.send).toHaveBeenCalledWith([], expect.objectContaining({ title: 'Sync: failed', level: 'error' })));
    expect(ops.schedules()[0].lastResult).toBe('Failed: no claude');
  });
});
