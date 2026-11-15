import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FactoryEngine, factoryDefaults, type FactoryHost } from '../daemon/factory/engine.ts';
import { TowerStore } from '../daemon/store/db.ts';
import type { FactoryItem, FactoryEvidence } from '../shared/factory.ts';
import type { Agent, AgentEvent } from '../daemon/domain/types.ts';
import { git, GIT_TEST_IDENTITY, makeAgent, makeRepo, tempDir } from './helpers.ts';
import * as workspace from '../daemon/factory/workspace.ts';

const active: { engine: FactoryEngine; store: TowerStore }[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const entry of active.splice(0)) { await entry.engine.shutdown(); entry.store.close(); } });
function harness(options: { plan?: boolean; review?: boolean; repairs?: number; failChecks?: boolean; throwLaunch?: boolean; database?: string } = {}) {
  const repository = makeRepo(); const root = tempDir('factory-work-');
  const store = new TowerStore(options.database ?? ':memory:'); const agents = new Map<string, Agent>(); const events = new Map<string, AgentEvent[]>();
  let seq = 0;
  const host: FactoryHost = {
    launch: vi.fn(input => { if (options.throwLaunch) throw new Error('Provider unavailable'); const agent = makeAgent({ id: `managed:factory-${++seq}`, tier: 'A', status: 'busy', cwd: input.cwd }); agents.set(agent.id, agent); return agent; }),
    agent: id => agents.get(id), events: id => events.get(id) ?? [],
    stop: vi.fn(async id => { const agent = agents.get(id); if (agent) agents.set(id, { ...agent, status: 'stopped' }); }),
  };
  const check = vi.fn(async (check, _cwd, revision): Promise<FactoryEvidence> => ({ id: `check-${Math.random()}`, name: check.name, command: check.command, revision,
    outcome: options.failChecks ? 'failed' : 'passed', output: options.failChecks ? 'Regression failed' : 'Verified behavior', startedAt: Date.now(), finishedAt: Date.now() }));
  const engine = new FactoryEngine(store, host, root, check); active.push({ engine, store });
  const defaults = factoryDefaults();
  const definition = engine.saveDefinition({ name: 'Test factory', repository, ...defaults, workflow: { ...defaults.workflow, requirePlan: options.plan ?? true, review: options.review ?? false, maxRepairs: options.repairs ?? 0, checks: [{ name: 'Behavior', command: 'node verify.cjs' }] } });
  const item = engine.createItem({ factoryId: definition.id, title: 'Improve behavior', request: 'Implement a scoped behavior', criteria: 'The observable behavior meets the request' });
  const current = () => engine.snapshot().items.find(entry => entry.id === item.id)!;
  const finish = async (output = 'Concrete implementation plan with acceptance checks') => {
    const id = current().attempts.at(-1)!.agentId!; agents.set(id, { ...agents.get(id)!, status: 'idle' });
    events.set(id, [{ agentId: id, kind: 'assistant', summary: output, ts: Date.now() }]); await engine.tick();
  };
  const until = async (status: FactoryItem['status']) => {
    const deadline = Date.now() + 4000;
    while (current().status !== status) { if (Date.now() > deadline) throw new Error(`Expected ${status}, got ${current().status}: ${current().reason}`); await new Promise(resolve => setTimeout(resolve, 10)); }
    return current();
  };
  const built = async () => { await engine.action(item.id, 'start'); if (options.plan ?? true) { await finish(); await engine.action(item.id, 'approve-plan'); } writeFileSync(join(current().workspace!, 'feature.txt'), 'implemented\n'); await finish('Implemented feature'); return until(options.review ? 'reviewing' : options.failChecks ? (options.repairs ? 'building' : 'blocked') : 'acceptance'); };
  return { engine, store, agents, host, check, repository, root, definition, item, current, finish, until, built };
}

describe('factory configuration and inputs', () => {
  it('snapshots configuration and prevents concurrent configuration overwrites', () => {
    const h = harness(); const updated = h.engine.saveDefinition({ ...h.definition, name: 'Changed defaults' }, h.definition.id);
    expect(updated.revision).toBe(2); expect(h.current().definition.name).toBe('Test factory');
    expect(() => h.engine.saveDefinition(h.definition, h.definition.id)).toThrow(/changed elsewhere/);
    updated.roles.builder.instructions = 'mutated client'; expect(h.engine.snapshot().factories[0].roles.builder.instructions).not.toBe('mutated client');
  });
  it('rejects missing criteria, invalid models, invalid limits and unknown factories', () => {
    const h = harness();
    expect(() => h.engine.createItem({ factoryId: h.definition.id, title: 'A', request: 'B', criteria: '' })).toThrow(/Acceptance criteria/);
    expect(() => h.engine.createItem({ factoryId: 'missing' })).toThrow(/Choose a factory/);
    expect(() => h.engine.saveDefinition({ ...h.definition, workflow: { ...h.definition.workflow, maxRepairs: 9 } }, h.definition.id)).toThrow(/between/);
    expect(() => h.engine.saveDefinition({ ...h.definition, roles: { ...h.definition.roles, builder: { vendor: 'codex', model: '--bad', instructions: '' } } }, h.definition.id)).toThrow(/Model/);
    expect(() => h.engine.saveDefinition({ ...h.definition, workflow: { ...h.definition.workflow, requirePlan: 'false' } }, h.definition.id)).toThrow(/true or false/);
  });
  it('requires actual checks before starting and refuses invalid transitions', async () => {
    const h = harness(); const definition = h.engine.saveDefinition({ ...h.definition, workflow: { ...h.definition.workflow, checks: [] } }, h.definition.id);
    const item = h.engine.createItem({ factoryId: definition.id, title: 'No checks', request: 'Do work', criteria: 'Defined behavior' });
    await expect(h.engine.action(item.id, 'start')).rejects.toThrow(/at least one/);
    await expect(h.engine.action(h.item.id, 'accept')).rejects.toThrow(/not ready/);
    await expect(h.engine.action(h.item.id, 'approve-plan')).rejects.toThrow(/no plan/);
    await expect(h.engine.action(h.item.id, 'merge')).rejects.toThrow(/Accept/);
    await expect(h.engine.action('missing', 'start')).rejects.toThrow(/not found/);
    await expect(h.engine.action(h.item.id, 'unknown')).rejects.toThrow(/Unknown/);
  });
});
describe('factory execution with real Git worktrees', () => {
  it('isolates work, waits for plan approval and never accepts a team or agent completion as evidence', async () => {
    const h = harness(); await h.engine.action(h.item.id, 'start');
    expect(h.current().status).toBe('planning'); expect(h.host.launch).toHaveBeenCalledTimes(1);
    expect(h.current().workspace).not.toBe(h.repository);
    await h.finish(); expect(h.current().status).toBe('plan_review'); expect(h.check).not.toHaveBeenCalled();
    await h.engine.tick(); expect(h.host.launch).toHaveBeenCalledTimes(1);
    await h.engine.action(h.item.id, 'approve-plan'); expect(h.current().status).toBe('building');
    writeFileSync(join(h.current().workspace!, 'app.txt'), 'isolated'); expect(readFileSync(join(h.repository, 'app.txt'), 'utf8')).toContain('hello');
    await expect(h.engine.action(h.item.id, 'accept')).rejects.toThrow();
  });
  it('can start directly with the builder when planning is disabled', async () => {
    const h = harness({ plan: false }); await h.engine.action(h.item.id, 'start');
    expect(h.current().status).toBe('building'); expect(h.current().attempts[0].stage).toBe('builder');
  });
  it('runs checks on the committed candidate and exposes a real diff', async () => {
    const h = harness(); const item = await h.built();
    expect(item.evidence[0].revision).toBe(item.candidate); expect(git(item.workspace!, 'rev-parse', 'HEAD')).toBe(item.candidate);
    expect((await h.engine.diff(item.id)).patch).toContain('+implemented'); expect(item.status).toBe('acceptance');
    expect(item.validation).toMatchObject({ revision: item.candidate, outcome: 'passed' });
    expect(item.validation?.finishedAt).toBeGreaterThanOrEqual(item.validation!.startedAt);
    expect(item.validation?.currentCheck).toBeUndefined();
  });
  it('runs the optional reviewer and preserves its advisory findings', async () => {
    const h = harness({ review: true }); await h.built(); expect(h.current().status).toBe('reviewing');
    await h.finish('Finding: validate this acceptance scenario manually.');
    expect(h.current().status).toBe('acceptance'); expect(h.current().attempts.at(-1)?.output).toContain('manually');
  });
  it('requires revalidation if a reviewer modifies the candidate', async () => {
    const h = harness({ review: true }); await h.built(); writeFileSync(join(h.current().workspace!, 'feature.txt'), 'reviewer modified'); await h.finish('Reviewed');
    expect(h.current().status).toBe('blocked'); expect(h.current().reason).toMatch(/reviewer changed/);
    expect(h.current().validation?.outcome).toBe('invalidated');
  });
  it('accepts and merges only after passing evidence and explicit decisions', async () => {
    const h = harness(); await h.built(); await h.engine.action(h.item.id, 'accept');
    expect(h.current().acceptedRevision).toBe(h.current().candidate);
    await h.engine.action(h.item.id, 'merge'); expect(h.current().status).toBe('delivered');
    expect(readFileSync(join(h.repository, 'feature.txt'), 'utf8')).toContain('implemented');
    expect(h.current().activity.some(event => event.message.includes('accepted'))).toBe(true);
  });
  it('invalidates acceptance when the candidate changes after checks', async () => {
    const h = harness(); await h.built(); await h.engine.action(h.item.id, 'accept');
    writeFileSync(join(h.current().workspace!, 'feature.txt'), 'changed after approval');
    await expect(h.engine.action(h.item.id, 'merge')).rejects.toThrow(/changed after validation/);
    expect(h.current().status).toBe('blocked'); expect(h.current().acceptedRevision).toBeUndefined();
    expect(h.current().validation?.outcome).toBe('invalidated');
  });
  it('refuses a moved target branch and leaves the project intact', async () => {
    const h = harness(); await h.built(); await h.engine.action(h.item.id, 'accept');
    writeFileSync(join(h.repository, 'human.txt'), 'human work'); git(h.repository, 'add', '-A'); git(h.repository, ...GIT_TEST_IDENTITY, 'commit', '-m', 'human change');
    const head = git(h.repository, 'rev-parse', 'HEAD');
    await expect(h.engine.action(h.item.id, 'merge')).rejects.toThrow(/target branch moved/);
    expect(git(h.repository, 'rev-parse', 'HEAD')).toBe(head);
  });
  it('refuses a dirty target checkout', async () => {
    const h = harness(); await h.built(); await h.engine.action(h.item.id, 'accept'); writeFileSync(join(h.repository, 'app.txt'), 'unsaved');
    await expect(h.engine.action(h.item.id, 'merge')).rejects.toThrow(/uncommitted changes/);
  });
  it('delivery merges the accepted commit without snapshotting later worktree edits', async () => {
    const h = harness(); const item = await h.built();
    writeFileSync(join(item.workspace!, 'feature.txt'), 'late unvalidated edits');
    await workspace.deliverFactoryWorkspace(h.repository, item.branch!, item.baseBranch!, item.baseCommit!, item.candidate!);
    expect(readFileSync(join(h.repository, 'feature.txt'), 'utf8')).toContain('implemented');
    expect(readFileSync(join(item.workspace!, 'feature.txt'), 'utf8')).toBe('late unvalidated edits');
  });
  it('revalidates changes and records a new candidate before acceptance', async () => {
    const h = harness(); await h.built(); const old = h.current().candidate;
    writeFileSync(join(h.current().workspace!, 'feature.txt'), 'revised'); await h.engine.action(h.item.id, 'validate'); await h.until('acceptance');
    expect(h.current().candidate).not.toBe(old); expect(h.current().evidence.every(result => result.revision === h.current().candidate)).toBe(true);
  });
});
describe('failure, pause and recovery', () => {
  it('persists the current check and interrupted validation stage without inventing completion', async () => {
    const h = harness({ plan: false }); let release!: (result: FactoryEvidence) => void;
    h.check.mockImplementation((check, _cwd, revision) => new Promise(resolve => { release = resolve; }));
    await h.engine.action(h.item.id, 'start'); writeFileSync(join(h.current().workspace!, 'feature.txt'), 'implemented'); await h.finish('Implemented');
    const running = h.current(); expect(running.status).toBe('validating');
    expect(running.validation?.outcome).toBe('running'); expect(running.validation?.currentCheck?.name).toBe('Behavior'); expect(running.evidence).toHaveLength(0);
    await h.engine.action(h.item.id, 'pause'); const paused = h.current();
    expect(paused.suspendedStage).toBe('validating'); expect(paused.validation?.outcome).toBe('interrupted'); expect(paused.validation?.finishedAt).toBeDefined();
    release({ id: 'late', name: 'Behavior', command: 'node verify.cjs', revision: running.candidate!, outcome: 'passed', output: 'late result', startedAt: 1, finishedAt: 2 });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(h.current().status).toBe('paused'); expect(h.current().evidence).toHaveLength(0);
  });
  it('cannot launch a reviewer after a pause during the final revision check', async () => {
    const h = harness({ plan: false, review: true });
    let reached!: () => void; const checking = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(workspace, 'factoryWorkspaceMatches').mockImplementation(async () => { reached(); await gate; return true; });
    await h.engine.action(h.item.id, 'start'); writeFileSync(join(h.current().workspace!, 'feature.txt'), 'implemented');
    await h.finish('Implemented'); await checking;
    await h.engine.action(h.item.id, 'pause'); release(); await new Promise(resolve => setTimeout(resolve, 30));
    expect(h.current().status).toBe('paused'); expect(h.current().attempts.some(attempt => attempt.stage === 'reviewer')).toBe(false);
  });
  it('repairs failing checks only within the configured budget', async () => {
    const h = harness({ failChecks: true, repairs: 1 }); await h.built(); expect(h.current().repairs).toBe(1);
    await h.finish('Attempted repair'); await h.until('blocked'); expect(h.current().reason).toContain('budget is exhausted');
    expect(h.current().validationHistory?.[0][0].outcome).toBe('failed');
    expect(h.current().attempts.filter(attempt => attempt.stage === 'builder')).toHaveLength(2);
    await expect(h.engine.action(h.item.id, 'accept')).rejects.toThrow();
  });
  it('reports launch failures and allows explicit retry', async () => {
    const h = harness({ throwLaunch: true }); await h.engine.action(h.item.id, 'start');
    expect(h.current().status).toBe('blocked'); expect(h.current().reason).toContain('Provider unavailable');
    await h.engine.action(h.item.id, 'resume'); expect(h.current().attempts).toHaveLength(2);
  });
  it('pauses an agent, resumes without bypassing approval, and cancels permanently', async () => {
    const h = harness(); await h.engine.action(h.item.id, 'start'); await h.finish(); await h.engine.action(h.item.id, 'pause');
    expect(h.current().status).toBe('paused'); await h.engine.action(h.item.id, 'resume'); expect(h.current().status).toBe('plan_review');
    await expect(h.engine.action(h.item.id, 'validate')).rejects.toThrow();
    await h.engine.action(h.item.id, 'cancel'); expect(h.current().status).toBe('cancelled');
    await expect(h.engine.action(h.item.id, 'resume')).rejects.toThrow();
  });
  it('times out a busy agent and stops its execution', async () => {
    const h = harness(); await h.engine.action(h.item.id, 'start'); const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 121 * 60_000); await h.engine.tick();
    expect(h.current().status).toBe('blocked'); expect(h.current().reason).toMatch(/time limit/); expect(h.host.stop).toHaveBeenCalled();
  });
  it('recovers an active run from SQLite as paused and preserves its configuration and workspace', async () => {
    const database = join(tempDir('factory-db-'), 'state.db'); const h = harness({ database }); await h.engine.action(h.item.id, 'start');
    const secondStore = new TowerStore(database); const restored = new FactoryEngine(secondStore, h.host, h.root);
    active.push({ engine: restored, store: secondStore }); const item = restored.snapshot().items[0];
    expect(item.status).toBe('paused'); expect(item.workspace).toBe(h.current().workspace); expect(item.attempts[0].outcome).toBe('interrupted');
    expect(item.suspendedStage).toBe('planning');
    expect(item.definition.revision).toBe(1); expect(h.host.launch).toHaveBeenCalledTimes(1);
  });
  it('rejects an empty planner result instead of silently building', async () => {
    const h = harness(); await h.engine.action(h.item.id, 'start'); await h.finish('');
    expect(h.current().status).toBe('blocked'); expect(h.current().reason).toMatch(/no plan/);
  });
});

describe('factory waits for spend and quota', () => {
  it('pauses a stage instead of launching while the gate is closed, then starts it on its own', async () => {
    const h = harness({ plan: false });
    let blocked: string | undefined = 'Claude 5-hour window is at 96%.';
    h.host.gate = vi.fn(async () => blocked);
    await h.engine.action(h.item.id, 'start');
    expect(h.host.launch).not.toHaveBeenCalled();
    expect(h.current()).toMatchObject({ status: 'paused', waiting: { stageId: 'build' } });
    expect(h.current().reason).toMatch(/96%.*starts automatically/);
    await h.engine.tick(Number.MAX_SAFE_INTEGER);
    expect(h.host.launch).not.toHaveBeenCalled();
    blocked = undefined;
    await h.engine.tick(Number.MAX_SAFE_INTEGER);
    expect(h.host.launch).toHaveBeenCalledTimes(1);
    expect(h.current()).toMatchObject({ status: 'building' });
    expect(h.current().waiting).toBeUndefined();
  });

  it('stays paused when the operator pauses or cancels a waiting item', async () => {
    const h = harness({ plan: false });
    h.host.gate = vi.fn(async () => 'Spend cap: All agents spent about $12.00 today, over the $10.00 daily cap.');
    await h.engine.action(h.item.id, 'start');
    await h.engine.action(h.item.id, 'pause');
    expect(h.current().waiting).toBeUndefined();
    h.host.gate = vi.fn(async () => undefined);
    await h.engine.tick(Number.MAX_SAFE_INTEGER);
    expect(h.host.launch).not.toHaveBeenCalled();
    expect(h.current().status).toBe('paused');
  });
});
