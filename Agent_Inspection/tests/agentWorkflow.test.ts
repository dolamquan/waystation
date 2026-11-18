import { describe, expect, it, vi } from 'vitest';
import { TowerStore } from '../daemon/store/db.ts';
import { SecretStore } from '../daemon/library/secretStore.ts';
import { ArchitectureStore } from '../daemon/architecture/store.ts';
import { BrainConnections } from '../daemon/architecture/brains.ts';
import { AgentResources } from '../daemon/architecture/resources.ts';
import { AgentRuns } from '../daemon/architecture/runs.ts';
import { AgentPlatform } from '../daemon/architecture/platform.ts';
import { AgentEvaluations } from '../daemon/architecture/evaluations.ts';
import { AgentSandboxes } from '../daemon/architecture/sandboxes.ts';
import type { ArchitectureNode, ArchitectureEdge } from '../shared/architecture.ts';
import { makeAgent, tempDir } from './helpers.ts';

const wait = async (fn: () => boolean) => { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw new Error('Workflow did not reach expected state'); await new Promise(r => setTimeout(r, 5)); } };
function setup() {
  const project = tempDir('workflow-execution-'); const db = new TowerStore(':memory:');
  const deps = { store: db, secrets: new SecretStore(':memory:'), audit: vi.fn(), paths: {} as any };
  const send = vi.fn<typeof fetch>(async (_url, init) => { const body = JSON.parse(String(init?.body)); const input = body.messages.at(-1).content; return new Response(JSON.stringify({ choices: [{ message: { content: `checked:${input}` } }], usage: { prompt_tokens: 5, completion_tokens: 3 } })); });
  const store = new ArchitectureStore(db); const brains = new BrainConnections(deps, send); const resources = new AgentResources(deps); const runs = new AgentRuns(deps, store, brains, resources); const platform = new AgentPlatform(deps, store, brains, resources, runs); const sandbox = new AgentSandboxes(deps, (_p, s) => s); const evaluations = new AgentEvaluations(deps, platform, runs, brains, sandbox);
  const brain = brains.create(project, { provider: 'compatible', label: 'Test', model: 'fixture', baseUrl: 'http://localhost:12345/v1' });
  const agent = (id: string, extra = {}): ArchitectureNode => ({ id, kind: 'agent', name: id, description: `Role ${id}`, x: 0, y: 0, runtime: { kind: 'api', policy: 'chat-only', connectionId: brain.id, maxOutputTokens: 1024, ...extra } });
  const output = (id: string): ArchitectureNode => ({ id, kind: 'output', name: id, description: '', x: 0, y: 0, config: { type: 'output', destination: 'dashboard', format: 'text' } });
  const graph = (nodes: ArchitectureNode[], edges: ArchitectureEdge[]) => store.create({ project, graph: { title: 'Workflow', description: '', nodes, edges } }).document;
  const close = async () => { await evaluations.shutdown(); platform.shutdown(); await runs.shutdown(); await sandbox.shutdown(); db.close(); };
  return { project, db, store, brains, resources, runs, platform, evaluations, send, agent, output, graph, close };
}
const edge = (source: string, target: string, outcome?: 'approved' | 'rejected'): ArchitectureEdge => ({ id: `${source}_${target}`, source, target, label: '', ...(outcome ? { outcome } : {}) });

describe('executable workflows and production release boundaries', () => {
  it('hands off between API and managed agents while keeping one cancellable workflow', async () => {
    const s = setup(); let status: 'busy' | 'idle' = 'busy';
    const launch = vi.fn(input => makeAgent({ id: input.agentId, status }));
    s.runs.bind({ launch, prepareResources: input => input, agent: id => makeAgent({ id, status }), events: id => status === 'idle' ? [{ agentId: id, ts: Date.now(), kind: 'assistant', summary: 'Managed review' }] : [], stop: vi.fn(async () => {}) });
    try {
      const managed = { ...s.agent('managed'), provider: 'claude', runtime: { kind: 'managed' as const, policy: 'chat-only' as const, maxOutputTokens: 1024 } };
      const doc = s.graph([s.agent('a'), managed, s.agent('c')], [edge('a', 'managed'), edge('managed', 'c')]);
      const run = s.runs.start(doc.id, 'a', 'question', 1); await wait(() => launch.mock.calls.length === 1);
      expect(s.runs.get(run.id).activeNodeId).toBe('managed'); status = 'idle'; await s.runs.tick(); await wait(() => s.runs.get(run.id).status === 'succeeded');
      expect(s.runs.get(run.id).output).toBe('checked:Managed review'); expect(s.send).toHaveBeenCalledTimes(2);
    } finally { await s.close(); }
  });
  it('stops a managed session at the workflow watchdog deadline', async () => {
    vi.useFakeTimers(); const s = setup(); const stop = vi.fn(async () => {});
    s.runs.bind({ launch: input => makeAgent({ id: input.agentId, status: 'busy' }), prepareResources: input => input, agent: id => makeAgent({ id, status: 'busy' }), events: () => [], stop });
    try {
      const managed = { ...s.agent('a'), provider: 'claude', runtime: { kind: 'managed' as const, policy: 'chat-only' as const, maxOutputTokens: 1024, maxDurationSeconds: 10 } };
      const doc = s.graph([managed], []); const run = s.runs.start(doc.id, 'a', 'question', 1);
      await vi.advanceTimersByTimeAsync(10001); expect(s.runs.get(run.id).status).toBe('failed'); expect(s.runs.get(run.id).error).toMatch(/time limit/); expect(stop).toHaveBeenCalled();
    } finally { await s.close(); vi.useRealTimers(); }
  });
  it('stops a token-exhausted model turn before any requested tool executes', async () => {
    const s = setup(); try {
      s.send.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] } }], usage: { prompt_tokens: 256, completion_tokens: 0 } })));
      const tool: ArchitectureNode = { id: 'tool', name: 'Lookup', kind: 'tool', description: '', x: 0, y: 0, config: { type: 'tool', implementation: 'javascript', functionName: 'lookup', code: 'return {};', timeoutMs: 500, inputSchema: { type: 'object' } } };
      const agent = s.agent('a', { maxTotalTokens: 256 }); agent.runtime!.policy = 'configured-tools';
      const invoke = vi.spyOn(s.resources, 'invoke'); const doc = s.graph([agent, tool], [edge('a', 'tool')]);
      const run = s.runs.start(doc.id, 'a', 'question', 1); await wait(() => s.runs.get(run.id).status === 'failed'); expect(s.runs.get(run.id).error).toMatch(/token budget/); expect(invoke).not.toHaveBeenCalled(); expect(s.send).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
  it('executes agent handoffs with their own instructions, aggregates usage and records checkpoints', async () => {
    const s = setup(); try {
      const doc = s.graph([s.agent('research'), s.agent('review'), s.output('result')], [edge('research', 'review'), edge('review', 'result')]);
      const run = s.runs.startWorkflow(doc.id, 'question', 1); await wait(() => s.runs.get(run.id).status === 'succeeded');
      const final = s.runs.get(run.id); expect(final.output).toBe('checked:checked:question'); expect(final.usage).toEqual({ inputTokens: 10, outputTokens: 6, toolCalls: 0 });
      expect(final.steps?.map(step => [step.nodeId, step.status])).toEqual([['research', 'succeeded'], ['review', 'succeeded'], ['result', 'succeeded']]);
      expect(JSON.parse(String(s.send.mock.calls[1][1]?.body)).messages[0].content).toContain('Role review');
    } finally { await s.close(); }
  });
  it('routes a rejected human decision into a real revision agent rather than delivering approval output', async () => {
    const s = setup(); try {
      const gate: ArchitectureNode = { id: 'gate', name: 'Review', description: '', kind: 'approval', x: 0, y: 0, config: { type: 'approval', message: 'Check it', timeoutMinutes: 1 } };
      const doc = s.graph([s.agent('draft'), gate, s.agent('revise'), s.output('accepted'), s.output('revised')], [edge('draft', 'gate'), edge('gate', 'accepted', 'approved'), edge('gate', 'revise', 'rejected'), edge('revise', 'revised')]);
      const run = s.runs.start(doc.id, 'draft', 'question', 1); await wait(() => !!s.runs.get(run.id).pending);
      s.runs.decide(run.id, s.runs.get(run.id).pending!.id, false); await wait(() => s.runs.get(run.id).status === 'succeeded');
      expect(s.runs.get(run.id).steps?.map(step => step.nodeId)).toEqual(['draft', 'gate', 'revise', 'revised']);
    } finally { await s.close(); }
  });
  it('runs configured router destinations and gives sibling branches the same source response', async () => {
    const s = setup(); try {
      const router: ArchitectureNode = { id: 'route', name: 'Route', description: '', kind: 'router', x: 0, y: 0, config: { type: 'router', rules: [], fallback: 'b' } };
      const doc = s.graph([s.agent('a'), router, s.agent('b'), s.agent('c')], [edge('a', 'route'), edge('route', 'b'), edge('a', 'c')]);
      const run = s.runs.start(doc.id, 'a', 'q', 1); await wait(() => s.runs.get(run.id).status === 'succeeded');
      expect(s.runs.get(run.id).steps?.filter(step => step.kind === 'agent').map(step => step.input)).toEqual(['q', 'checked:q', 'checked:q']);
    } finally { await s.close(); }
  });
  it('bounds cycles before they can run indefinitely', async () => {
    const s = setup(); try {
      const doc = s.graph([s.agent('a', { maxWorkflowSteps: 3 }), s.agent('b')], [edge('a', 'b'), edge('b', 'a')]);
      const run = s.runs.start(doc.id, 'a', 'q', 1); await wait(() => s.runs.get(run.id).status === 'failed');
      expect(s.send).toHaveBeenCalledTimes(3); expect(s.runs.get(run.id).error).toMatch(/step budget/);
    } finally { await s.close(); }
  });
  it('resumes from checkpoints without rerunning the model or a delivered destination, and requires uncertain replay acknowledgement', async () => {
    const s = setup(); try {
      const first = s.output('first'); const second = { ...s.output('second'), config: { type: 'output' as const, destination: 'webhook' as const, format: 'text' as const, url: 'http://localhost:1/hook' } };
      const deliver = vi.spyOn(s.resources, 'deliver').mockImplementation(async (_ctx, node) => { if (node.id === 'second' && deliver.mock.calls.filter(c => c[1].id === 'second').length === 1) throw new Error('connection lost'); return { delivered: true }; });
      const doc = s.graph([s.agent('a'), first, second], [edge('a', 'first'), edge('a', 'second')]);
      const run = s.runs.start(doc.id, 'a', 'q', 1); await wait(() => s.runs.get(run.id).status === 'failed');
      expect(() => s.runs.resume(run.id)).toThrow(/acknowledge/);
      const resumed = s.runs.resume(run.id, true); await wait(() => s.runs.get(resumed.id).status === 'succeeded');
      expect(s.send).toHaveBeenCalledTimes(1); expect(deliver.mock.calls.filter(c => c[1].id === 'first')).toHaveLength(1);
      expect(deliver.mock.calls[1][0].idempotencyKey).toBe(deliver.mock.calls[2][0].idempotencyKey);
      expect(resumed.executionKey).toBe(run.id);
    } finally { await s.close(); }
  });
  it('refuses a missing downstream brain before spending tokens', async () => {
    const s = setup(); try {
      const next = s.agent('b'); delete next.runtime;
      const doc = s.graph([s.agent('a'), next], [edge('a', 'b')]);
      expect(() => s.runs.start(doc.id, 'a', 'q', 1)).toThrow(/brain|Configure/); expect(s.send).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it('does not start production-follow triggers before promotion', async () => {
    const s = setup(); try {
      const doc = s.graph([s.agent('a')], []); const deployment = s.platform.deploy(doc.id, 'a', { expectedRevision: 1 });
      const trigger = s.platform.saveTrigger(deployment.id, { kind: 'webhook', name: 'Production hook', text: 'q' }); s.platform.saveTrigger(deployment.id, { enabled: true }, trigger.id);
      expect(() => s.platform.fireTrigger(trigger.id)).toThrow(/No production/); expect(s.runs.list()).toHaveLength(0);
      s.platform.promote(deployment.id, { override: 'Explicit test authorization for the first production version.' });
      const run = s.platform.fireTrigger(trigger.id); await wait(() => s.runs.get(run.id).status === 'succeeded');
    } finally { await s.close(); }
  });
  it('invalidates old release evidence after an evaluator changes', async () => {
    const s = setup(); try {
      const doc = s.graph([s.agent('a')], []); const deployment = s.platform.deploy(doc.id, 'a', { expectedRevision: 1 });
      const dataset = s.evaluations.saveDataset({ project: s.project, name: 'Cases', examples: [{ id: 'one', input: 'q', reference: 'checked:q' }] });
      const evaluator = s.evaluations.saveEvaluator({ project: s.project, name: 'Check', threshold: 1, spec: { kind: 'exact', ignoreCase: false } });
      s.platform.saveReleasePolicy(doc.id, 'a', { datasetId: dataset.id, evaluatorIds: [evaluator.id], minPassRate: 1 });
      const experiment = s.evaluations.create({ name: 'Release check', deploymentId: deployment.id, datasetId: dataset.id, evaluatorIds: [evaluator.id] });
      for (let i = 0; i < 200 && s.evaluations.get(experiment.id).status === 'running'; i++) { await s.evaluations.tick(); await new Promise(r => setTimeout(r, 5)); }
      expect(s.platform.gate(deployment.id).passed).toBe(true);
      s.evaluations.saveEvaluator({ ...evaluator, expectedVersion: 1, threshold: 1, spec: { kind: 'contains', text: 'stricter', ignoreCase: false } }, evaluator.id);
      expect(s.platform.gate(deployment.id).passed).toBe(false);
    } finally { await s.close(); }
  });
});
