import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TowerStore } from '../daemon/store/db.ts';
import { SecretStore } from '../daemon/library/secretStore.ts';
import { ArchitectureStore } from '../daemon/architecture/store.ts';
import { BrainConnections } from '../daemon/architecture/brains.ts';
import { AgentResources } from '../daemon/architecture/resources.ts';
import { AgentRuns } from '../daemon/architecture/runs.ts';
import { WaystationAutomation, AUTOMATION_TOKEN_ENV } from '../daemon/automation/automation.ts';
import { tempDir, makeAgent } from './helpers.ts';
import type { ArchitectureGraph } from '../shared/architecture.ts';
import type { ManagedLaunch } from '../daemon/managed/types.ts';
import { defaultResource } from '../shared/agentResources.ts';

const wait = async (fn: () => boolean) => { const end = Date.now() + 10000; while (!fn()) { if (Date.now() > end) throw new Error('Run did not reach expected state'); await new Promise(r => setTimeout(r, 10)); } };
function setup(send: typeof fetch, dbFile = ':memory:') {
  const project = tempDir('agent-run-project-'); const db = new TowerStore(dbFile); const deps = { store: db, secrets: new SecretStore(':memory:'), audit: vi.fn(), paths: {} as any };
  const architectures = new ArchitectureStore(db); const brains = new BrainConnections(deps, send); const resources = new AgentResources(deps); const runs = new AgentRuns(deps, architectures, brains, resources);
  const connection = brains.create(project, { label: 'Local', provider: 'compatible', model: 'fixture', baseUrl: 'http://localhost:12345/v1' });
  const graph: ArchitectureGraph = { title: 'Research system', description: '', nodes: [
    { id: 'agent', kind: 'agent', name: 'Researcher', description: 'Calculate the answer using the connected tool and return JSON.', x: 0, y: 0, runtime: { kind: 'api', policy: 'configured-tools', connectionId: connection.id, maxOutputTokens: 512 } },
    { id: 'tool', kind: 'tool', name: 'Increment', description: 'Increment a number.', x: 0, y: 160, config: { type: 'tool', implementation: 'javascript', functionName: 'increment', code: 'return { answer: input.n + 1 };', timeoutMs: 1000, inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } } },
    { id: 'memory', kind: 'memory', name: 'History', description: '', x: 0, y: 300, config: defaultResource('memory') },
    { id: 'gate', kind: 'approval', name: 'Delivery approval', description: '', x: 240, y: 0, config: defaultResource('approval') },
    { id: 'out', kind: 'output', name: 'Result file', description: '', x: 480, y: 0, config: { type: 'output', destination: 'file', format: 'json', path: 'results/{runId}.json', schema: { type: 'object', required: ['answer'] } } },
  ], edges: [{ id: 't', source: 'agent', target: 'tool', label: '' }, { id: 'm', source: 'memory', target: 'agent', label: '' }, { id: 'g', source: 'agent', target: 'gate', label: '' }, { id: 'o', source: 'gate', target: 'out', label: '' }] };
  const doc = architectures.create({ project, graph }).document;
  return { project, db, deps, architectures, brains, resources, runs, doc };
}
describe('persistent agent execution and management', () => {
  it('accepts ordinary text after an input is switched from JSON back to text', async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"choices":[{"message":{"content":"{\\"answer\\":4}"}}]}'));
    const s = setup(send); const input = { id: 'task-input', kind: 'input' as const, name: 'Task input', description: '', x: 0, y: 0, config: { type: 'input' as const, format: 'json' as const, schema: { type: 'object', required: ['task'] } } };
    try {
      let doc = s.architectures.update(s.doc.id, 1, [{ type: 'put_node', node: input }, { type: 'put_edge', edge: { id: 'task-edge', source: input.id, target: 'agent', label: '' } }]).document;
      const failed = s.runs.start(doc.id, 'agent', 'ordinary task', doc.revision); await wait(() => s.runs.get(failed.id).status === 'failed'); expect(send).not.toHaveBeenCalled();
      doc = s.architectures.update(doc.id, doc.revision, [{ type: 'put_node', node: { ...input, config: { ...input.config, format: 'text' } } }]).document;
      expect(doc.nodes.find(n => n.id === input.id)?.config).toEqual({ type: 'input', format: 'text' });
      const run = s.runs.start(doc.id, 'agent', 'ordinary task', doc.revision); await wait(() => s.runs.get(run.id).status === 'waiting_approval'); expect(send).toHaveBeenCalledTimes(1); await s.runs.cancel(run.id);
    } finally { await s.runs.shutdown(); s.db.close(); }
  });
  it('preserves run history across a database restart and marks unfinished runs interrupted', async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"choices":[{"message":{"content":"{\\"answer\\":4}"}}]}'));
    const file = join(tempDir('agent-run-db-'), 'runs.db'); const s = setup(send, file);
    const doc = s.architectures.update(s.doc.id, 1, [{ type: 'remove_node', id: 'gate' }]).document;
    const run = s.runs.start(doc.id, 'agent', 'Persist this result', doc.revision); await wait(() => s.runs.get(run.id).status === 'succeeded'); await s.runs.shutdown();
    const stored = s.db.loadRecords<any>('agent_runs')[0]; s.db.saveRecord('agent_runs', { ...stored, id: 'crashed-run', status: 'running', finishedAt: undefined }); s.db.close();
    const reopened = new TowerStore(file); const deps = { ...s.deps, store: reopened }; const architectures = new ArchitectureStore(reopened); const brains = new BrainConnections(deps, send); const manager = new AgentRuns(deps, architectures, brains, new AgentResources(deps));
    try {
      manager.bind({ launch: vi.fn(), prepareResources: x => x, agent: () => undefined, events: () => [], stop: vi.fn() });
      expect(manager.get(run.id)).toMatchObject({ status: 'succeeded', output: '{"answer":4}', revision: 2 });
      expect(manager.get('crashed-run')).toMatchObject({ status: 'interrupted', error: expect.stringContaining('restarted') });
      const retry = manager.retry('crashed-run'); await wait(() => manager.get(retry.id).status === 'succeeded'); expect(retry.retryOf).toBe('crashed-run');
    } finally { await manager.shutdown(); reopened.close(); }
  });
  it('runs a real JavaScript tool loop, loads/writes memory, waits for approval, delivers output, and retries the saved revision', async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string); const toolResult = body.messages.find((m: any) => m.role === 'tool');
      return new Response(JSON.stringify(toolResult ? { choices: [{ message: { content: toolResult.content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }
        : { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'increment', arguments: '{"n":2}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    });
    const s = setup(send);
    try {
      await s.resources.memory({ document: s.doc, agentNodeId: 'agent', runId: 'seed' }, s.doc.nodes.find(n => n.id === 'memory')!, 'put', 'preference', { location: 'Seattle' });
      const started = s.runs.start(s.doc.id, 'agent', 'Calculate 2 + 1', 1);
      await wait(() => s.runs.get(started.id).status === 'waiting_approval');
      let run = s.runs.get(started.id); expect(run.output).toBe('{"answer":3}'); expect(existsSync(join(s.project, `results/${run.id}.json`))).toBe(false);
      const firstBody = JSON.parse(send.mock.calls[0][1]!.body as string); expect(firstBody.messages[0].content).not.toContain('Seattle'); expect(firstBody.messages.find((m: any) => m.role === 'user').content).toMatch(/<context>[\s\S]*Seattle/);
      s.runs.decide(run.id, run.pending!.id, true); await wait(() => s.runs.get(run.id).status === 'succeeded'); run = s.runs.get(run.id);
      expect(JSON.parse(readFileSync(join(s.project, `results/${run.id}.json`), 'utf8'))).toEqual({ answer: 3 });
      expect(run.usage).toEqual({ inputTokens: 30, outputTokens: 15, toolCalls: 1 }); expect(run.events.map(e => e.kind)).toEqual(expect.arrayContaining(['model', 'tool', 'memory', 'approval', 'output']));
      expect((await s.resources.memory({ document: s.doc, agentNodeId: 'agent', runId: 'inspect' }, s.doc.nodes.find(n => n.id === 'memory')!, 'list') as any[]).some(r => r.key === `conversation_${run.id}`)).toBe(true);
      const tool = s.doc.nodes.find(n => n.id === 'tool')!; s.architectures.update(s.doc.id, 1, [{ type: 'put_node', node: { ...tool, config: { ...tool.config!, code: 'return { answer: 999 };' } as any } }]);
      const retry = s.runs.retry(run.id); expect(retry.revision).toBe(1); expect(retry.retryOf).toBe(run.id);
      await wait(() => s.runs.get(retry.id).status === 'waiting_approval'); expect(s.runs.get(retry.id).output).toBe('{"answer":3}');
      s.runs.decide(retry.id, s.runs.get(retry.id).pending!.id, false); await wait(() => s.runs.get(retry.id).status === 'failed');
      expect(() => s.runs.decide(retry.id, 'old', true)).toThrow(/no longer pending/);
    } finally { await s.runs.shutdown(); s.db.close(); }
  });
  it('cancels an in-flight model request, rejects duplicates, persists failures, and reports interrupted work', async () => {
    const send = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    const s = setup(send);
    try {
      const started = s.runs.start(s.doc.id, 'agent', 'A slow task', 1); await wait(() => send.mock.calls.length > 0);
      expect(() => s.runs.start(s.doc.id, 'agent', 'duplicate', 1)).toThrow(/active run/);
      await s.runs.cancel(started.id); expect(s.runs.get(started.id).status).toBe('cancelled');
      await wait(() => s.runs.get(started.id).events.some(e => e.message === 'Cancelled by operator'));
      await s.runs.shutdown();
      const interrupted = s.runs.start(s.doc.id, 'agent', 'Another slow task', 1); await wait(() => send.mock.calls.length > 1); await s.runs.shutdown();
      expect(s.runs.get(interrupted.id).status).toBe('interrupted'); expect(s.runs.list()).toHaveLength(2);
    } finally { await s.runs.shutdown(); s.db.close(); }
  });
  it('provides managed agents only their own connected resources through a scoped MCP grant, and tracks their completion', async () => {
    const s = setup(vi.fn()); const automation = new WaystationAutomation(s.db); automation.setEndpoint('http://127.0.0.1:4317'); automation.runResources = s.runs;
    let launch: ManagedLaunch | undefined; let status: 'busy' | 'idle' = 'busy';
    const host = { launch: (input: ManagedLaunch) => { launch = input; return makeAgent({ id: input.agentId!, status }); }, prepareResources: (input: ManagedLaunch, id: string) => automation.attachResources(input, id), agent: (id: string) => makeAgent({ id, status }), events: (id: string) => status === 'idle' ? [{ agentId: id, ts: Date.now(), kind: 'assistant' as const, summary: '{"answer":5}' }] : [], stop: vi.fn(async () => {}) };
    s.runs.bind(host);
    const node = s.doc.nodes[0]; const updated = s.architectures.update(s.doc.id, 1, [{ type: 'put_node', node: { ...node, provider: 'claude', runtime: { kind: 'managed', policy: 'review-tools', maxOutputTokens: 512 } } }, { type: 'remove_node', id: 'gate' }, { type: 'put_edge', edge: { id: 'direct', source: 'agent', target: 'out', label: '' } }]).document;
    try {
      const started = s.runs.start(updated.id, 'agent', 'Run managed task', updated.revision); await wait(() => !!launch);
      const grant = automation.authenticate(launch!.env![AUTOMATION_TOKEN_ENV]); expect(automation.toolsFor(grant).map(t => t.name)).toEqual(['increment', 'memory_history_get', 'memory_history_put']);
      expect(automation.toolsFor(grant)[0]).toMatchObject({ description: 'Increment a number.', inputSchema: { properties: { n: { type: 'number' } }, required: ['n'] }, annotations: { readOnlyHint: true } });
      expect(await automation.call('increment', { project: s.project, n: 4 }, grant, { agents: () => [], consoles: () => [] })).toEqual({ answer: 5 });
      await expect(automation.call('increment', { n: 'four' }, grant, { agents: () => [], consoles: () => [] })).rejects.toThrow(/JSON schema/);
      expect(s.runs.get(started.id).toolCalls?.map(c => [c.name, c.ok, c.approval])).toEqual([['increment', true, 'harness'], ['increment', false, 'harness']]);
      await expect(automation.call('update_architecture', { id: updated.id }, grant, { agents: () => [], consoles: () => [] })).rejects.toThrow(/not attached/);
      await expect(s.runs.callResource(started.id, 'other-agent', 'memory_history_get', { key: 'k' })).rejects.toThrow(/own active/);
      status = 'idle'; await s.runs.tick(); await wait(() => s.runs.get(started.id).status === 'succeeded');
      await expect(automation.call('memory_history_get', { key: 'k' }, grant, { agents: () => [], consoles: () => [] })).rejects.toThrow(/own active/);
    } finally { await s.runs.shutdown(); s.db.close(); }
  });
});
