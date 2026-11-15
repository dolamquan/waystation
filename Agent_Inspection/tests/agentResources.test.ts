import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TowerStore } from '../daemon/store/db.ts';
import { SecretStore } from '../daemon/library/secretStore.ts';
import { ArchitectureStore } from '../daemon/architecture/store.ts';
import { AgentResources, routeResult } from '../daemon/architecture/resources.ts';
import { defaultResource, validateResource, type ToolConfig } from '../shared/agentResources.ts';
import { tempDir } from './helpers.ts';
import type { ArchitectureDocument, ArchitectureNode } from '../shared/architecture.ts';
import { Client } from 'pg';

function setup() {
  const project = tempDir('resource-project-'); const store = new TowerStore(':memory:');
  const deps = { store, secrets: new SecretStore(':memory:'), audit: vi.fn(), paths: {} as any };
  const architectures = new ArchitectureStore(store); const resources = new AgentResources(deps);
  const doc = architectures.create({ project }).document;
  const context = { document: doc, agentNodeId: 'a', runId: 'run-1' };
  const node = (id: string, kind: ArchitectureNode['kind']): ArchitectureNode => ({ id, kind, name: id, description: '', x: 0, y: 0, config: defaultResource(kind) });
  return { project, store, deps, architectures, resources, doc, context, node };
}
describe('configured agent resources', () => {
  it('applies the configured PostgreSQL context limit in the parameterized SELECT', async () => {
    const s = setup();
    const connect = vi.spyOn(Client.prototype, 'connect').mockImplementation((async () => {}) as any); const end = vi.spyOn(Client.prototype, 'end').mockImplementation((async () => {}) as any);
    const entries = [{ key: 'a', value: 1 }, { key: 'b', value: 2 }];
    const query = vi.spyOn(Client.prototype, 'query').mockImplementation((async (_sql: string, values: unknown[]) => ({ rows: entries.slice(0, values[2] as number) })) as any);
    const memory = s.node('postgres', 'memory'); memory.config = { ...defaultResource('memory')!, backend: 'postgres', host: 'localhost', port: 5432, database: 'db', user: 'user', table: 'memory', tls: false, contextItems: 1 } as any;
    try { expect(await s.resources.memory(s.context, memory, 'list')).toHaveLength(1); expect(query.mock.calls[0][0]).toContain('LIMIT $3'); expect((query.mock.calls[0] as any[])[1][2]).toBe(1); }
    finally { connect.mockRestore(); end.mockRestore(); query.mockRestore(); s.store.close(); }
  });
  it('drops hidden JSON schemas when input switches to text and ignores legacy text-mode schemas during testing', async () => {
    const s = setup(); const schema = { type: 'object', required: ['task'] };
    try {
      expect(validateResource('input', { type: 'input', format: 'text', schema })).toEqual({ type: 'input', format: 'text' });
      const input = s.node('input', 'input'); input.config = { type: 'input', format: 'text', schema };
      expect(await s.resources.test(s.context, input, 'ordinary text')).toEqual({ ok: true, value: 'ordinary text' });
      input.config = { type: 'input', format: 'json', schema };
      await expect(s.resources.test(s.context, input, '{}')).rejects.toThrow(/schema/);
    } finally { s.store.close(); }
  });
  it('persists SQLite memory, isolates agent/shared namespaces, expires values, and probes without evicting real data', async () => {
    const s = setup(); const memory = s.node('memory', 'memory'); memory.config = { ...defaultResource('memory')!, maxEntries: 1 } as any;
    try {
      await s.resources.memory(s.context, memory, 'put', 'preference', { city: 'Seattle' });
      expect(await s.resources.memory(s.context, memory, 'get', 'preference')).toMatchObject({ value: { city: 'Seattle' } });
      expect(await s.resources.memory({ ...s.context, agentNodeId: 'other' }, memory, 'get', 'preference')).toBeNull();
      await s.resources.test(s.context, memory, {});
      expect(await s.resources.memory(s.context, memory, 'get', 'preference')).toMatchObject({ value: { city: 'Seattle' } });
      await s.resources.memory(s.context, memory, 'put', 'new', 2);
      expect(await s.resources.memory(s.context, memory, 'get', 'preference')).toBeNull();
      const entry = s.store.loadRecords<any>('agent_memory_records')[0]; s.store.saveRecord('agent_memory_records', { ...entry, expiresAt: 0 });
      expect(await s.resources.memory(s.context, memory, 'get', 'new')).toBeNull();
      memory.config = { ...memory.config, scope: 'shared' } as any;
      await s.resources.memory(s.context, memory, 'put', 'shared', true);
      expect(await s.resources.memory({ ...s.context, agentNodeId: 'other' }, memory, 'get', 'shared')).toMatchObject({ value: true });
    } finally { s.store.close(); }
  });
  it('executes authored JavaScript in a bounded interpreter and validates arguments', async () => {
    const s = setup(); const tool = s.node('calculator', 'tool');
    tool.config = { type: 'tool', implementation: 'javascript', functionName: 'calculate', timeoutMs: 1000, inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false }, code: 'return { total: input.n + 1, process: typeof process, require: typeof require, fetch: typeof fetch };' };
    try {
      expect(await s.resources.invoke(s.context, tool, { n: 4 })).toEqual({ total: 5, process: 'undefined', require: 'undefined', fetch: 'undefined' });
      await expect(s.resources.invoke(s.context, tool, { n: 'bad' })).rejects.toThrow(/schema/);
      tool.config = { ...tool.config, timeoutMs: 100, code: 'while(true) {}' };
      await expect(s.resources.invoke(s.context, tool, { n: 1 })).rejects.toThrow(/JavaScript tool failed/);
      tool.config = { ...tool.config, code: 'return input.constructor.constructor("return process")();' };
      await expect(s.resources.invoke(s.context, tool, { n: 1 })).rejects.toThrow(/JavaScript tool failed/);
      tool.config = { ...tool.config, code: 'return Promise.resolve(42);' };
      await expect(s.resources.invoke(s.context, tool, { n: 1 })).rejects.toThrow(/JavaScript tool failed/);
    } finally { s.store.close(); }
  });
  it('saves write-only HTTP credentials, calls a real local endpoint, and rejects foreign refs and stale resource edits', async () => {
    const s = setup(); let authorization: string | undefined; let received: any;
    const server = createServer(async (req, res) => { authorization = req.headers.authorization; let body = ''; for await (const chunk of req) body += chunk; received = JSON.parse(body); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ input: received, echoed: req.headers.authorization })); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const tool = s.node('http', 'tool');
      tool.config = { type: 'tool', implementation: 'http', functionName: 'http_tool', inputSchema: { type: 'object' }, timeoutMs: 1000, method: 'POST', url: `http://127.0.0.1:${(server.address() as any).port}/tool` };
      let doc = s.architectures.update(s.doc.id, 1, [{ type: 'put_node', node: tool }]).document;
      doc = s.resources.save(s.architectures, doc.id, doc.revision, tool.id, { node: tool, secrets: { authorization: 'Bearer private-resource-token' } }).document;
      const saved = doc.nodes[0]; expect(JSON.stringify(saved)).not.toContain('private-resource-token'); expect(s.resources.credentialStatus(doc.project, saved).authorization).toBe(true);
      expect(await s.resources.invoke({ ...s.context, document: doc }, saved, { text: 'hello' })).toEqual({ input: { text: 'hello' }, echoed: '[redacted]' });
      expect(authorization).toBe('Bearer private-resource-token');
      await expect(s.resources.invoke({ ...s.context, document: { ...doc, project: tempDir() } }, saved, {})).rejects.toThrow(/credentials/);
      const before = s.store.loadRecords('architecture_credentials').length;
      expect(() => s.resources.save(s.architectures, doc.id, 1, tool.id, { node: tool, secrets: { authorization: 'another-secret' } })).toThrow(/changed/);
      expect(s.store.loadRecords('architecture_credentials')).toHaveLength(before);
      expect(() => s.resources.save(s.architectures, doc.id, 1, tool.id, { node: saved, secrets: { authorization: 'stale-replacement' } })).toThrow(/changed/);
      await s.resources.invoke({ ...s.context, document: doc }, saved, {}); expect(authorization).toBe('Bearer private-resource-token');
      const output = s.node('webhook', 'output'); output.config = { type: 'output', destination: 'webhook', format: 'json', url: (saved.config as ToolConfig).url, credentialId: (saved.config as ToolConfig).credentialId };
      expect(await s.resources.deliver({ ...s.context, document: doc }, output, '{"answer":42}')).toEqual({ destination: 'webhook', delivered: true });
      expect(received).toEqual({ runId: 'run-1', agentId: 'a', output: { answer: 42 } });
    } finally { server.close(); s.store.close(); }
  });
  it('writes real output artifacts, checks JSON schemas, rejects unsafe paths and leaves existing files untouched', async () => {
    const s = setup(); const output = s.node('out', 'output'); output.config = { type: 'output', destination: 'file', format: 'json', path: 'results/{runId}.json', schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] } };
    try {
      await expect(s.resources.deliver(s.context, output, 'not json')).rejects.toThrow(/valid JSON/);
      await expect(s.resources.deliver(s.context, output, '{"answer":"bad"}')).rejects.toThrow(/schema/);
      await s.resources.deliver(s.context, output, '{"answer":42}');
      const file = join(s.project, 'results/run-1.json'); expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ answer: 42 });
      await expect(s.resources.deliver(s.context, output, '{"answer":99}')).rejects.toThrow(/never overwritten/);
      expect(JSON.parse(readFileSync(file, 'utf8')).answer).toBe(42);
      for (const path of ['../outside.txt', 'C:/outside.txt', '.git/config', '/tmp/out']) expect(() => validateResource('output', { ...output.config, path })).toThrow();
      expect(() => validateResource('memory', { ...defaultResource('memory'), backend: 'postgres', host: 'localhost', port: 5432, database: 'x', user: 'x', table: 'x; DROP TABLE users' })).toThrow(/Table names/);
    } finally { s.store.close(); }
  });
  it('evaluates real routing conditions without executing code', () => {
    const config = { type: 'router' as const, rules: [{ field: 'result.status', operator: 'equals' as const, value: 'approved', target: 'out' }], fallback: 'review' };
    expect(routeResult(config, { result: { status: 'approved' } })).toBe('out'); expect(routeResult(config, {})).toBe('review');
    expect(routeResult({ ...config, rules: [{ field: '__proto__.constructor', operator: 'exists', value: '', target: 'bad' }] }, {})).toBe('review');
  });
});
