import { createServer } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TowerStore } from '../daemon/store/db.ts';
import { SecretStore } from '../daemon/library/secretStore.ts';
import { ArchitectureStore } from '../daemon/architecture/store.ts';
import { BrainConnections } from '../daemon/architecture/brains.ts';
import { AgentResources } from '../daemon/architecture/resources.ts';
import { AgentRuns } from '../daemon/architecture/runs.ts';
import { AgentPlatform } from '../daemon/architecture/platform.ts';
import { tempDir } from './helpers.ts';
import type { AgentRun } from '../shared/agentRuns.ts';

const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 10000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } };
const response = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
function setup(send: typeof fetch, file = ':memory:') {
  const project = tempDir('platform-'); const store = new TowerStore(file); const deps = { store, secrets: new SecretStore(':memory:'), audit: vi.fn(), paths: {} as any };
  const architectures = new ArchitectureStore(store); const brains = new BrainConnections(deps, send); const resources = new AgentResources(deps); const runs = new AgentRuns(deps, architectures, brains, resources); const platform = new AgentPlatform(deps, architectures, brains, resources, runs);
  const connection = brains.create(project, { label: 'Test brain', provider: 'compatible', model: 'model-v1', baseUrl: 'http://localhost:12345/v1' });
  const doc = architectures.create({ project, graph: { title: 'Research', description: '', nodes: [{ id: 'agent', kind: 'agent', name: 'Researcher', description: 'Research carefully.', x: 0, y: 0, runtime: { kind: 'api', connectionId: connection.id, policy: 'configured-tools', maxOutputTokens: 512, maxSteps: 4, maxToolCalls: 3 } }], edges: [] } }).document;
  const env = platform.defaultEnvironment(project);
  return { store, deps, project, architectures, brains, resources, runs, platform, doc, env };
}
const done = (run: AgentRun) => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status);

describe('agent platform', () => {
  it('caps conversations at 100 user turns even when prior turns failed without replies', async () => {
    const s = setup(vi.fn(async () => new Response('{}', { status: 503 })));
    try {
      const d = s.platform.deploy(s.doc.id, 'agent', { expectedRevision: 1 }); const c = s.platform.createConversation(d.id, {});
      const failed = s.platform.message(c.id, { text: 'Failed turn' }); await wait(() => s.runs.get(failed.run.id).status === 'failed');
      const seeded = { ...c, messages: Array.from({ length: 99 }, (_, i) => ({ id: `user-${i}`, role: 'user' as const, text: 'Failed turn', ts: i, runId: failed.run.id })) };
      s.store.saveRecord('agent_conversations', seeded);
      const last = s.platform.message(c.id, { text: 'Turn 100' }); await wait(() => s.runs.get(last.run.id).status === 'failed');
      expect(s.platform.conversation(c.id).messages.filter(m => m.role === 'user')).toHaveLength(100);
      expect(() => s.platform.message(c.id, { text: 'Turn 101' })).toThrow(/100 turns/);
    } finally { s.platform.shutdown(); await s.runs.shutdown(); s.store.close(); }
  });
  it('reconciles a retried failed chat turn and preserves it in later context, while paused deployments refuse retries', async () => {
    let attempt = 0; const bodies: any[] = [];
    const s = setup(vi.fn<typeof fetch>(async (_url, init) => { bodies.push(JSON.parse(String(init!.body))); return ++attempt === 1 ? new Response('{}', { status: 503 }) : response('Recovered answer'); }));
    try {
      const d = s.platform.deploy(s.doc.id, 'agent', { expectedRevision: 1 }); const c = s.platform.createConversation(d.id, {});
      const first = s.platform.message(c.id, { text: 'Remember my project' }); await wait(() => s.runs.get(first.run.id).status === 'failed');
      s.platform.setStatus(d.id, 'paused'); expect(() => s.runs.retry(first.run.id)).toThrow(/Resume/); s.platform.setStatus(d.id, 'active');
      const retry = s.runs.retry(first.run.id); await wait(() => s.runs.get(retry.id).status === 'succeeded');
      const messages = s.platform.conversation(c.id).messages; expect(messages).toHaveLength(2); expect(messages[1]).toMatchObject({ runId: retry.id, replyToRunId: first.run.id, text: 'Recovered answer' });
      const next = s.platform.message(c.id, { text: 'Continue' }); await wait(() => s.runs.get(next.run.id).status === 'succeeded');
      expect(bodies[2].messages.slice(1, 3)).toEqual([{ role: 'user', content: 'Remember my project' }, { role: 'assistant', content: 'Recovered answer' }]);
    } finally { s.platform.shutdown(); await s.runs.shutdown(); s.store.close(); }
  });
  it('deploys pinned capability versions, keeps drafts isolated, and chats with durable conversation history', async () => {
    const bodies: any[] = []; const s = setup(vi.fn<typeof fetch>(async (_url, init) => { const body = JSON.parse(String(init!.body)); bodies.push(body); return response(body.messages.at(-1).content === 'Remember my city is Oslo' ? 'Your city is Oslo.' : 'You told me Oslo.'); }));
    try {
      const skill = s.platform.saveCapability(s.project, { name: 'Evidence', spec: { kind: 'skill', instructions: 'State uncertainty clearly.', requires: [] } });
      const agent = s.doc.nodes[0]; let doc = s.architectures.update(s.doc.id, 1, [{ type: 'put_node', node: { ...agent, capabilities: [{ id: skill.id, version: 1 }] } }]).document;
      const deployed = s.platform.deploy(doc.id, agent.id, { expectedRevision: doc.revision, environmentId: s.env.id });
      s.platform.saveCapability(s.project, { name: 'Evidence', expectedVersion: 1, spec: { kind: 'skill', instructions: 'New instructions.', requires: [] } }, skill.id);
      doc = s.architectures.update(doc.id, doc.revision, [{ type: 'put_node', node: { ...agent, description: 'Changed draft role.', capabilities: [{ id: skill.id, version: 2 }] } }]).document;
      const c = s.platform.createConversation(deployed.id, {}); const first = s.platform.message(c.id, { text: 'Remember my city is Oslo' }); await wait(() => done(s.runs.get(first.run.id)));
      expect(s.platform.conversation(c.id).messages).toHaveLength(2);
      const second = s.platform.message(c.id, { text: 'Which city?' }); await wait(() => done(s.runs.get(second.run.id)));
      expect(bodies[1].messages.slice(1, 4)).toEqual([{ role: 'user', content: 'Remember my city is Oslo' }, { role: 'assistant', content: 'Your city is Oslo.' }, { role: 'user', content: 'Which city?' }]);
      expect(bodies[1].messages[0].content).toContain('State uncertainty clearly.'); expect(bodies[1].messages[0].content).not.toContain('Changed draft role.');
      expect(s.platform.deployment(deployed.id).capabilities[0].version).toBe(1);
      const v2 = s.platform.deploy(doc.id, agent.id, { expectedRevision: doc.revision, environmentId: s.env.id }); expect(v2.version).toBe(2); expect(v2.definition.nodes[0].description).toContain('New instructions.');
      expect(s.runs.get(second.run.id)).toMatchObject({ deploymentId: deployed.id, deploymentVersion: 1, conversationId: c.id, source: 'chat' });
      expect(s.platform.conversation(c.id).messages).toHaveLength(4); expect(s.runs.trace(first.run.id).map(e => e.kind)).toContain('model');
    } finally { s.platform.shutdown(); await s.runs.shutdown(); s.store.close(); }
  });

  it('executes Tavily search with daemon-only credentials, defaults and validated arguments, then records tool activity', async () => {
    let authorization = ''; let search: any;
    const server = createServer(async (req, res) => { authorization = req.headers.authorization ?? ''; let body = ''; for await (const chunk of req) body += chunk; search = JSON.parse(body); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ results: [{ title: 'Source', url: 'https://example.com/source', content: 'Evidence from source.' }] })); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const send = vi.fn<typeof fetch>(async (_url, init) => { const body = JSON.parse(String(init!.body)); return body.messages.some((m: any) => m.role === 'tool') ? response('Evidence: https://example.com/source') : new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'search', type: 'function', function: { name: 'tavily_search', arguments: '{"query":"research topic"}' } }] } }] })); });
    const s = setup(send);
    try {
      const connection = s.platform.saveConnection(s.project, { name: 'Research key', kind: 'tavily', secret: 'tvly-fixture-private', endpoint: `http://127.0.0.1:${(server.address() as any).port}/search` });
      const tavily = s.platform.saveCapability(s.project, { name: 'Web research', spec: { kind: 'tavily', connectionId: connection.id, functionName: 'tavily_search', maxResults: 3, searchDepth: 'basic', includeDomains: ['example.com'], excludeDomains: [] } });
      const skill = s.platform.saveCapability(s.project, { name: 'Research skill', spec: { kind: 'skill', instructions: 'Search then cite sources.', requires: ['tavily_search'] } });
      const doc = s.architectures.update(s.doc.id, 1, [{ type: 'put_node', node: { ...s.doc.nodes[0], capabilities: [tavily, skill].map(c => ({ id: c.id, version: c.version })) } }]).document;
      const d = s.platform.deploy(doc.id, 'agent', { expectedRevision: doc.revision }); const run = s.platform.run(d.id, 'Research the topic'); await wait(() => done(s.runs.get(run.id)));
      expect(s.runs.get(run.id).status).toBe('succeeded'); expect(authorization).toBe('Bearer tvly-fixture-private'); expect(search).toMatchObject({ query: 'research topic', max_results: 3, search_depth: 'basic', include_domains: ['example.com'] });
      expect(JSON.stringify(s.platform.state(s.project))).not.toContain('tvly-fixture-private'); expect(JSON.stringify(send.mock.calls)).not.toContain('tvly-fixture-private');
      expect(s.runs.get(run.id).events.some(e => e.kind === 'tool' && e.message.includes('Web research'))).toBe(true);
      await expect(s.platform.testCapability(s.project, tavily.id, { query: 'x', max_results: 100 })).rejects.toThrow(/schema/);
      s.platform.saveConnection(s.project, { secret: 'tvly-replaced' }, connection.id); await s.platform.testCapability(s.project, tavily.id, { query: 'probe' }); expect(authorization).toBe('Bearer tvly-replaced');
    } finally { server.close(); s.platform.shutdown(); await s.runs.shutdown(); s.store.close(); }
  });

  it('queues at the environment limit, cancels queued work, and prevents new work on paused deployments', async () => {
    const pending: (() => void)[] = []; const send = vi.fn<typeof fetch>(() => new Promise(resolve => pending.push(() => resolve(response('Done'))))); const s = setup(send);
    try {
      const env = s.platform.saveEnvironment(s.project, { name: 'Serial', network: 'configured', allowedHosts: [], maxConcurrentRuns: 1 });
      const d1 = s.platform.deploy(s.doc.id, 'agent', { expectedRevision: 1, environmentId: env.id }); const d2 = s.platform.deploy(s.doc.id, 'agent', { expectedRevision: 1, environmentId: env.id });
      const first = s.platform.run(d1.id, 'First'); const second = s.platform.run(d2.id, 'Second'); await wait(() => pending.length === 1);
      expect(s.runs.get(second.id).status).toBe('queued'); await s.runs.cancel(second.id); pending[0](); await wait(() => done(s.runs.get(first.id))); expect(send).toHaveBeenCalledTimes(1);
      const next = s.platform.run(d2.id, 'Third'); await wait(() => pending.length === 2); pending[1](); await wait(() => done(s.runs.get(next.id)));
      s.platform.setStatus(d2.id, 'paused'); expect(() => s.platform.run(d2.id, 'Blocked')).toThrow(/paused/); expect(() => s.platform.createConversation(d2.id, {})).toThrow(/Resume/);
    } finally { pending.forEach(resolve => resolve()); s.platform.shutdown(); await s.runs.shutdown(); s.store.close(); }
  });

  it('checks skill dependencies and project boundaries and enforces immutable environment host rules', async () => {
    const s = setup(vi.fn(async () => response('OK')));
    try {
      const skill = s.platform.saveCapability(s.project, { name: 'Research', spec: { kind: 'skill', instructions: 'Search first.', requires: ['search'] } });
      let doc = s.architectures.update(s.doc.id, 1, [{ type: 'put_node', node: { ...s.doc.nodes[0], capabilities: [{ id: skill.id, version: 1 }] } }]).document;
      expect(() => s.platform.deploy(doc.id, 'agent', { expectedRevision: doc.revision })).toThrow(/requires enabled tool/);
      expect(() => s.platform.capability(tempDir(), skill.id)).toThrow(/project/);
      doc = s.architectures.update(doc.id, doc.revision, [{ type: 'put_node', node: s.doc.nodes[0] }]).document;
      const env = s.platform.saveEnvironment(s.project, { name: 'Restricted', maxConcurrentRuns: 1, network: 'restricted', allowedHosts: [] });
      expect(() => s.platform.deploy(doc.id, 'agent', { expectedRevision: doc.revision, environmentId: env.id })).toThrow(/blocks host/);
      const allowed = s.platform.saveEnvironment(s.project, { ...env, allowedHosts: ['localhost'], expectedRevision: env.revision }, env.id);
      const d = s.platform.deploy(doc.id, 'agent', { expectedRevision: doc.revision, environmentId: env.id });
      s.platform.saveEnvironment(s.project, { ...allowed, allowedHosts: [], expectedRevision: allowed.revision }, env.id);
      const run = s.platform.run(d.id, 'Still uses saved policy'); await wait(() => done(s.runs.get(run.id))); expect(s.runs.get(run.id).status).toBe('succeeded');
      expect(d.environment.allowedHosts).toEqual(['localhost']);
    } finally { s.platform.shutdown(); await s.runs.shutdown(); s.store.close(); }
  });

  it('runs explicit interval and webhook triggers once due, without replaying missed intervals', async () => {
    const s = setup(vi.fn(async () => response('Scheduled result')));
    try {
      const d = s.platform.deploy(s.doc.id, 'agent', { expectedRevision: 1 });
      const interval = s.platform.saveTrigger(d.id, { name: 'Daily research', kind: 'interval', intervalMinutes: 1440, text: 'Research daily' });
      await s.platform.tick(Date.now() + 2 * 86400000); expect(s.runs.list()).toHaveLength(0);
      const enabled = s.platform.saveTrigger(d.id, { enabled: true }, interval.id); await s.platform.tick(enabled.nextAt! + 86400000);
      await wait(() => s.runs.list().some(r => r.status === 'succeeded')); expect(s.runs.list()).toHaveLength(1); expect(s.runs.list()[0].source).toBe('interval');
      const webhook = s.platform.saveTrigger(d.id, { name: 'Research hook', kind: 'webhook', text: 'Research from webhook' });
      expect(() => s.platform.fireTrigger(webhook.id)).toThrow(/Enable/); s.platform.saveTrigger(d.id, { enabled: true }, webhook.id);
      const run = s.platform.fireTrigger(webhook.id); expect(() => s.platform.fireTrigger(webhook.id)).toThrow(/queued or active/); await wait(() => done(s.runs.get(run.id))); expect(s.runs.get(run.id).source).toBe('webhook');
    } finally { s.platform.shutdown(); await s.runs.shutdown(); s.store.close(); }
  });

  it('retains deployments and conversations after restart, interrupts active work, and resumes durable queued work', async () => {
    const file = join(tempDir('platform-db-'), 'state.db'); const s = setup(vi.fn(async () => response('Persistent reply')), file);
    const d = s.platform.deploy(s.doc.id, 'agent', { expectedRevision: 1 }); const c = s.platform.createConversation(d.id, {}); const first = s.platform.message(c.id, { text: 'Persistent task' }); await wait(() => done(s.runs.get(first.run.id))); s.platform.conversation(c.id);
    const original = s.store.loadRecord<any>('agent_runs', first.run.id); s.store.saveRecord('agent_runs', { ...original, id: 'crashed', conversationId: undefined, status: 'running' }); s.store.saveRecord('agent_runs', { ...original, id: 'queued', conversationId: undefined, status: 'queued' });
    s.platform.shutdown(); s.store.close();
    const db = new TowerStore(file); const deps = { ...s.deps, store: db }; const architectures = new ArchitectureStore(db); const brains = new BrainConnections(deps, vi.fn(async () => response('Recovered'))); const resources = new AgentResources(deps); const runs = new AgentRuns(deps, architectures, brains, resources); const platform = new AgentPlatform(deps, architectures, brains, resources, runs);
    try { runs.bind({ launch: vi.fn(), prepareResources: x => x, agent: () => undefined, events: () => [], stop: vi.fn() }); await wait(() => runs.get('queued').status === 'succeeded'); expect(runs.get('crashed').status).toBe('interrupted'); expect(platform.deployment(d.id).version).toBe(1); expect(platform.conversation(c.id).messages.map(m => m.text)).toEqual(['Persistent task', 'Persistent reply']); }
    finally { platform.shutdown(); await runs.shutdown(); db.close(); }
  });
});
