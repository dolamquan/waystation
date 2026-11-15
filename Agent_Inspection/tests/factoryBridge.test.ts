import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FACTORY_TOKEN_ENV, FactoryGrants, parseSubmission, renderSubmission, toolsFor } from '../daemon/factory/bridge.ts';
import { FactoryEngine, factoryDefaults, type FactoryHost } from '../daemon/factory/engine.ts';
import { TowerStore } from '../daemon/store/db.ts';
import type { Agent, AgentEvent } from '../daemon/domain/types.ts';
import type { ManagedLaunch } from '../daemon/managed/types.ts';
import type { FactoryEvidence } from '../shared/factory.ts';
import { makeAgent, makeRepo, tempDir } from './helpers.ts';

describe('factory grants', () => {
  it('issues one token per attempt, finds it, and revokes it', () => {
    const grants = new FactoryGrants();
    const token = grants.issue({ itemId: 'i1', attemptId: 'a1', role: 'planner' });
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(grants.find(token)).toMatchObject({ itemId: 'i1', attemptId: 'a1', role: 'planner' });
    expect(grants.find('wrong')).toBeUndefined(); expect(grants.find(undefined)).toBeUndefined();
    grants.revoke('a1'); expect(grants.find(token)).toBeUndefined();
  });
});

describe('submission parsing', () => {
  it('offers exactly one submit tool per role', () => {
    expect(toolsFor('planner').map(tool => tool.name)).toEqual(['submit_plan']);
    expect(toolsFor('builder').map(tool => tool.name)).toEqual(['submit_result']);
    expect(toolsFor('reviewer').map(tool => tool.name)).toEqual(['submit_review']);
  });
  it('accepts a valid review and trims its fields', () => {
    const submission = parseSubmission('reviewer', 'submit_review', { summary: ' Two issues ', details: 'Body', findings: [{ severity: 'blocker', text: 'Crash on empty input', file: 'src/a.ts' }, { severity: 'minor', text: 'Typo' }] });
    expect(submission).toMatchObject({ tool: 'submit_review', summary: 'Two issues', body: 'Body', findings: [{ severity: 'blocker', text: 'Crash on empty input', file: 'src/a.ts' }, { severity: 'minor', text: 'Typo' }] });
  });
  it.each([
    ['a tool from another role', 'planner', 'submit_review', { summary: 'x', plan: 'y' }, /not available/],
    ['a missing summary', 'planner', 'submit_plan', { plan: 'Steps' }, /Summary/],
    ['an empty plan', 'planner', 'submit_plan', { summary: 'x', plan: ' ' }, /Plan/],
    ['an oversized body', 'builder', 'submit_result', { summary: 'x', details: 'y'.repeat(16_001) }, /Details/],
    ['an unknown severity', 'reviewer', 'submit_review', { summary: 'x', findings: [{ severity: 'critical', text: 'y' }] }, /severity/],
    ['too many findings', 'reviewer', 'submit_review', { summary: 'x', findings: Array.from({ length: 21 }, () => ({ severity: 'minor', text: 'y' })) }, /20 findings/],
    ['findings that are not a list', 'reviewer', 'submit_review', { summary: 'x', findings: 'many' }, /list/],
  ])('rejects %s', (_label, role, tool, args, error) => {
    expect(() => parseSubmission(role as 'planner', tool, args)).toThrow(error);
  });
  it('renders a submission as readable markdown', () => {
    const text = renderSubmission({ tool: 'submit_review', summary: 'Two issues', body: 'Details here', findings: [{ severity: 'blocker', text: 'Crash', file: 'a.ts' }], submittedAt: 1 });
    expect(text).toBe('Two issues\n\nDetails here\n\nFindings:\n- [blocker] Crash (a.ts)');
  });
});

const active: { engine: FactoryEngine; store: TowerStore }[] = [];
afterEach(async () => { for (const entry of active.splice(0)) { await entry.engine.shutdown(); entry.store.close(); } });

function harness(review = false) {
  const store = new TowerStore(':memory:'); const agents = new Map<string, Agent>(); const events = new Map<string, AgentEvent[]>(); const launches: ManagedLaunch[] = [];
  const host: FactoryHost = {
    launch: input => { launches.push(input); const agent = makeAgent({ id: `managed:bridge-${launches.length}`, status: 'busy', cwd: input.cwd }); agents.set(agent.id, agent); return agent; },
    agent: id => agents.get(id), events: id => events.get(id) ?? [],
    stop: vi.fn(async id => { const agent = agents.get(id); if (agent) agents.set(id, { ...agent, status: 'stopped' }); }),
  };
  const check = vi.fn(async (entry, _cwd, revision): Promise<FactoryEvidence> => ({ id: `c-${Math.random()}`, name: entry.name, command: entry.command, revision, outcome: 'passed', output: 'ok', startedAt: 0, finishedAt: 1 }));
  const engine = new FactoryEngine(store, host, tempDir('factory-bridge-'), check); active.push({ engine, store });
  engine.setEndpoint('http://127.0.0.1:9');
  const defaults = factoryDefaults();
  const definition = engine.saveDefinition({ name: 'Bridge', repository: makeRepo(), ...defaults, workflow: { ...defaults.workflow, review, checks: [{ name: 'Behavior', command: 'node verify.cjs' }] } });
  const item = engine.createItem({ factoryId: definition.id, title: 'Change', request: 'Do it', criteria: 'Works' });
  const current = () => engine.snapshot().items.find(entry => entry.id === item.id)!;
  const token = (index = launches.length - 1) => launches[index].env![FACTORY_TOKEN_ENV];
  const finish = async (text = 'Scraped reply') => {
    const id = current().attempts.at(-1)!.agentId!; agents.set(id, { ...agents.get(id)!, status: 'idle' });
    events.set(id, [{ agentId: id, kind: 'assistant', summary: text, ts: Date.now() }]); await engine.tick();
  };
  return { engine, item, current, launches, token, finish };
}

describe('factory engine bridge', () => {
  it('gives each launched agent the bridge and a scoped token', async () => {
    const h = harness(); await h.engine.action(h.item.id, 'start');
    const launch = h.launches[0];
    expect(launch.mcpServers?.factory).toMatchObject({ env: { WAYSTATION_FACTORY_URL: 'http://127.0.0.1:9' }, inheritEnv: [FACTORY_TOKEN_ENV] });
    expect(launch.appendSystemPrompt).toContain('submit_plan');
    expect(h.engine.bridgeTools(h.token())).toEqual(toolsFor('planner'));
    expect(() => h.engine.bridgeTools('forged')).toThrow(/token/);
  });
  it('uses a structured plan instead of the scraped reply', async () => {
    const h = harness(); await h.engine.action(h.item.id, 'start');
    expect(h.engine.bridgeCall(h.token(), { name: 'submit_plan', arguments: { summary: 'Three steps', plan: '1. Edit\n2. Test\n3. Verify' } })).toMatchObject({ isError: false });
    await h.finish('Rambling reply');
    expect(h.current().status).toBe('plan_review');
    expect(h.current().plan).toBe('Three steps\n\n1. Edit\n2. Test\n3. Verify');
    expect(h.current().attempts[0].submission?.summary).toBe('Three steps');
  });
  it('falls back to the scraped reply when nothing was submitted', async () => {
    const h = harness(); await h.engine.action(h.item.id, 'start'); await h.finish('Plan from reply');
    expect(h.current().plan).toBe('Plan from reply'); expect(h.current().attempts[0].submission).toBeUndefined();
  });
  it('reports invalid submissions to the agent without recording them', async () => {
    const h = harness(); await h.engine.action(h.item.id, 'start');
    expect(h.engine.bridgeCall(h.token(), { name: 'submit_plan', arguments: { summary: '' } })).toMatchObject({ isError: true, text: expect.stringMatching(/Summary/) });
    expect(h.current().attempts[0].submission).toBeUndefined();
  });
  it('refuses submissions from a finished attempt and revokes its token', async () => {
    const h = harness(); await h.engine.action(h.item.id, 'start'); const planner = h.token(); await h.finish();
    expect(() => h.engine.bridgeCall(planner, { name: 'submit_plan', arguments: { summary: 'Late', plan: 'Late' } })).toThrow(/token/);
    await h.engine.action(h.item.id, 'approve-plan');
    expect(h.engine.bridgeTools(h.token())).toEqual(toolsFor('builder'));
  });
  it('records reviewer findings in the attempt output', async () => {
    const h = harness(true); await h.engine.action(h.item.id, 'start'); await h.finish(); await h.engine.action(h.item.id, 'approve-plan');
    writeFileSync(join(h.current().workspace!, 'feature.txt'), 'implemented\n'); await h.finish('Built');
    const deadline = Date.now() + 4000; while (h.current().status !== 'reviewing') { if (Date.now() > deadline) throw new Error(h.current().status); await new Promise(resolve => setTimeout(resolve, 10)); }
    h.engine.bridgeCall(h.token(), { name: 'submit_review', arguments: { summary: 'One issue', findings: [{ severity: 'major', text: 'Missing test' }] } });
    await h.finish('Reviewed');
    expect(h.current().status).toBe('acceptance');
    expect(h.current().attempts.at(-1)?.output).toContain('- [major] Missing test');
  });
  it('launches without the bridge when no endpoint is configured', async () => {
    const h = harness(); h.engine.setEndpoint(undefined); await h.engine.action(h.item.id, 'start');
    expect(h.launches[0].mcpServers).toBeUndefined(); expect(h.launches[0].env).toBeUndefined();
  });
});
