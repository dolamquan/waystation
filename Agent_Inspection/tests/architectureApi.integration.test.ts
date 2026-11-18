import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tempDir, makeAgent } from './helpers.ts';
import { AUTOMATION_TOKEN_ENV } from '../daemon/automation/automation.ts';

const HOME = tempDir('architecture-api-'); const PROJECT = tempDir('architecture-api-project-'); const OTHER = tempDir('architecture-api-other-');
process.env.AGENT_TOWER_HOME = HOME; process.env.CLAUDE_HOME = tempDir('architecture-api-claude-');
const PORT = 47_359; const TOKEN = 'architecture-operator-test';
let tower: import('../daemon/tower.ts').Tower; let server: Server;
const call = async (method: string, path: string, body?: unknown, token = TOKEN, origin?: string) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { 'content-type': 'application/json', 'x-tower-token': token, ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
};
const tool = async (name: string, args: object, token: string) => {
  const response = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project: PROJECT, ...args } } }) });
  return (await response.json()).result;
};
beforeAll(async () => {
  const { Tower } = await import('../daemon/tower.ts'); const { startServer } = await import('../daemon/api/server.ts');
  tower = new Tower(join(HOME, 'state.db')); server = await startServer({ tower, port: PORT, host: '127.0.0.1', token: TOKEN });
}, 30_000);
afterAll(async () => { vi.restoreAllMocks(); server?.close(); await tower?.shutdown(); });

describe('architecture HTTP and agent tools', () => {
  let id: string;
  it('authenticates the operator, rejects untrusted origins and reports invalid projects', async () => {
    expect((await call('GET', '/api/architectures', undefined, 'wrong')).status).toBe(401);
    expect((await call('POST', '/api/architectures', { project: PROJECT }, TOKEN, 'https://evil.example')).status).toBe(403);
    expect((await call('POST', '/api/architectures', { project: 'relative' })).status).toBe(400);
    const created = await call('POST', '/api/architectures', { project: PROJECT, graph: 'starter' });
    expect(created.status).toBe(200); id = created.data.document.id;
    expect((await call('GET', '/api/architectures')).data.documents).toHaveLength(1);
  });
  it('lets the agent read and modify the same workflow, enforces scope and revision checks, and lets the operator undo', async () => {
    const automation = tower.library.automation;
    const launch = automation.attachDefaults({ vendor: 'claude', cwd: PROJECT, prompt: '', agentId: 'managed:architecture' });
    const token = launch.env![AUTOMATION_TOKEN_ENV];
    expect((await tool('get_architecture', { id }, token)).structuredContent.document.revision).toBe(1);
    const changed = await tool('update_architecture', { id, expectedRevision: 1, operations: [{ type: 'describe', title: 'Reviewed workflow', description: 'With review.' }] }, token);
    expect(changed.isError).toBe(false); expect(changed.structuredContent.document.changedBy).toBe('managed:architecture');
    expect((await tool('update_architecture', { id, expectedRevision: 1, operations: [{ type: 'remove_node', id: 'builder' }] }, token)).isError).toBe(true);
    const foreign = await call('POST', '/api/architectures', { project: OTHER });
    expect((await tool('get_architecture', { id: foreign.data.document.id }, token)).isError).toBe(true);
    expect((await tool('list_architectures', {}, token)).structuredContent.workflows).toHaveLength(1);
    const brain = tower.library.brains.create(PROJECT, { label: 'Research brain', provider: 'openai', model: 'test-model', apiKey: 'metadata-must-never-expose-this-key' });
    const context = await tool('get_architecture', { id }, token);
    expect(context.structuredContent.connections).toEqual([{ id: brain.id, label: 'Research brain', provider: 'openai', model: 'test-model' }]);
    expect(JSON.stringify(context)).not.toContain('metadata-must-never-expose-this-key');
    const undone = await call('POST', `/api/architectures/${id}/history`, { expectedRevision: 2, direction: 'undo' });
    expect(undone.data.document.title).toBe('Agent workflow');
    expect((await call('POST', `/api/architectures/${id}`, { expectedRevision: 2, operations: [{ type: 'remove_node', id: 'builder' }] })).status).toBe(400);
  });
  it('routes chat through managed launch, keeps the graph instructions, and reuses the conversation', async () => {
    const agent = makeAgent({ id: 'managed:architect-chat', tier: 'A', cwd: PROJECT, status: 'idle' });
    const launch = vi.spyOn(tower, 'launch').mockImplementation(raw => { tower.registry.upsert('architecture-test', agent); return agent; });
    const instruct = vi.spyOn(tower, 'instruct').mockResolvedValue('Sent.');
    try {
      expect((await call('POST', `/api/architectures/${id}/chat`, { text: 'Add a reviewer', vendor: 'not-a-vendor' })).status).toBe(400);
      expect((await call('POST', `/api/architectures/${id}/chat`, { text: 'Add a reviewer', vendor: 'codex' })).status).toBe(400); // cannot enforce tool review
      expect((await call('POST', `/api/architectures/${id}/chat`, { text: 'Add a reviewer', vendor: 'claude', model: '--dangerously-skip-permissions' })).status).toBe(400);
      expect((await call('POST', `/api/architectures/${id}/chat`, { text: 'Add a reviewer', vendor: 'claude', model: 42 })).status).toBe(400);
      expect(launch).not.toHaveBeenCalled();
      const started = await call('POST', `/api/architectures/${id}/chat`, { text: 'Add a reviewer', vendor: 'claude', model: 'claude-sonnet-5-5', selection: 'builder' });
      expect(started.status).toBe(200); expect(started.data.agentId).toBe(agent.id);
      expect(launch.mock.calls[0][0]).toMatchObject({ vendor: 'claude', model: 'claude-sonnet-5-5', cwd: expect.any(String), toolPolicy: 'review-tools', intercept: true, appendSystemPrompt: expect.stringContaining(`workflow id is ${id}`) });
      expect((await call('GET', `/api/architectures/${id}`)).data.agentId).toBe(agent.id);
      expect((await call('POST', `/api/architectures/${id}/chat`, { text: 'Explain the handoff', vendor: 'claude' })).status).toBe(200);
      expect(launch).toHaveBeenCalledTimes(1); expect(instruct).toHaveBeenCalledWith(agent.id, expect.stringContaining('Explain the handoff'));
      expect((await call('POST', `/api/architectures/${id}/chat`, { text: '' })).status).toBe(400);
      for (const status of ['busy', 'waiting'] as const) {
        tower.registry.upsert('architecture-test', { ...agent, status });
        const rejected = await call('POST', `/api/architectures/${id}/chat`, { text: 'Another idea' });
        expect(rejected.status).toBe(400); expect(rejected.data.error).toMatch(/still working/);
      }
      expect(instruct).toHaveBeenCalledTimes(1);
      tower.registry.upsert('architecture-test', agent);
    } finally { launch.mockRestore(); instruct.mockRestore(); }
  });
  it('tests a saved individual agent with enforced runtime policy, rejects duplicate or stale tests, and keeps foreign credentials inaccessible', async () => {
    let document = (await call('GET', `/api/architectures/${id}`)).data.document;
    const node = document.nodes.find((n: any) => n.id === 'builder');
    const saved = await call('POST', `/api/architectures/${id}`, { expectedRevision: document.revision, operations: [{ type: 'put_node', node: { ...node, provider: 'claude', runtime: { kind: 'managed', policy: 'chat-only', maxOutputTokens: 256 } } }] });
    document = saved.data.document;
    const agent = makeAgent({ id: 'managed:individual-test', tier: 'A', cwd: PROJECT, status: 'busy' });
    const launch = vi.spyOn(tower, 'launch').mockImplementation(() => { tower.registry.upsert('architecture-test', agent); return agent; });
    const test = (expectedRevision = document.revision) => call('POST', `/api/architectures/${id}/nodes/builder/test`, { text: 'Plan a support process', expectedRevision });
    try {
      expect((await test(document.revision - 1)).status).toBe(400);
      expect((await test()).data).toEqual({ kind: 'managed', agentId: agent.id });
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ toolPolicy: 'chat-only', prompt: 'Plan a support process', appendSystemPrompt: expect.stringContaining('multipurpose agent') }));
      expect((await test()).status).toBe(400); expect(launch).toHaveBeenCalledTimes(1);
    } finally { launch.mockRestore(); }
    const connection = tower.library.brains.create(OTHER, { label: 'Other project', provider: 'openai', model: 'test-model', apiKey: 'foreign-private-key' });
    const updated = await call('POST', `/api/architectures/${id}`, { expectedRevision: document.revision, operations: [{ type: 'put_node', node: { ...node, runtime: { kind: 'api', policy: 'chat-only', connectionId: connection.id, maxOutputTokens: 256 } } }] });
    document = updated.data.document;
    const rejected = await test(); expect(rejected.status).toBe(400); expect(JSON.stringify(rejected.data)).not.toContain('foreign-private-key');
    const available = (await call('GET', `/api/architectures/${id}/connections`)).data.connections;
    expect(available).toHaveLength(1); expect(available[0].id).not.toBe(connection.id);
  });
  it('serves executable resources and asynchronous managed run history through authenticated operator routes', async () => {
    const created = await call('POST', '/api/architectures', { project: PROJECT }); let doc = created.data.document;
    const connection = tower.library.brains.create(PROJECT, { label: 'Run test brain', provider: 'compatible', model: 'test-model', baseUrl: 'http://localhost:12345/v1' });
    const node = { id: 'run-agent', kind: 'agent', name: 'Operations agent', description: 'Use the configured tool.', x: 0, y: 0, runtime: { kind: 'api', policy: 'configured-tools', maxOutputTokens: 256, connectionId: connection.id } };
    const tool = { id: 'run-tool', kind: 'tool', name: 'Real tool', description: 'Add one', x: 0, y: 100, config: { type: 'tool', implementation: 'javascript', functionName: 'add_one', code: 'return { answer: input.n + 1 };', timeoutMs: 1000, inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } } };
    doc = (await call('POST', `/api/architectures/${doc.id}`, { expectedRevision: 1, operations: [{ type: 'put_node', node }, { type: 'put_node', node: tool }, { type: 'put_edge', edge: { id: 'connected', source: node.id, target: tool.id, label: '' } }] })).data.document;
    const invalid = await call('POST', `/api/architectures/${doc.id}/nodes/run-tool/resource`, { expectedRevision: doc.revision, node: { ...tool, config: { ...tool.config, timeoutMs: -1 } } }); expect(invalid.status).toBe(400);
    const probe = await call('POST', `/api/architectures/${doc.id}/nodes/run-tool/resource/test`, { expectedRevision: doc.revision, input: { n: 4 } }); expect(probe.data.result).toEqual({ result: { answer: 5 } });
    const brain = vi.spyOn(tower.library.brains, 'run').mockImplementation(async (_connection, _project, _role, _text, options) => { const result = await options.tools![0].execute({ n: 4 }); return { kind: 'api', text: JSON.stringify(result), model: 'test-model', truncated: false, usage: { inputTokens: 10, outputTokens: 5, toolCalls: 1 } }; });
    try {
      expect((await call('GET', '/api/agent-runs', undefined, 'wrong')).status).toBe(401);
      expect((await call('POST', `/api/architectures/${doc.id}/nodes/run-agent/run`, { text: 'Task', expectedRevision: doc.revision }, TOKEN, 'https://evil.example')).status).toBe(403);
      const started = await call('POST', `/api/architectures/${doc.id}/nodes/run-agent/run`, { text: 'Task', expectedRevision: doc.revision }); expect(started.status).toBe(200);
      const runId = started.data.run.id;
      await vi.waitFor(() => expect(tower.library.agentRuns.get(runId).status).toBe('succeeded'));
      const detail = (await call('GET', `/api/agent-runs/${runId}`)).data.run; expect(detail.output).toBe('{"answer":5}'); expect(detail.events.some((e: any) => e.kind === 'tool')).toBe(true);
      expect((await call('GET', '/api/agent-runs')).data.runs.some((r: any) => r.id === runId)).toBe(true);
    } finally { brain.mockRestore(); }
  });

  it('serves versioned deployments, persistent chat, service connections and scoped webhook tokens', async () => {
    expect((await call('GET', `/api/agent-platform?project=${encodeURIComponent(PROJECT)}`, undefined, 'wrong')).status).toBe(401);
    expect((await call('GET', '/api/agent-platform?project=relative')).status).toBe(400);
    const state = (await call('GET', `/api/agent-platform?project=${encodeURIComponent(PROJECT)}`)).data;
    expect(state.environments[0].runtime).toBe('local');
    const created = await call('POST', '/api/architectures', { project: PROJECT }); let doc = created.data.document;
    const brain = tower.library.brains.create(PROJECT, { label: 'Deployment brain', provider: 'compatible', model: 'fixture-model', baseUrl: 'http://localhost:12345/v1' });
    const cap = (await call('POST', '/api/agent-capabilities', { project: PROJECT, name: 'Research procedure', spec: { kind: 'skill', instructions: 'Cite sources carefully.', requires: [] } })).data.capability;
    doc = (await call('POST', `/api/architectures/${doc.id}`, { expectedRevision: 1, operations: [{ type: 'put_node', node: { id: 'deployed', kind: 'agent', name: 'Deployed researcher', description: 'Research the task.', x: 0, y: 0, capabilities: [{ id: cap.id, version: 1 }], runtime: { kind: 'api', policy: 'chat-only', connectionId: brain.id, maxOutputTokens: 256 } } }] })).data.document;
    expect((await call('POST', `/api/architectures/${doc.id}/nodes/deployed/deploy`, { expectedRevision: 1 })).status).toBe(400);
    const deployment = (await call('POST', `/api/architectures/${doc.id}/nodes/deployed/deploy`, { expectedRevision: doc.revision, environmentId: state.environments[0].id })).data.deployment;
    expect(deployment.capabilities[0].version).toBe(1);
    const mock = vi.spyOn(tower.library.brains, 'run').mockResolvedValue({ kind: 'api', text: 'Research complete.', model: 'fixture-model', truncated: false, usage: { inputTokens: 5, outputTokens: 5, toolCalls: 0 } });
    try {
      const c = (await call('POST', `/api/agent-deployments/${deployment.id}/conversations`, {})).data.conversation;
      const message = await call('POST', `/api/agent-conversations/${c.id}/messages`, { text: 'Find evidence' }); expect(message.status).toBe(200);
      await vi.waitFor(() => expect(tower.library.agentRuns.get(message.data.run.id).status).toBe('succeeded'));
      expect((await call('GET', `/api/agent-conversations/${c.id}`)).data.conversation.messages).toHaveLength(2);
      const trace = await call('GET', `/api/agent-runs/${message.data.run.id}/trace`); expect(trace.data.events.length).toBeGreaterThan(1);
      const t = (await call('POST', `/api/agent-deployments/${deployment.id}/triggers`, { kind: 'webhook', name: 'Research request', text: 'Research a saved topic' })).data.trigger;
      await call('POST', `/api/agent-deployments/${deployment.id}/triggers/${t.id}`, { enabled: true });
      const key = (await call('POST', `/api/agent-triggers/${t.id}/key`, {})).data;
      const hook = async (token: string, path = key.path) => { const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' }); return { status: res.status, data: await res.json() as any }; };
      expect((await hook('wrong')).status).toBe(401);
      expect((await hook(key.token)).status).toBe(400);
      expect((await call('POST', `/api/agent-deployments/${deployment.id}/promote`, { override: 'Explicit initial release for authenticated webhook integration verification.' })).status).toBe(200);
      const invoked = await hook(key.token); expect(invoked.status).toBe(200); expect(Object.keys(invoked.data).sort()).toEqual(['runId', 'status']);
      await vi.waitFor(() => expect(tower.library.agentRuns.get(invoked.data.runId).status).toBe('succeeded'));
      const replacement = (await call('POST', `/api/agent-triggers/${t.id}/key`, {})).data;
      expect(replacement.token).not.toBe(key.token); expect((await hook(key.token)).status).toBe(401);
      expect(JSON.stringify((await call('GET', `/api/agent-deployments/${deployment.id}`)).data)).not.toContain(replacement.token);
      const connection = await call('POST', '/api/agent-service-connections', { project: PROJECT, name: 'Tavily', kind: 'tavily', secret: 'tvly-api-hidden' }); expect(connection.status).toBe(200); expect(JSON.stringify(connection.data)).not.toContain('tvly-api-hidden');
      expect((await call('POST', '/api/agent-service-connections', { project: PROJECT, name: 'Tavily', kind: 'tavily', secret: 'private', endpoint: 'https://attacker.example/search' })).status).toBe(400);
      await call('POST', `/api/agent-deployments/${deployment.id}/status`, { status: 'paused' }); expect((await call('POST', `/api/agent-deployments/${deployment.id}/runs`, { text: 'Blocked' })).status).toBe(400);
    } finally { mock.mockRestore(); }
  });

});
