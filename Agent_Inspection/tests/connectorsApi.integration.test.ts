import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tempDir } from './helpers.ts';

const HOME = tempDir('connector-api-'); const PROJECT = tempDir('connector-api-project-');
process.env.AGENT_TOWER_HOME = HOME; process.env.CLAUDE_HOME = tempDir('connector-api-claude-');
const PORT = 47378; const TOKEN = 'connector-operator-test';
let tower: import('../daemon/tower.ts').Tower; let server: Server;
const realFetch = globalThis.fetch;
const upstream = vi.fn(async () => Response.json([{ id: 'message-fixture', content: 'Simulated provider result' }]));
async function call(method: string, path: string, body?: unknown, token = TOKEN, extra = {}) {
  const response = await realFetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { 'content-type': 'application/json', 'x-tower-token': token, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
beforeAll(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => String(url).startsWith('https://discord.com/') ? upstream() : realFetch(url, init));
  const { Tower } = await import('../daemon/tower.ts'); const { startServer } = await import('../daemon/api/server.ts');
  tower = new Tower(join(HOME, 'state.db')); server = await startServer({ tower, port: PORT, host: '127.0.0.1', token: TOKEN });
}, 30_000);
afterAll(async () => { server?.close(); await tower?.shutdown(); vi.restoreAllMocks(); });

describe('app access API and MCP transport', () => {
  let accountId: string; let architectureId: string; let grantId: string; let grantToken: string; let capabilityId: string;
  it('requires operator authentication and rejects cross-origin requests', async () => {
    expect((await call('GET', `/api/connectors?project=${encodeURIComponent(PROJECT)}`, undefined, 'wrong')).status).toBe(401);
    expect((await call('POST', '/api/connectors/accounts', {}, TOKEN, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', '/api/connectors/accounts', { project: PROJECT, provider: 'discord', label: 'Support', token: 'private-discord-provider-token', tools: ['discord_history', 'discord_send'] })).status).toBe(200);
    const state = await call('GET', `/api/connectors?project=${encodeURIComponent(PROJECT)}`); accountId = state.data.accounts[0].id;
    expect(JSON.stringify(state)).not.toContain('private-discord-provider-token');
    expect(state.data.redirectUri).toBe(`http://localhost:${PORT}/agent/connectors/oauth/callback`);
  });
  it('attaches versioned HTTP capabilities and saves a scoped MCP connection without modifying runtime policy', async () => {
    const doc = (await call('POST', '/api/architectures', { project: PROJECT, graph: 'starter' })).data.document; architectureId = doc.id;
    const stale = await call('POST', '/api/connectors/grants', { accountId, architectureId, nodeId: 'builder', expectedRevision: 0, tools: ['discord_history'] }); expect(stale.status).toBe(400);
    const created = await call('POST', '/api/connectors/grants', { accountId, architectureId, nodeId: 'builder', expectedRevision: doc.revision, tools: ['discord_history', 'discord_send'] });
    expect(created.status, created.data.error).toBe(200); grantId = created.data.grant.id; grantToken = created.data.mcpConfig.headers.Authorization;
    const node = created.data.snapshot.document.nodes.find((n: any) => n.id === 'builder'); expect(node.capabilities).toHaveLength(2); expect(node.runtime).toBeUndefined();
    capabilityId = node.capabilities[0].id;
    const cap = tower.library.agentPlatform.capability(PROJECT, capabilityId, 1);
    expect(cap.spec).toMatchObject({ kind: 'tool', config: { implementation: 'http', url: `http://127.0.0.1:${PORT}/agent/connectors/call/discord_history` } });
    expect(tower.library.mcp.list().find(m => m.id === created.data.mcpId)).toMatchObject({ defaultOn: false, transport: 'http' });
    expect(JSON.stringify(created.data.snapshot)).not.toContain(grantToken); expect(JSON.stringify(tower.library.mcp.list())).not.toContain(grantToken);
  });
  it('exposes only authorized MCP tools and accepts initialize and notification messages', async () => {
    expect((await call('POST', '/agent/connectors/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
    const list = await call('POST', '/agent/connectors/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, '', { authorization: grantToken });
    expect(list.data.result.tools.map((t: any) => t.name)).toEqual(['discord_history', 'discord_send', 'connector_approval_status']);
    const initialize = await call('POST', '/agent/connectors/mcp', { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, '', { authorization: grantToken });
    expect(initialize.data.result.protocolVersion).toBe('2025-06-18');
    const notification = await realFetch(`http://127.0.0.1:${PORT}/agent/connectors/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: grantToken }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }); expect(notification.status).toBe(204);
    const tool = await call('POST', '/agent/connectors/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gmail_read', arguments: {} } }, '', { authorization: grantToken }); expect(tool.data.result.isError).toBe(true);
  });
  it('executes attached architecture tools through the broker and keeps write approval separate from agent access', async () => {
    const cap = tower.library.agentPlatform.capability(PROJECT, capabilityId, 1);
    if (cap.spec.kind !== 'tool') throw new Error('Expected a tool');
    const doc = tower.library.automation.architectures.get(architectureId).document;
    const result = await tower.library.resources.invoke({ document: doc, agentNodeId: 'builder', runId: 'fixture' }, { id: 'fixture-tool', kind: 'tool', name: 'Read messages', description: '', x: 0, y: 0, config: cap.spec.config }, { channel: '123' });
    expect(result).toEqual([{ id: 'message-fixture', content: 'Simulated provider result' }]); expect(upstream).toHaveBeenCalledOnce();
    const pending = await call('POST', '/agent/connectors/call/discord_send', { channel: '123', text: 'This is a simulated write.' }, '', { authorization: grantToken }); expect(pending.data.status).toBe('approval_required'); expect(upstream).toHaveBeenCalledOnce();
    expect((await call('POST', `/api/connectors/approvals/${pending.data.approvalId}`, { approve: true }, '', { authorization: grantToken })).status).toBe(401);
    const approved = await call('POST', `/api/connectors/approvals/${pending.data.approvalId}`, { approve: true }); expect(approved.data.status).toBe('succeeded'); expect(upstream).toHaveBeenCalledTimes(2);
    expect((await call('POST', `/api/connectors/approvals/${pending.data.approvalId}`, { approve: true })).status).toBe(400);
  });
  it('rejects revoked tokens for every bridge and keeps unrelated graph edits', async () => {
    const latest = tower.library.automation.architectures.get(architectureId).document;
    tower.library.automation.architectures.update(architectureId, latest.revision, [{ type: 'describe', title: 'Concurrent architecture edit', description: latest.description }]);
    await call('POST', `/api/connectors/grants/${grantId}/revoke`, {});
    expect((await call('POST', '/agent/connectors/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/list' }, '', { authorization: grantToken })).status).toBe(401);
    expect((await call('POST', '/agent/connectors/call/discord_history', { channel: '123' }, '', { authorization: grantToken })).status).toBe(401);
    expect(tower.library.automation.architectures.get(architectureId).document.title).toBe('Concurrent architecture edit');
  });
  it('does not reflect OAuth state, authorization codes or provider errors in the browser callback', async () => {
    const response = await realFetch(`http://localhost:${PORT}/agent/connectors/oauth/callback?code=private-code&state=unknown-state`);
    expect(response.status).toBe(400); const html = await response.text(); expect(html).not.toMatch(/private-code|unknown-state/);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
