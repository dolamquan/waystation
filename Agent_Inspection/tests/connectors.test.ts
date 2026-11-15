import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorBroker } from '../daemon/connectors/broker.ts';
import { connectorRpc } from '../daemon/connectors/rpc.ts';
import { providerRequest } from '../daemon/connectors/providers.ts';
import { TowerStore } from '../daemon/store/db.ts';
import { SecretStore } from '../daemon/library/secretStore.ts';
import type { LibraryDeps } from '../daemon/library/deps.ts';
import { ArchitectureStore } from '../daemon/architecture/store.ts';
import { tempDir } from './helpers.ts';
import { CONNECTOR_PROVIDERS } from '../shared/connectors.ts';
import { McpCatalog } from '../daemon/library/mcpCatalog.ts';

const PROJECT = tempDir('connector-project-'); const OTHER = tempDir('connector-other-');
const callback = 'http://localhost:4317/agent/connectors/oauth/callback';
const stores: TowerStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup(send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }))) {
  const store = new TowerStore(':memory:'); stores.push(store);
  const secrets = new SecretStore(':memory:'); const audit = vi.fn();
  const deps: LibraryDeps = { store, secrets, audit, paths: { skillsLibraryDir: '', docsDir: '', loadoutsDir: '', claudeHome: '' } };
  let time = 100_000; const broker = new ConnectorBroker(deps, send, () => time);
  const doc = new ArchitectureStore(store).create({ project: PROJECT, graph: 'starter' }).document;
  const connect = () => broker.connect({ project: PROJECT, provider: 'discord', label: 'Support bot', token: 'provider-private-token', tools: ['discord_history', 'discord_send'] }, callback).account;
  const grant = (accountId: string, more = {}) => broker.createGrant({ accountId, nodeId: 'builder', tools: ['discord_history', 'discord_send'], ...more }, doc);
  return { broker, deps, send, audit, doc, connect, grant, advance: (ms: number) => { time += ms; } };
}
function redirect(auth: string, code = 'private-code') { const state = new URL(auth).searchParams.get('state')!; return new URL(`${callback}?state=${state}&code=${code}`); }

describe('connector authorization and grants', () => {
  it('registers only the daemon broker without allowing arbitrary private MCP destinations or forged markers', () => {
    const { deps } = setup(); const catalog = new McpCatalog(deps); const id = '11223344-5566-7788-9900-aabbccddeeff';
    const original = process.env.WAYSTATION_ALLOW_PRIVATE_FETCH; delete process.env.WAYSTATION_ALLOW_PRIVATE_FETCH;
    try {
      expect(() => catalog.create({ name: 'forged', transport: 'http', url: 'http://127.0.0.1:4317/agent/connectors/mcp', localConnector: true })).toThrow('loopback');
      expect(() => catalog.registerConnector(id, 'Test', 'http://127.0.0.1:4317/api/state', 'grant-only-token')).toThrow('endpoint');
      const registered = catalog.registerConnector(id, 'App access', 'http://127.0.0.1:4317/agent/connectors/mcp', 'grant-only-token');
      expect(registered.defaultOn).toBe(false); expect(JSON.stringify(registered)).not.toContain('grant-only-token');
      const edited = catalog.update(registered.id, { name: registered.name, label: 'Renamed app access', transport: 'http', url: registered.url }); expect(edited.label).toBe('Renamed app access');
      expect(() => catalog.update(registered.id, { name: registered.name, transport: 'http', url: 'http://127.0.0.1:4318/api/private' })).toThrow('loopback');
    } finally { if (original === undefined) delete process.env.WAYSTATION_ALLOW_PRIVATE_FETCH; else process.env.WAYSTATION_ALLOW_PRIVATE_FETCH = original; }
  });
  it('keeps provider credentials out of public state, graphs, records, MCP tools and audit', async () => {
    const { broker, deps, audit, connect, grant } = setup(); const account = connect(); const g = grant(account.id);
    const state = broker.state(PROJECT);
    const listed = await connectorRpc(broker, g.grant, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const publicData = JSON.stringify([state, listed, deps.store.loadRecords('connector_accounts'), deps.store.loadRecords('connector_grants'), audit.mock.calls]);
    expect(publicData).not.toContain('provider-private-token'); expect(publicData).not.toContain(g.token);
    expect(broker.state(OTHER).accounts).toHaveLength(0); expect(broker.state(OTHER).grants).toHaveLength(0);
    expect(() => broker.authenticate('Bearer wrong')).toThrow('Invalid');
  });
  it('scopes tools and projects, rejects arbitrary HTTP input and validates duration and approval policy', async () => {
    const { broker, doc, connect, grant, send } = setup(); const a = connect();
    expect(() => broker.createGrant({ accountId: a.id, nodeId: 'builder', tools: ['discord_history'] }, { ...doc, project: OTHER })).toThrow('project');
    expect(() => grant(a.id, { tools: ['gmail_read'] })).toThrow('belong');
    expect(() => grant(a.id, { hours: 0 })).toThrow('duration');
    expect(() => grant(a.id, { requireApproval: 'false' })).toThrow('Approval');
    const g = grant(a.id, { tools: ['discord_history'] }).grant;
    await expect(broker.invoke(g, 'discord_send', { channel: '123', text: 'hi' })).rejects.toThrow('not granted');
    await expect(broker.invoke(g, 'discord_history', { channel: '123', url: 'https://evil.example' })).rejects.toThrow('schema');
    expect(send).not.toHaveBeenCalled();
    await broker.invoke(g, 'discord_history', { channel: 'https://evil.example', limit: 3 });
    expect(new URL(String(send.mock.calls[0][0])).host).toBe('discord.com');
    expect(send.mock.calls[0][1]?.redirect).toBe('error');
  });
  it('executes exactly one approved write and never gives approval power to agents', async () => {
    const { broker, connect, grant, send } = setup(); const g = grant(connect().id).grant;
    const input = { channel: '123', text: 'Operator-reviewed content' };
    const pending = await broker.invoke(g, 'discord_send', input) as { approvalId: string };
    const duplicate = await broker.invoke(g, 'discord_send', input);
    expect(duplicate).toMatchObject({ approvalId: pending.approvalId }); expect(send).not.toHaveBeenCalled();
    expect(broker.approval(g, pending.approvalId).status).toBe('pending');
    await broker.decide(pending.approvalId, true);
    expect(send).toHaveBeenCalledTimes(1); expect(broker.approval(g, pending.approvalId).status).toBe('succeeded');
    await expect(broker.decide(pending.approvalId, true)).rejects.toThrow('already handled');
    const body = JSON.parse(String(send.mock.calls[0][1]?.body)); expect(body).toEqual({ content: input.text, allowed_mentions: { parse: [] } });
    const rpc = await connectorRpc(broker, g, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'approve_action', arguments: { approvalId: pending.approvalId } } });
    expect(rpc).toMatchObject({ result: { isError: true } });
  });
  it('denies writes, expires approvals, and invalidates cached grant objects immediately after revocation', async () => {
    const { broker, connect, grant, send, advance } = setup(); const { grant: g, token } = grant(connect().id);
    const pending = await broker.invoke(g, 'discord_send', { channel: '123', text: 'A' }) as { approvalId: string };
    await broker.decide(pending.approvalId, false);
    await expect(broker.decide(pending.approvalId, true)).rejects.toThrow('already handled');
    const expired = await broker.invoke(g, 'discord_send', { channel: '123', text: 'B' }) as { approvalId: string };
    advance(901_000); await expect(broker.decide(expired.approvalId, true)).rejects.toThrow('expired');
    broker.revoke(g.id); expect(() => broker.authenticate(`Bearer ${token}`)).toThrow();
    await expect(broker.invoke(g, 'discord_history', { channel: '123' })).rejects.toThrow('revoked'); expect(send).not.toHaveBeenCalled();
  });
  it('disconnects all grants and supports explicit direct writes and grant expiration', async () => {
    const { broker, connect, grant, send, advance, deps } = setup(); const a = connect(); const g = grant(a.id, { requireApproval: false, hours: 1 });
    await broker.invoke(g.grant, 'discord_send', { channel: '123', text: 'Direct write explicitly allowed' }); expect(send).toHaveBeenCalledOnce();
    advance(3600_000); expect(() => broker.authenticate(`Bearer ${g.token}`)).toThrow('expired');
    const next = grant(a.id); broker.disconnect(a.id);
    expect(() => broker.authenticate(`Bearer ${next.token}`)).toThrow(); expect(deps.secrets.namesUnder(`connector:${a.id}:`)).toEqual([]);
    expect(broker.state(PROJECT).grants.every(g => g.revokedAt !== undefined)).toBe(true);
    broker.removeAccount(a.id); expect(broker.state(PROJECT).accounts).toHaveLength(0);
  });
});

describe('OAuth pipeline and provider adapters', () => {
  it('uses PKCE and one-time state, validates callback destination, and stores OAuth credentials only in the vault', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: 'oauth-private', refresh_token: 'refresh-private', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' }));
    const { broker, deps } = setup(send);
    const started = broker.connect({ project: PROJECT, provider: 'gmail', label: 'Work email', clientId: 'test-client', clientSecret: 'client-private', tools: ['gmail_read'] }, callback);
    const auth = new URL(started.authorizationUrl!); expect(auth.searchParams.get('code_challenge_method')).toBe('S256'); expect(auth.href).not.toContain('client-private');
    const url = redirect(auth.href);
    await expect(broker.complete(new URL(url.href.replace('localhost', 'evil.example')))).rejects.toThrow('match');
    await broker.complete(url); await expect(broker.complete(url)).rejects.toThrow('already used');
    const form = new URLSearchParams(String(send.mock.calls[0][1]?.body));
    expect(form.get('code_verifier')).toHaveLength(64); expect(form.get('client_secret')).toBe('client-private');
    expect(broker.state(PROJECT).accounts[0].status).toBe('connected');
    expect(JSON.stringify(deps.store.loadRecords('connector_accounts'))).not.toMatch(/oauth-private|refresh-private|client-private/);
  });
  it('uses Slack desktop user scopes, handles nested tokens, Canva Basic authentication, and reduced scopes', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, authed_user: { access_token: 'user-token', scope: 'channels:read' } })).mockResolvedValueOnce(Response.json({ access_token: 'canva-token', scope: 'design:meta:read' })).mockResolvedValueOnce(Response.json({ access_token: 'reduced-token', scope: 'unrelated' }));
    const { broker } = setup(send);
    const slack = broker.connect({ project: PROJECT, provider: 'slack', label: 'Work Slack', clientId: 'client', tools: ['slack_channels'] }, callback);
    const auth = new URL(slack.authorizationUrl!); expect(auth.searchParams.get('user_scope')).toBe('channels:read'); expect(auth.searchParams.has('scope')).toBe(false);
    await broker.complete(redirect(slack.authorizationUrl!)); expect(String(send.mock.calls[0][1]?.body)).not.toContain('client_secret');
    const canva = broker.connect({ project: PROJECT, provider: 'canva', label: 'Design', clientId: 'client', clientSecret: 'secret', tools: ['canva_designs'] }, callback);
    await broker.complete(redirect(canva.authorizationUrl!)); expect(send.mock.calls[1][1]?.headers).toMatchObject({ authorization: `Basic ${Buffer.from('client:secret').toString('base64')}` });
    const reduced = broker.connect({ project: PROJECT, provider: 'gmail', label: 'Email', clientId: 'client', tools: ['gmail_read'] }, callback);
    await expect(broker.complete(redirect(reduced.authorizationUrl!))).rejects.toThrow('all requested scopes');
  });
  it('coalesces concurrent refreshes, rotates the refresh token, and redacts provider secrets from results', async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/token')) return Response.json({ access_token: 'new-provider-private', refresh_token: 'rotated-private', expires_in: 3600 });
      return Response.json({ note: 'new-provider-private should not be visible' });
    });
    const { broker, deps, grant } = setup(send);
    const started = broker.connect({ project: PROJECT, provider: 'gmail', label: 'Email', clientId: 'client', tools: ['gmail_read'] }, callback);
    send.mockResolvedValueOnce(Response.json({ access_token: 'old-private', refresh_token: 'old-refresh', expires_in: 1 })); await broker.complete(redirect(started.authorizationUrl!));
    const g = grant(started.account.id, { tools: ['gmail_read'] }).grant;
    const result = await Promise.all([broker.invoke(g, 'gmail_read', { messageId: '1' }), broker.invoke(g, 'gmail_read', { messageId: '2' })]);
    expect(send.mock.calls.filter(c => String(c[0]).endsWith('/token'))).toHaveLength(2);
    expect(deps.secrets.get(`connector:${started.account.id}:refresh`)).toBe('rotated-private'); expect(JSON.stringify(result)).not.toContain('new-provider-private');
  });
  it('does not restore credentials or send a request if disconnected during token refresh', async () => {
    let finish!: (r: Response) => void;
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'old-private', refresh_token: 'old-refresh', expires_in: 1 })).mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const { broker, deps, grant } = setup(send);
    const started = broker.connect({ project: PROJECT, provider: 'gmail', label: 'Email', clientId: 'client', tools: ['gmail_read'] }, callback); await broker.complete(redirect(started.authorizationUrl!));
    const g = grant(started.account.id, { tools: ['gmail_read'] }).grant;
    const pending = broker.invoke(g, 'gmail_read', { messageId: '1' }); broker.disconnect(started.account.id); finish(Response.json({ access_token: 'must-not-be-stored', expires_in: 3600 }));
    await expect(pending).rejects.toThrow('disconnected'); expect(send).toHaveBeenCalledTimes(2); expect(deps.secrets.namesUnder(`connector:${started.account.id}:`)).toEqual([]);
  });
  it('sanitizes provider errors, blocks header injection and never follows provider redirects', async () => {
    const { broker, connect, grant, send } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response('provider-private-token', { status: 401 })));
    const g = grant(connect().id, { requireApproval: false }).grant;
    await expect(broker.invoke(g, 'discord_history', { channel: '123' })).rejects.toThrow('HTTP 401'); expect(send.mock.calls[0][1]?.redirect).toBe('error');
    expect(() => providerRequest('gmail', 'gmail_send', { to: 'person@example.com\r\nBcc: other@example.com', subject: 'Hi', body: 'Text' })).toThrow('single lines');
    for (const p of CONNECTOR_PROVIDERS) for (const t of p.tools) expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
  });
});
