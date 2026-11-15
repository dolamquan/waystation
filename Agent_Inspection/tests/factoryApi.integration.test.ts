import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factoryDefaults, type FactoryHost } from '../daemon/factory/engine.ts';
import type { Agent, AgentEvent } from '../daemon/domain/types.ts';
import { makeAgent, makeRepo, tempDir } from './helpers.ts';
import type { FactoryDefinition, FactoryItem } from '../shared/factory.ts';
import type { ManagedLaunch } from '../daemon/managed/types.ts';
import { FACTORY_TOKEN_ENV } from '../daemon/factory/bridge.ts';

const PORT = 47_348; const TOKEN = 'factory-api-test-0123456789abcdef';
const isolated = tempDir('factory-api-'); process.env.AGENT_TOWER_HOME = isolated; process.env.CLAUDE_HOME = tempDir('factory-claude-');
let tower: import('../daemon/tower.ts').Tower; let server: Server;
const agents = new Map<string, Agent>(); const events = new Map<string, AgentEvent[]>(); let sequence = 0; let lastLaunch: ManagedLaunch | undefined;
const host: FactoryHost = {
  launch: input => { lastLaunch = input; const agent = makeAgent({ id: `managed:api-${++sequence}`, cwd: input.cwd, status: 'busy' }); agents.set(agent.id, agent); return agent; },
  agent: id => agents.get(id), events: id => events.get(id) ?? [], stop: async id => { const agent = agents.get(id); if (agent) agents.set(id, { ...agent, status: 'stopped' }); },
};
const call = async (method: string, path: string, body?: unknown, token = TOKEN, origin?: string) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { 'content-type': 'application/json', 'x-tower-token': token, ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, json: await response.json() as any };
};
beforeAll(async () => {
  const { Tower } = await import('../daemon/tower.ts'); const { startServer } = await import('../daemon/api/server.ts');
  tower = new Tower(join(isolated, 'factory.db'), { factoryHost: host, factoryRoot: join(isolated, 'workspaces') });
  server = await startServer({ tower, port: PORT, host: '127.0.0.1', token: TOKEN });
}, 30_000);
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await tower?.shutdown(); });
describe('factory HTTP API', () => {
  let factory: FactoryDefinition; let item: FactoryItem;
  const repository = makeRepo({ 'verify.cjs': 'const fs = require("node:fs"); if (fs.readFileSync("feature.txt", "utf8") !== "implemented") process.exit(1); console.log("Behavior passed");' });
  it('requires the operator token and rejects cross-origin mutations', async () => {
    expect((await call('GET', '/api/factory', undefined, 'wrong')).status).toBe(401);
    expect((await call('POST', '/api/factory/definitions', {}, TOKEN, 'https://example.com')).status).toBe(403);
  });
  it('creates and reads a factory without launching agents', async () => {
    const defaults = factoryDefaults(); const result = await call('POST', '/api/factory/definitions', { name: 'API factory', repository, ...defaults, workflow: { ...defaults.workflow, review: false, checks: [{ name: 'Behavior', command: 'node verify.cjs' }] } });
    expect(result.status).toBe(200); factory = result.json.factory;
    expect((await call('GET', '/api/factory')).json.factories[0].id).toBe(factory.id); expect(sequence).toBe(0);
  });
  it('saves settings and rejects stale writes and malformed requests', async () => {
    const updated = await call('POST', `/api/factory/definitions/${factory.id}`, { ...factory, context: 'Preserve behavior' }); expect(updated.status).toBe(200);
    expect((await call('POST', `/api/factory/definitions/${factory.id}`, factory)).status).toBe(400); factory = updated.json.factory;
    expect((await call('POST', '/api/factory/items', { factoryId: factory.id, title: 'Missing criteria', request: 'Build' })).status).toBe(400);
  });
  it('queues work and guards invalid actions through HTTP', async () => {
    const created = await call('POST', '/api/factory/items', { factoryId: factory.id, title: 'API behavior', request: 'Write feature.txt containing implemented', criteria: 'Behavior check passes' });
    expect(created.status).toBe(200); item = created.json.item; expect(item.status).toBe('queued'); expect(item.definition.revision).toBe(2);
    expect((await call('POST', `/api/factory/items/${item.id}/action`, { action: 'accept' })).status).toBe(400);
    expect((await call('GET', `/api/factory/items/${item.id}/diff`)).status).toBe(400);
  });
  it('runs plan approval, implementation, real validation, acceptance and delivery', async () => {
    const action = (action: string) => call('POST', `/api/factory/items/${item.id}/action`, { action });
    expect((await action('start')).status).toBe(200);
    let current = tower.factory.snapshot().items[0]; const plannerId = current.attempts.at(-1)!.agentId!;
    agents.set(plannerId, { ...agents.get(plannerId)!, status: 'idle' }); events.set(plannerId, [{ agentId: plannerId, kind: 'assistant', summary: 'Implement feature.txt and run the behavior check.', ts: Date.now() }]); await tower.factory.tick();
    expect((await call('GET', '/api/factory')).json.items[0].status).toBe('plan_review');
    expect((await action('approve-plan')).status).toBe(200); current = tower.factory.snapshot().items[0];
    writeFileSync(join(current.workspace!, 'feature.txt'), 'implemented'); const builderId = current.attempts.at(-1)!.agentId!;
    agents.set(builderId, { ...agents.get(builderId)!, status: 'idle' }); await tower.factory.tick();
    const deadline = Date.now() + 8000;
    while (tower.factory.snapshot().items[0].status === 'validating' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    current = tower.factory.snapshot().items[0]; expect(current.status).toBe('acceptance'); expect(current.evidence[0].output).toContain('Behavior passed');
    expect((await call('GET', `/api/factory/items/${item.id}/diff`)).json.diff.patch).toContain('implemented');
    expect((await action('accept')).status).toBe(200); expect((await action('merge')).json.item.status).toBe('delivered');
  });
  it('serves the factory bridge only to the running attempt', async () => {
    const created = await call('POST', '/api/factory/items', { factoryId: factory.id, title: 'Bridge', request: 'Plan it', criteria: 'A plan exists' });
    const id = created.json.item.id;
    expect((await call('POST', `/api/factory/items/${id}/action`, { action: 'start' })).status).toBe(200);
    const agentToken = lastLaunch!.env![FACTORY_TOKEN_ENV];
    const bridge = (path: string, token: string, body: unknown = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-token': token }, body: JSON.stringify(body) })
      .then(async response => ({ status: response.status, json: await response.json() as any }));
    expect(lastLaunch!.mcpServers?.factory.env).toEqual({ WAYSTATION_FACTORY_URL: `http://127.0.0.1:${PORT}` });
    expect((await bridge('/agent/factory/tools', 'forged')).status).toBe(401);
    expect((await bridge('/agent/factory/tools', TOKEN)).status).toBe(401);
    expect((await bridge('/agent/factory/tools', agentToken)).json.tools.map((tool: { name: string }) => tool.name)).toEqual(['submit_plan']);
    const submitted = await bridge('/agent/factory/call', agentToken, { name: 'submit_plan', arguments: { summary: 'Short plan', plan: 'Write feature.txt' } });
    expect(submitted).toMatchObject({ status: 200, json: { isError: false } });
    expect(tower.factory.snapshot().items.find(entry => entry.id === id)?.attempts[0].submission?.summary).toBe('Short plan');
    await call('POST', `/api/factory/items/${id}/action`, { action: 'pause' });
    expect((await bridge('/agent/factory/call', agentToken, { name: 'submit_plan', arguments: { summary: 'Late', plan: 'Late' } })).status).toBe(401);
  });
  it('reports a non-Git folder as a useful client error', async () => {
    const defaults = factoryDefaults(); const result = await call('POST', '/api/factory/definitions', { name: 'Invalid repository', repository: tempDir(), ...defaults, workflow: { ...defaults.workflow, checks: [{ name: 'Check', command: 'node --version' }] } });
    const created = await call('POST', '/api/factory/items', { factoryId: result.json.factory.id, title: 'Attempt', request: 'Work', criteria: 'Defined' });
    const started = await call('POST', `/api/factory/items/${created.json.item.id}/action`, { action: 'start' });
    expect(started.status).toBe(400); expect(started.json.error).toMatch(/not a git repository|larger git repository/);
  });
});
