import { createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createHostedGateway, hostedRole, type HostedAudit } from '../daemon/hosted/gateway.ts';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } });
async function listen(server: Server) { servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return (server.address() as any).port as number; }
async function setup() {
  const seen: { worker: string; path: string; token?: string; cookie?: string; actor?: string }[] = [];
  const worker = (name: string) => createServer((req, res) => { seen.push({ worker: name, path: req.url!, token: String(req.headers['x-tower-token']), cookie: req.headers.cookie, actor: String(req.headers['x-waystation-actor']) }); req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ worker: name })); });
  const a = await listen(worker('alpha')); const b = await listen(worker('beta')); const audit: HostedAudit[] = [];
  const gateway = createHostedGateway({ publicOrigin: 'https://agents.example.com', proxySecret: 'p'.repeat(48), cookieSecret: 'c'.repeat(48), organizations: [
    { id: 'alpha', name: 'Alpha', upstream: `http://127.0.0.1:${a}`, token: 'a'.repeat(48), project: '/workspace', members: { alice: 'admin', reader: 'viewer', runner: 'operator' } },
    { id: 'beta', name: 'Beta', upstream: `http://127.0.0.1:${b}`, token: 'b'.repeat(48), project: '/workspace', members: { bob: 'admin', alice: 'viewer' } },
  ], audit: e => audit.push(e) });
  const port = await listen(gateway);
  const call = (path: string, { subject = 'alice', method = 'GET', cookie, body, headers = {} }: { subject?: string; method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) => new Promise<{ status: number; data: any; cookie?: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: 'agents.example.com', 'x-waystation-subject': subject, 'x-waystation-proxy-secret': 'p'.repeat(48), ...(method !== 'GET' ? { origin: 'https://agents.example.com', 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers } }, res => { let value = ''; res.on('data', c => { value += c; }); res.on('end', () => { let data: any; try { data = JSON.parse(value); } catch { data = value; } resolve({ status: res.statusCode!, data, cookie: res.headers['set-cookie']?.[0].split(';')[0] }); }); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { call, seen, audit };
}
describe('hosted organization boundary', () => {
  it('requires authenticated proxy identity and never accepts a supplied worker token', async () => {
    const s = await setup();
    expect((await s.call('/api/architectures', { headers: { 'x-waystation-proxy-secret': 'wrong', 'x-tower-token': 'a'.repeat(48) } })).status).toBe(401);
    expect(s.seen).toHaveLength(0);
    expect((await s.call('/api/hosted/session', { subject: 'stranger' })).data.organizations).toEqual([]);
  });
  it('selects only memberships, signs organization selection, and binds it to the authenticated subject', async () => {
    const s = await setup();
    expect((await s.call('/api/architectures')).status).toBe(403);
    const choice = await s.call('/api/hosted/organization', { method: 'POST', body: { organizationId: 'alpha' } }); expect(choice.status).toBe(200);
    expect((await s.call('/api/architectures', { cookie: choice.cookie })).data.worker).toBe('alpha');
    expect(s.seen.at(-1)).toMatchObject({ token: 'a'.repeat(48), cookie: undefined, actor: 'alice' });
    expect((await s.call('/api/architectures', { subject: 'bob', cookie: choice.cookie })).status).toBe(403);
    expect((await s.call('/api/hosted/organization', { subject: 'bob', method: 'POST', body: { organizationId: 'alpha' } })).status).toBe(403);
    expect((await s.call('/api/architectures', { cookie: choice.cookie + 'forged' })).status).toBe(403);
  });
  it('isolates workers even when both organizations use identical resource ids', async () => {
    const s = await setup();
    expect((await s.call('/api/architectures/shared-id', { subject: 'reader' })).data.worker).toBe('alpha');
    expect((await s.call('/api/architectures/shared-id', { subject: 'bob' })).data.worker).toBe('beta');
    expect(s.seen.map(r => r.worker)).toEqual(['alpha', 'beta']);
    expect((await s.call('/api/agent-platform?project=%2Fworkspace', { subject: 'reader' })).status).toBe(200);
  });
  it('enforces viewer/operator/admin permissions, rejects desktop escape routes, and checks CSRF origins', async () => {
    const s = await setup();
    expect((await s.call('/api/architectures', { subject: 'reader', method: 'POST', body: {} })).status).toBe(403);
    expect((await s.call('/api/architectures/a/run', { subject: 'runner', method: 'POST', body: { text: 'task' } })).status).toBe(200);
    expect((await s.call('/api/agent-runs/a/decision', { subject: 'reader', method: 'POST', body: {} })).status).toBe(403);
    expect((await s.call('/api/agent-secrets', { subject: 'runner', method: 'POST', body: {} })).status).toBe(403);
    for (const path of ['/api/consoles', '/api/remote/session', '/mcp', '/agent/connectors/mcp', '/api/files', '/api/architectures/%2e%2e/consoles']) expect((await s.call(path, { subject: 'reader' })).status).toBeGreaterThanOrEqual(400);
    expect((await s.call('/api/architectures', { subject: 'bob', method: 'POST', body: {}, headers: { origin: 'https://attacker.example' } })).status).toBe(403);
    expect(s.audit.some(e => e.subject === 'runner' && e.organizationId === 'alpha' && e.path === '/api/architectures/a/run' && e.status === 200)).toBe(true);
  });
  it('does not accidentally expose new API routes with implicit full access', () => {
    expect(hostedRole('POST', '/api/new-powerful-feature')).toBeUndefined();
    expect(hostedRole('GET', '/api/agent-runs/id/trace')).toBe('viewer');
    expect(hostedRole('POST', '/api/agent-deployments/id/promote')).toBe('admin');
    expect(hostedRole('POST', '/api/architectures/id/nodes/a/test')).toBeUndefined();
    expect(hostedRole('POST', '/api/architectures/id/nodes/agent/test')).toBeUndefined();
  });
  it('forwards machine webhooks only to the named organization’s authenticated trigger endpoint', async () => {
    const s = await setup();
    const header = { 'x-waystation-proxy-secret': '', authorization: `Bearer ${'f'.repeat(64)}` };
    expect((await s.call('/hooks/alpha/trigger-id', { method: 'POST', headers: header })).status).toBe(200);
    expect(s.seen.at(-1)).toMatchObject({ worker: 'alpha', path: '/agent/agent-platform/trigger-id/invoke' });
    expect((await s.call('/hooks/beta/trigger-id', { method: 'POST', headers: { ...header, authorization: 'invalid' } })).status).toBe(403);
    expect((await s.call('/agent/agent-platform/trigger-id/invoke', { method: 'POST', headers: header })).status).toBe(401);
  });
});
