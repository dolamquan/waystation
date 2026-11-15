import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CONNECTOR_PROVIDERS, type ConnectorAccount, type ConnectorApproval, type ConnectorGrant, type ConnectorState, type ConnectorTool } from '../../shared/connectors.ts';
import type { ArchitectureDocument } from '../../shared/architecture.ts';
import type { LibraryDeps } from '../library/deps.ts';
import { LibraryInputError } from '../library/types.ts';
import { folderRoot } from '../files/folderFiles.ts';
import { folder } from '../../web/src/stationOffices.ts';
import { validateJson } from '../architecture/resources.ts';
import { TeamAuthError } from '../teams/teamContext.ts';
import { tokensMatch } from '../api/security.ts';
import { boundedText, OAUTH, providerRequest, type OAuthProvider } from './providers.ts';

interface AccountRecord extends ConnectorAccount { clientId?: string; redirectUri?: string; generation: number }
interface Pending { accountId: string; generation: number; verifier: string; expiresAt: number }
const TABLE = 'connector_accounts'; const GRANTS = 'connector_grants'; const APPROVALS = 'connector_approvals';
const prefix = (id: string) => `connector:${id}:`;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const same = (a: string, b: string) => folder(a)?.key === folder(b)?.key;
const fail = (message: string): never => { throw new LibraryInputError(message); };
const text = (v: unknown, label: string, max = 200): string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\r\n\0]/.test(v) ? v.trim() : fail(`Enter ${label} (up to ${max} characters).`);
const root = (v: unknown) => { try { return folderRoot(text(v, 'a project folder', 2000)); } catch { return fail('Choose an existing absolute project folder.'); } };

/** Local credential broker. Graphs and MCP clients receive grant authority, never provider credentials. */
export class ConnectorBroker {
  private pending = new Map<string, Pending>();
  private refreshing = new Map<string, Promise<string>>();
  constructor(private readonly deps: LibraryDeps, private readonly send: typeof fetch = fetch, private readonly now = Date.now) {}
  private records(): AccountRecord[] { return this.deps.store.loadRecords<AccountRecord>(TABLE); }
  private account(id: string): AccountRecord { return this.deps.store.loadRecord<AccountRecord>(TABLE, id) ?? fail('Connector account not found.'); }
  private definition(a: AccountRecord) { return CONNECTOR_PROVIDERS.find(p => p.id === a.provider)!; }
  private view(a: AccountRecord): ConnectorAccount { const { clientId: _c, redirectUri: _r, generation: _g, ...view } = a; return view; }
  state(project: unknown): ConnectorState {
    const p = root(project);
    return { providers: CONNECTOR_PROVIDERS, accounts: this.records().filter(a => same(a.project, p)).map(a => this.view(a)), grants: this.deps.store.loadRecords<ConnectorGrant>(GRANTS).filter(g => same(g.project, p)), approvals: this.deps.store.loadRecords<ConnectorApproval>(APPROVALS).filter(a => same(a.project, p)).slice(-100).reverse() };
  }
  private selected(provider: string, raw: unknown): ConnectorTool[] {
    const d = CONNECTOR_PROVIDERS.find(p => p.id === provider) ?? fail('Choose a supported service.');
    if (!Array.isArray(raw) || !raw.length || raw.length > d.tools.length || new Set(raw).size !== raw.length) return fail('Select at least one distinct tool.');
    return raw.map(n => d.tools.find(t => t.name === n) ?? fail('A tool does not belong to this service.'));
  }
  connect(raw: Record<string, unknown>, callback: string): { account: ConnectorAccount; authorizationUrl?: string; redirectUri?: string } {
    const project = root(raw.project); const d = CONNECTOR_PROVIDERS.find(p => p.id === raw.provider) ?? fail('Choose a supported service.');
    if (this.records().filter(a => same(a.project, project)).length >= 50) fail('A project supports up to 50 connected accounts.');
    const tools = this.selected(d.id, raw.tools);
    const a: AccountRecord = { id: randomUUID(), project, provider: d.id, label: text(raw.label, 'an account label', 100), tools: tools.map(t => t.name), status: 'disconnected', createdAt: this.now(), generation: 1 };
    let authorizationUrl: string | undefined;
    if (d.auth === 'token') {
      const token = text(raw.token, 'a service token', 8192);
      this.deps.secrets.set(`${prefix(a.id)}access`, token); a.status = 'connected';
    } else {
      a.clientId = text(raw.clientId, 'a client ID', 500);
      const u = new URL(callback);
      // The redirect always returns to this daemon, never to a user-supplied URL.
      if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname)) fail('OAuth requires a localhost callback.');
      a.redirectUri = callback;
      if (d.id === 'canva' && !raw.clientSecret) fail('Canva requires the integration client secret.');
      if (raw.clientSecret) this.deps.secrets.set(`${prefix(a.id)}client`, text(raw.clientSecret, 'a client secret', 8192));
      const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(48).toString('base64url');
      for (const [key, value] of this.pending) if (value.expiresAt < this.now()) this.pending.delete(key);
      if (this.pending.size >= 100) fail('Too many pending sign-ins. Complete a sign-in or wait ten minutes.');
      this.pending.set(hash(state), { accountId: a.id, generation: a.generation, verifier, expiresAt: this.now() + 600_000 });
      const auth = new URL(OAUTH[d.id as OAuthProvider].authorize);
      const scopes = [...new Set(tools.flatMap(t => t.scopes))];
      auth.search = new URLSearchParams({ client_id: a.clientId, redirect_uri: callback, response_type: 'code', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', [d.id === 'slack' ? 'user_scope' : 'scope']: scopes.join(d.id === 'slack' ? ',' : ' ') }).toString();
      if (d.id === 'gmail' || d.id === 'drive') { auth.searchParams.set('access_type', 'offline'); auth.searchParams.set('prompt', 'consent'); }
      authorizationUrl = auth.href;
    }
    try { this.deps.store.saveRecord(TABLE, a); } catch (e) { this.deps.secrets.deleteUnder(prefix(a.id)); throw e; }
    this.deps.audit('connector_connect', a.id, { provider: d.id, tools: a.tools });
    return { account: this.view(a), authorizationUrl, redirectUri: a.redirectUri };
  }
  async complete(url: URL): Promise<ConnectorAccount> {
    const state = url.searchParams.get('state') ?? ''; const pending = this.pending.get(hash(state));
    if (!pending || pending.expiresAt < this.now()) return fail('This sign-in expired or was already used. Start again.');
    const a = this.account(pending.accountId);
    const expected = new URL(a.redirectUri!);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) fail('The OAuth callback does not match this sign-in.');
    this.pending.delete(hash(state));
    if (url.searchParams.has('error')) fail('Authorization was declined. Start again when ready.');
    const code = text(url.searchParams.get('code'), 'an authorization code', 4096);
    const tokens = await this.exchange(a, { grant_type: 'authorization_code', code, redirect_uri: a.redirectUri!, code_verifier: pending.verifier });
    if (this.account(a.id).generation !== pending.generation) fail('This connection was disconnected while signing in.');
    const granted = tokens.scope === undefined ? undefined : new Set(String(tokens.scope).split(/[ ,]+/));
    const tools = this.selected(a.provider, a.tools);
    if (granted && tools.some(t => t.scopes.some(s => !granted.has(s)))) fail('The provider did not grant all requested scopes. Start again with fewer tools.');
    this.saveTokens(a, tokens); a.status = 'connected'; this.deps.store.saveRecord(TABLE, a);
    this.deps.audit('connector_authorized', a.id, { provider: a.provider, tools: a.tools }); return this.view(a);
  }
  private async exchange(a: AccountRecord, fields: Record<string, string>): Promise<Record<string, unknown>> {
    const client = this.deps.secrets.get(`${prefix(a.id)}client`);
    const form = new URLSearchParams({ ...fields, client_id: a.clientId! });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (a.provider === 'canva') { headers.authorization = `Basic ${Buffer.from(`${a.clientId}:${client}`).toString('base64')}`; form.delete('client_id'); }
    else if (client && a.provider !== 'slack') form.set('client_secret', client);
    try {
      const response = await this.send(OAUTH[a.provider as OAuthProvider].token, { method: 'POST', headers, body: form.toString(), redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) { await response.body?.cancel(); return fail(`Authorization failed (HTTP ${response.status}). Check app settings and reconnect.`); }
      const body = JSON.parse(await boundedText(response, 32000));
      if (body.error || body.ok === false) return fail('Provider rejected authorization. Check app settings and reconnect.');
      const tokens = a.provider === 'slack' && body.authed_user?.access_token ? body.authed_user : body;
      if (typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 8192) return fail('Provider returned no usable access token.');
      return tokens;
    } catch (e) { if (e instanceof LibraryInputError) throw e; return fail('Authorization request failed. Check the network and reconnect.'); }
  }
  private saveTokens(a: AccountRecord, tokens: Record<string, unknown>): void {
    this.deps.secrets.set(`${prefix(a.id)}access`, String(tokens.access_token));
    if (typeof tokens.refresh_token === 'string' && tokens.refresh_token.length <= 8192) this.deps.secrets.set(`${prefix(a.id)}refresh`, tokens.refresh_token);
    if (typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0) a.expiresAt = this.now() + tokens.expires_in * 1000;
    else delete a.expiresAt;
  }
  disconnect(id: string): void {
    const a = this.account(id); a.status = 'disconnected'; a.generation++; this.deps.store.saveRecord(TABLE, a);
    for (const [key, p] of this.pending) if (p.accountId === id) this.pending.delete(key);
    for (const g of this.deps.store.loadRecords<ConnectorGrant>(GRANTS).filter(g => g.accountId === id && !g.revokedAt)) this.revoke(g.id);
    this.deps.secrets.deleteUnder(prefix(id)); this.deps.audit('connector_disconnect', id, {});
  }
  removeAccount(id: string): void {
    if (this.account(id).status !== 'disconnected') fail('Disconnect the account before removing it.');
    this.disconnect(id); this.deps.store.deleteRecord(TABLE, id); this.deps.audit('connector_account_remove', id, {});
  }
  createGrant(raw: Record<string, unknown>, doc: ArchitectureDocument): { grant: ConnectorGrant; token: string } {
    const a = this.account(text(raw.accountId, 'an account ID')); const node = doc.nodes.find(n => n.id === raw.nodeId && n.kind === 'agent') ?? fail('Select an agent in the workflow.');
    if (!same(doc.project, a.project) || a.status !== 'connected') fail('Connect an account in this project first.');
    const tools = this.selected(a.provider, raw.tools);
    if (tools.some(t => !a.tools.includes(t.name))) fail('Connect again to authorize the additional tools.');
    const hours = raw.hours ?? 24;
    if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > 720) return fail('Grant duration must be between 1 and 720 hours.');
    if (raw.requireApproval !== undefined && typeof raw.requireApproval !== 'boolean') fail('Approval must be true or false.');
    const g: ConnectorGrant = { id: randomUUID(), project: a.project, accountId: a.id, architectureId: doc.id, nodeId: node.id, agentName: node.name, tools: tools.map(t => t.name), requireApproval: raw.requireApproval !== false, createdAt: this.now(), expiresAt: this.now() + hours * 3600_000 };
    if (this.deps.store.loadRecords<ConnectorGrant>(GRANTS).filter(g => !g.revokedAt && g.expiresAt > this.now()).length >= 500) fail('Revoke an unused grant before adding more.');
    const token = `${g.id}.${randomBytes(32).toString('base64url')}`;
    this.deps.secrets.set(`${prefix(g.id)}hash`, hash(token)); this.deps.store.saveRecord(GRANTS, g);
    this.deps.audit('connector_grant', g.id, { accountId: a.id, architectureId: doc.id, nodeId: node.id, tools: g.tools, requireApproval: g.requireApproval }); return { grant: g, token };
  }
  grant(id: string): ConnectorGrant { return this.deps.store.loadRecord<ConnectorGrant>(GRANTS, id) ?? fail('Access grant not found.'); }
  revoke(id: string): void {
    const g = this.grant(id); g.revokedAt = this.now(); this.deps.store.saveRecord(GRANTS, g); this.deps.secrets.delete(`${prefix(id)}hash`);
    for (const a of this.deps.store.loadRecords<ConnectorApproval>(APPROVALS).filter(a => a.grantId === id && a.status === 'pending')) { a.status = 'denied'; this.deps.store.saveRecord(APPROVALS, a); }
    this.deps.audit('connector_revoke', id, {});
  }
  private active(g: ConnectorGrant): void {
    if (g.revokedAt !== undefined || g.expiresAt <= this.now() || this.account(g.accountId).status !== 'connected') throw new TeamAuthError('Connector access expired or was revoked.');
  }
  authenticate(header: string | undefined): ConnectorGrant {
    const token = header?.startsWith('Bearer ') ? header.slice(7) : ''; const id = token.split('.')[0];
    const g = this.deps.store.loadRecord<ConnectorGrant>(GRANTS, id);
    if (!g || !tokensMatch(hash(token), this.deps.secrets.get(`${prefix(id)}hash`) ?? '')) throw new TeamAuthError('Invalid connector access token.');
    this.active(g); return g;
  }
  tools(g: ConnectorGrant): ConnectorTool[] { this.active(this.grant(g.id)); const a = this.account(g.accountId); return this.definition(a).tools.filter(t => g.tools.includes(t.name)); }
  async invoke(g: ConnectorGrant, name: string, raw: unknown): Promise<unknown> {
    const current = this.grant(g.id); this.active(current);
    const tool = this.tools(current).find(t => t.name === name) ?? fail('This tool was not granted to the agent.');
    validateJson(tool.inputSchema, raw);
    const input = structuredClone(raw) as Record<string, unknown>;
    // Validate semantic constraints before presenting an action for approval.
    providerRequest(this.account(current.accountId).provider, name, input);
    if (tool.write && current.requireApproval) {
      const pending = this.deps.store.loadRecords<ConnectorApproval>(APPROVALS).filter(a => a.grantId === current.id && a.status === 'pending' && a.expiresAt > this.now());
      const duplicate = pending.find(a => a.tool === name && JSON.stringify(a.input) === JSON.stringify(input));
      if (duplicate) return { status: 'approval_required', approvalId: duplicate.id, message: 'Waiting for the operator in Architecture → App access. Do not retry the write.' };
      if (pending.length >= 20) fail('Wait for the operator to resolve pending actions.');
      const a: ConnectorApproval = { id: randomUUID(), project: current.project, grantId: current.id, agentName: current.agentName, tool: name, input, status: 'pending', createdAt: this.now(), expiresAt: Math.min(current.expiresAt, this.now() + 900_000) };
      this.deps.store.saveRecord(APPROVALS, a); this.deps.audit('connector_approval_requested', a.id, { grantId: current.id, tool: name });
      return { status: 'approval_required', approvalId: a.id, message: 'The action has not run. The operator can approve it in Architecture → App access. Do not retry the write.' };
    }
    return this.execute(current, tool, input);
  }
  async decide(id: string, approve: boolean): Promise<unknown> {
    const a = this.deps.store.loadRecord<ConnectorApproval>(APPROVALS, id) ?? fail('Approval request not found.');
    if (a.status !== 'pending') fail('This action was already handled.');
    if (!approve) { a.status = 'denied'; this.deps.store.saveRecord(APPROVALS, a); this.deps.audit('connector_action_denied', id, {}); return { status: a.status }; }
    if (a.expiresAt <= this.now()) fail('This approval expired. Request a new action.');
    const g = this.grant(a.grantId); this.active(g); const t = this.tools(g).find(t => t.name === a.tool) ?? fail('Tool access was removed.');
    a.status = 'executing'; this.deps.store.saveRecord(APPROVALS, a);
    try { const result = await this.execute(g, t, a.input); a.status = 'succeeded'; this.deps.store.saveRecord(APPROVALS, a); return { status: a.status, result }; }
    catch (e) { a.status = 'failed'; this.deps.store.saveRecord(APPROVALS, a); throw e; }
  }
  approval(g: ConnectorGrant, id: string) {
    this.active(this.grant(g.id)); const a = this.deps.store.loadRecord<ConnectorApproval>(APPROVALS, id);
    if (!a || a.grantId !== g.id) return fail('Approval not found for this grant.');
    return { id: a.id, status: a.status, expiresAt: a.expiresAt };
  }
  private async access(a: AccountRecord): Promise<string> {
    if (a.expiresAt && a.expiresAt <= this.now() + 60_000) {
      const existing = this.refreshing.get(a.id); if (existing) return existing;
      const promise = (async () => {
        const refresh = this.deps.secrets.get(`${prefix(a.id)}refresh`) ?? fail('This service needs to be reconnected.');
        const tokens = await this.exchange(a, { grant_type: 'refresh_token', refresh_token: refresh });
        const latest = this.account(a.id); if (latest.status !== 'connected' || latest.generation !== a.generation) fail('Connection was disconnected during refresh.');
        if (tokens.scope !== undefined) {
          const scopes = new Set(String(tokens.scope).split(/[ ,]+/));
          if (this.selected(a.provider, latest.tools).some(t => t.scopes.some(s => !scopes.has(s)))) fail('Provider permissions changed. Reconnect this service.');
        }
        this.saveTokens(latest, tokens); this.deps.store.saveRecord(TABLE, latest); return String(tokens.access_token);
      })();
      this.refreshing.set(a.id, promise); try { return await promise; } finally { this.refreshing.delete(a.id); }
    }
    return this.deps.secrets.get(`${prefix(a.id)}access`) ?? fail('Reconnect this service to restore credentials.');
  }
  private async execute(g: ConnectorGrant, t: ConnectorTool, input: Record<string, unknown>): Promise<unknown> {
    const a = this.account(g.accountId); const access = await this.access(a); this.active(this.grant(g.id));
    const request = providerRequest(a.provider, t.name, input);
    const authorization = `${a.provider === 'discord' ? 'Bot' : 'Bearer'} ${access}`;
    this.deps.audit('connector_call_started', g.id, { tool: t.name, write: t.write });
    try {
      const response = await this.send(request.url, { method: request.method, headers: { authorization, 'content-type': 'application/json' }, body: request.body === undefined ? undefined : JSON.stringify(request.body), redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) { await response.body?.cancel(); fail(`Service returned HTTP ${response.status}. Check permissions or reconnect. Writes are never retried automatically.`); }
      const output = await boundedText(response);
      const sanitized = this.redact(output);
      const result = request.text ? { text: sanitized } : JSON.parse(sanitized);
      if (a.provider === 'slack' && result.ok === false) fail('Slack rejected this operation. Check scopes and channel access.');
      this.deps.audit('connector_call_succeeded', g.id, { tool: t.name });
      return result;
    } catch (e) { this.deps.audit('connector_call_failed', g.id, { tool: t.name }); if (e instanceof LibraryInputError) throw e; return fail('Service request failed or timed out. Check the service before repeating a write.'); }
  }
  private redact(output: string): string {
    for (const key of this.deps.secrets.namesUnder('connector:')) { const value = this.deps.secrets.get(`connector:${key}`); if (value) output = output.split(value).join('[redacted]'); }
    return output;
  }
}
