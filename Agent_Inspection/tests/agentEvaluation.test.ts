import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TowerStore } from '../daemon/store/db.ts';
import { SecretStore } from '../daemon/library/secretStore.ts';
import { ArchitectureStore } from '../daemon/architecture/store.ts';
import { AgentResources } from '../daemon/architecture/resources.ts';
import { BrainConnections } from '../daemon/architecture/brains.ts';
import { AgentRuns } from '../daemon/architecture/runs.ts';
import { AgentPlatform } from '../daemon/architecture/platform.ts';
import { AgentSecrets } from '../daemon/architecture/secrets.ts';
import { AgentSandboxes, type SandboxCommand } from '../daemon/architecture/sandboxes.ts';
import { AgentEvaluations } from '../daemon/architecture/evaluations.ts';
import { DEFAULT_SANDBOX } from '../shared/agentEvaluation.ts';
import { tempDir } from './helpers.ts';

const wait = async (predicate: () => boolean) => { const end = Date.now() + 10000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); } };
const response = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
function setup(send: typeof fetch = vi.fn(async () => response('Oslo'))) {
  const project = tempDir('agent-lab-'); const store = new TowerStore(':memory:'); const deps = { store, secrets: new SecretStore(':memory:'), audit: vi.fn(), paths: {} as any }; const architectures = new ArchitectureStore(store); const brains = new BrainConnections(deps, send); const resources = new AgentResources(deps); const runs = new AgentRuns(deps, architectures, brains, resources); const platform = new AgentPlatform(deps, architectures, brains, resources, runs); const secrets = new AgentSecrets(deps); const sandboxes = new AgentSandboxes(deps, (project, text) => brains.sanitize(project, resources.sanitize(project, text))); runs.sandboxes = sandboxes; const evaluations = new AgentEvaluations(deps, platform, runs, brains, sandboxes);
  const connection = brains.create(project, { label: 'Brain', provider: 'compatible', model: 'fixture', baseUrl: 'http://localhost:12345/v1' });
  const doc = architectures.create({ project, graph: { title: 'Test agent', description: '', nodes: [{ id: 'a', kind: 'agent', name: 'Agent', description: 'Answer the task.', x: 0, y: 0, runtime: { kind: 'api', policy: 'configured-tools', connectionId: connection.id, maxOutputTokens: 256 } }, { id: 'output', kind: 'output', name: 'Webhook', description: '', x: 200, y: 0, config: { type: 'output', destination: 'webhook', format: 'text', url: 'http://localhost:1/never-called' } }], edges: [{ id: 'e', source: 'a', target: 'output', label: '' }] } }).document;
  const deployment = platform.deploy(doc.id, 'a', { expectedRevision: 1 });
  return { project, store, deps, architectures, brains, resources, runs, platform, secrets, sandboxes, evaluations, connection, doc, deployment, close: async () => { platform.shutdown(); await evaluations.shutdown(); await runs.shutdown(); await sandboxes.shutdown(); store.close(); } };
}

describe('central agent secrets', () => {
  it('reuses one saved value across brains and tools, rotates consumers, preserves scopes and revokes without exposing values', async () => {
    const s = setup();
    try {
      const saved = s.secrets.save({ name: 'Research API key', kind: 'api-key', scope: 'workspace', value: 'private-first-key' });
      const brain = s.brains.create(s.project, { label: 'Shared brain', provider: 'openai', model: 'fixture', secretId: saved.id });
      const service = s.platform.saveConnection(s.project, { name: 'Shared search', kind: 'tavily', secretId: saved.id });
      expect(s.deps.secrets.get(`architecture-brain:${brain.id}:apiKey`)).toBe('private-first-key'); expect(s.deps.secrets.get(`architecture-resource:${service.id}:authorization`)).toBe('Bearer private-first-key');
      s.secrets.save({ value: 'private-replaced-key' }, saved.id); expect(s.deps.secrets.get(`architecture-resource:${service.id}:authorization`)).toBe('Bearer private-replaced-key');
      expect(s.brains.sanitize(s.project, 'private-replaced-key')).toBe('[redacted]'); expect(JSON.stringify(s.secrets.list())).not.toContain('private-replaced-key'); expect(s.secrets.list().find(r => r.id === saved.id)!.usages).toHaveLength(2);
      const scoped = s.secrets.save({ name: 'Project password', kind: 'password', scope: 'project', project: s.project, value: 'private-password' });
      expect(() => s.secrets.reference(tempDir(), scoped.id, 'password')).toThrow(/unavailable/); expect(() => s.secrets.reference(s.project, scoped.id, 'api-key')).toThrow(/api-key/);
      s.secrets.revoke(saved.id); expect(s.brains.list(s.project).find(c => c.id === brain.id)!.hasKey).toBe(false); expect(s.platform.connections(s.project).find(c => c.id === service.id)!.hasSecret).toBe(false);
    } finally { await s.close(); }
  });
  it('retains reference links through secret-store restarts and prevents cycles and accidental target deletion', () => {
    const file = join(tempDir('vault-file-'), 'secrets.json'); const secrets = new SecretStore(file); secrets.set('vault:key', 'hidden'); secrets.alias('consumer:key', 'vault:key', 'Bearer ');
    const reopened = new SecretStore(file); expect(reopened.get('consumer:key')).toBe('Bearer hidden'); expect(reopened.namesUnder('consumer:')).toEqual(['key']); expect(() => reopened.alias('vault:key', 'consumer:key')).toThrow(/cycle/);
    reopened.deleteUnder('consumer:'); expect(reopened.get('consumer:key')).toBeUndefined(); expect(reopened.get('vault:key')).toBe('hidden');
  });
  it('refuses revoked credentials instead of falling back to anonymous model or tool calls', async () => {
    const send = vi.fn(async () => response('unexpected')); const s = setup(send);
    try {
      const saved = s.secrets.save({ name: 'Shared key', kind: 'api-key', scope: 'workspace', value: 'saved-key' });
      const brain = s.brains.create(s.project, { label: 'Protected local endpoint', provider: 'compatible', model: 'fixture', baseUrl: 'http://localhost:1/v1', secretId: saved.id });
      const service = s.platform.saveConnection(s.project, { name: 'Search', kind: 'tavily', secretId: saved.id });
      s.secrets.revoke(saved.id);
      await expect(s.brains.run(brain.id, s.project, 'Answer', 'Task', { maxOutputTokens: 256 })).rejects.toThrow(/no usable API key/); expect(send).not.toHaveBeenCalled();
      await expect(s.resources.test({ document: s.doc, agentNodeId: 'a', runId: 'test' }, { id: 'tool', kind: 'tool', name: 'Protected HTTP', description: '', x: 0, y: 0, config: { type: 'tool', implementation: 'http', functionName: 'protected_http', inputSchema: { type: 'object' }, timeoutMs: 1000, method: 'POST', url: 'http://localhost:1/action', credentialId: service.id } }, {})).rejects.toThrow(/revoked or unavailable/);
    } finally { await s.close(); }
  });
  it('preserves credential references when a stale resource edit rolls back', async () => {
    const s = setup();
    try {
      const saved = s.secrets.save({ name: 'Shared key', kind: 'api-key', scope: 'workspace', value: 'first' }); const service = s.platform.saveConnection(s.project, { name: 'Search', kind: 'tavily', secretId: saved.id });
      const node = { id: 'tool', kind: 'tool' as const, name: 'HTTP', description: '', x: 0, y: 0, config: { type: 'tool' as const, implementation: 'http' as const, functionName: 'search', inputSchema: { type: 'object' }, timeoutMs: 1000, method: 'POST' as const, url: 'http://localhost:1/action', credentialId: service.id } };
      const doc = s.architectures.update(s.doc.id, 1, [{ type: 'put_node', node }]).document;
      expect(() => s.resources.save(s.architectures, doc.id, 1, node.id, { node, secrets: { authorization: 'temporary' } })).toThrow();
      s.secrets.save({ value: 'rotated' }, saved.id); expect(s.deps.secrets.get(`architecture-resource:${service.id}:authorization`)).toBe('Bearer rotated');
    } finally { await s.close(); }
  });
});

describe('local code sandboxes', () => {
  it('executes real isolated JavaScript, blocks host APIs and stops runaway code', async () => {
    const s = setup();
    try {
      const ok = await s.sandboxes.execute(s.project, DEFAULT_SANDBOX, 'return { value: input.n + 1, host: typeof process, network: typeof fetch };', { n: 3 }); expect(ok).toMatchObject({ status: 'succeeded', output: { value: 4, host: 'undefined', network: 'undefined' } });
      const failed = await s.sandboxes.execute(s.project, { ...DEFAULT_SANDBOX, timeoutMs: 100 }, 'while(true){}', null); expect(failed.status).toBe('failed');
      expect(() => s.sandboxes.start(s.project, { config: { ...DEFAULT_SANDBOX, language: 'python' }, code: 'print(1)' })).toThrow(/Docker/);
    } finally { await s.close(); }
  });
  it('constructs hardened Docker calls with no host mounts/secrets/network and cleans up owned containers', async () => {
    const s = setup(); const command = vi.fn<SandboxCommand>(async () => ({ code: 0, stdout: '4\n', stderr: '' })); const docker = new AgentSandboxes(s.deps, (_project, text) => text, command);
    try {
      const result = await docker.execute(s.project, { backend: 'docker', language: 'python', memoryMb: 128, timeoutMs: 2000 }, 'print(input["n"] + 1)', { n: 3 }); expect(result.status).toBe('succeeded');
      const args = command.mock.calls[0][0] as unknown as string[]; expect(args).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', '--cap-drop', 'ALL', '--pids-limit', '64', '--memory', '128m', '--pull', 'never', '--user', '65534:65534'])); expect(args).not.toContain('--mount'); expect(args).not.toContain('-v'); expect(JSON.stringify(args)).not.toContain(s.project); expect(args).toContain('python:3.12-alpine'); expect(command.mock.calls.at(-1)![0][0]).toBe('rm');
    } finally { await docker.shutdown(); await s.close(); }
  });
  it('exposes the configured sandbox as a real bounded agent tool in the API harness', async () => {
    const s = setup(vi.fn(async (_url, init) => { const body = JSON.parse(String(init!.body)); const result = body.messages.find((m: any) => m.role === 'tool'); return result ? response(result.content) : new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'sandbox', function: { name: 'execute_sandbox', arguments: '{"code":"return { answer: input.n + 1 };","input":{"n":4}}' } }] } }] })); }));
    try {
      const env = s.platform.saveEnvironment(s.project, { name: 'Sandboxed', maxConcurrentRuns: 1, network: 'configured', allowedHosts: [], sandbox: DEFAULT_SANDBOX });
      const doc = s.architectures.update(s.doc.id, 1, [{ type: 'remove_node', id: 'output' }]).document; const deployment = s.platform.deploy(doc.id, 'a', { expectedRevision: doc.revision, environmentId: env.id }); const run = s.platform.run(deployment.id, 'Calculate'); await wait(() => s.runs.get(run.id).status === 'succeeded');
      expect(s.runs.get(run.id).output).toContain('"answer":5'); expect(s.sandboxes.list(s.project)[0].runId).toBe(run.id); expect(s.runs.get(run.id).events.some(e => e.message === 'Sandbox execution finished')).toBe(true);
    } finally { await s.close(); }
  });
});

describe('datasets, evaluators and experiments', () => {
  it('versions examples and evaluators, scores exact/schema/code/judge outputs and records judge failures honestly', async () => {
    const s = setup(vi.fn(async () => response('{"score":0.8,"comment":"Grounded"}')));
    try {
      const d = s.evaluations.saveDataset({ project: s.project, name: 'Questions', examples: [{ id: 'one', input: 'City?', reference: 'Oslo', split: 'test' }] }); const updated = s.evaluations.saveDataset({ ...d, expectedRevision: 1, examples: [...d.examples, { id: 'two', input: 'Other?', reference: 'Paris' }] }, d.id); expect(updated.revision).toBe(2); expect(s.evaluations.dataset(d.id, 1).examples).toHaveLength(1); expect(() => s.evaluations.saveDataset({ ...updated, expectedRevision: 1 }, d.id)).toThrow(/changed/);
      const exact = s.evaluations.saveEvaluator({ project: s.project, name: 'Correctness', threshold: 1, spec: { kind: 'exact', ignoreCase: true } }); expect((await s.evaluations.score(exact, 'City?', 'OSLO', 'Oslo')).score).toBe(1);
      const json = s.evaluations.saveEvaluator({ project: s.project, name: 'Shape', threshold: 1, spec: { kind: 'json', schema: { type: 'object', required: ['answer'] } } }); expect((await s.evaluations.score(json, '', '{}', '')).score).toBe(0);
      const code = s.evaluations.saveEvaluator({ project: s.project, name: 'Custom', threshold: 0.5, spec: { kind: 'javascript', code: 'return {score: input.output.includes(input.reference) ? 1 : 0, comment:"Checked"};' } }); expect((await s.evaluations.score(code, 'City?', 'Oslo', 'Oslo')).passed).toBe(true);
      const judge = s.evaluations.saveEvaluator({ project: s.project, name: 'Judge', threshold: 0.7, spec: { kind: 'llm', connectionId: s.connection.id, criteria: 'Check grounded correctness.' } }); const score = await s.evaluations.score(judge, 'City?', 'Oslo', 'Oslo'); expect(score).toMatchObject({ score: 0.8, passed: true }); expect(score.usage!.outputTokens).toBe(5);
      const invalid = s.evaluations.saveEvaluator({ project: s.project, name: 'Invalid score', threshold: 1, spec: { kind: 'javascript', code: 'return {score: 10};' } }); const bad = await s.evaluations.score(invalid, '', '', ''); expect(bad.score).toBeUndefined(); expect(bad.error).toContain('between 0 and 1');
    } finally { await s.close(); }
  });
  it('runs repeatable experiments through actual agent runs, isolates memory/output delivery and compares frozen versions', async () => {
    const s = setup();
    try {
      const dataset = s.evaluations.saveDataset({ project: s.project, name: 'Cities', examples: [{ id: 'oslo', input: 'City?', reference: 'Oslo' }] }); const evaluator = s.evaluations.saveEvaluator({ project: s.project, name: 'Exact', threshold: 1, spec: { kind: 'exact', ignoreCase: false } });
      const first = s.evaluations.create({ name: 'Baseline', deploymentId: s.deployment.id, datasetId: dataset.id, evaluatorIds: [evaluator.id], repetitions: 2, allowTools: false });
      const drive = async (id: string) => { const end = Date.now() + 10000; while (s.evaluations.get(id).status === 'running') { if (Date.now() > end) throw new Error('Experiment timed out'); await s.evaluations.tick(); await new Promise(r => setTimeout(r, 10)); } };
      await drive(first.id); const complete = s.evaluations.get(first.id); expect(complete.cases).toHaveLength(2); expect(complete.cases.every(c => c.status === 'completed' && c.scores[0].score === 1)).toBe(true); expect(s.runs.get(complete.cases[0].runId!).events.some(e => e.message.includes('external delivery disabled'))).toBe(true); expect(s.runs.get(complete.cases[0].runId!).source).toBe('experiment');
      s.evaluations.saveEvaluator({ ...evaluator, expectedVersion: 1, spec: { kind: 'contains', text: 'Paris', ignoreCase: false } }, evaluator.id); expect(s.evaluations.get(first.id).evaluators[0].spec.kind).toBe('exact');
      const candidate = s.evaluations.create({ name: 'Candidate', deploymentId: s.deployment.id, datasetId: dataset.id, evaluatorIds: [evaluator.id] }); await drive(candidate.id); const comparison = s.evaluations.compare(first.id, candidate.id); expect(comparison.rows[0].candidate!.scores[0].score).toBe(0); expect(comparison.rows[0].deltas).toEqual([]);
      const reversed = s.evaluations.compare(candidate.id, first.id); expect(reversed.rows).toHaveLength(2); expect(reversed.rows[1].baseline).toBeUndefined(); expect(reversed.rows[1].candidate?.repetition).toBe(2);
      const retry = s.evaluations.create({}, first.id); await drive(retry.id); expect(s.evaluations.get(retry.id).cases[0].scores[0].score).toBe(1);
    } finally { await s.close(); }
  });
  it('cancels pending cases and accepted runs without submitting additional work', async () => {
    const s = setup(vi.fn(async (_url, init) => new Promise<Response>((resolve, reject) => { const timer = setTimeout(() => resolve(response('Oslo')), 5000); init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Aborted')); }, { once: true }); })));
    try {
      const dataset = s.evaluations.saveDataset({ project: s.project, name: 'Cancel tasks', examples: Array.from({ length: 6 }, (_, i) => ({ id: `case-${i}`, input: 'City?', reference: 'Oslo' })) }); const evaluator = s.evaluations.saveEvaluator({ project: s.project, name: 'Exact', threshold: 1, spec: { kind: 'exact' } });
      const experiment = s.evaluations.create({ name: 'Cancelled batch', deploymentId: s.deployment.id, datasetId: dataset.id, evaluatorIds: [evaluator.id] }); await s.evaluations.tick(); await wait(() => s.evaluations.get(experiment.id).cases.some(c => c.runId));
      const stopped = await s.evaluations.cancel(experiment.id); expect(stopped.status).toBe('cancelled'); expect(stopped.cases.every(c => c.status === 'cancelled')).toBe(true); const ids = stopped.cases.flatMap(c => c.runId ?? []); expect(ids.length).toBeLessThan(6); await s.evaluations.tick(); expect(s.evaluations.get(experiment.id).cases.flatMap(c => c.runId ?? [])).toEqual(ids); expect(ids.every(id => s.runs.get(id).status === 'cancelled')).toBe(true);
    } finally { await s.close(); }
  });
});
