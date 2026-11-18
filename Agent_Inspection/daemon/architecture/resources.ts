import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client } from 'pg';
import Ajv from 'ajv';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import type { LibraryDeps } from '../library/deps.ts';
import { LibraryInputError } from '../library/types.ts';
import { resolveInsideCwd } from '../outputs/pathSafety.ts';
import { folder } from '../../web/src/stationOffices.ts';
import type { ArchitectureDocument, ArchitectureNode } from '../../shared/architecture.ts';
import { validateArchitecture } from '../../shared/architecture.ts';
import { validateResource, type MemoryConfig, type ToolConfig, type OutputConfig, type JsonSchema, type RouterConfig } from '../../shared/agentResources.ts';
import type { ArchitectureStore } from './store.ts';
import { McpHttpClient } from './mcpClient.ts';
import { assertResolvedHostAllowed } from '../library/urlGuard.ts';
/** Built agents may reach loopback (local dev services) but never link-local/metadata, private or CGNAT ranges unless WAYSTATION_ALLOW_PRIVATE_FETCH=1. */
const OUTBOUND = { allowLoopback: process.env.WAYSTATION_HOSTED !== '1' };

interface Credential { id: string; project: string; createdAt: number }
interface MemoryRow { id: string; scope: string; key: string; value: unknown; updatedAt: number; expiresAt: number }
export interface ResourceContext { document: ArchitectureDocument; agentNodeId: string; runId: string; signal?: AbortSignal; allowedHosts?: string[]; environmentId?: string; idempotencyKey?: string }
export function checkNetwork(host: string, allowedHosts?: string[]): void {
  if (allowedHosts && !allowedHosts.some(h => h.toLowerCase() === host.toLowerCase())) throw new LibraryInputError(`Environment network policy blocks host: ${host}. Add this exact host to the environment and deploy a new version.`);
}
const sameProject = (a: string, b: string) => folder(a)?.key === folder(b)?.key;
const prefix = (id: string) => `architecture-resource:${id}:`;

export function validateJson(schema: JsonSchema | undefined, value: unknown): void {
  if (!schema) return;
  try {
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    const validate = ajv.compile(schema);
    if (!validate(value)) throw new LibraryInputError(`Data does not match the JSON schema: ${ajv.errorsText(validate.errors).slice(0, 600)}`);
  } catch (e) { if (e instanceof LibraryInputError) throw e; throw new LibraryInputError('The JSON schema is invalid or references an unavailable schema.'); }
}
export function routeResult(config: RouterConfig, value: unknown): string {
  for (const rule of config.rules) {
    let actual: unknown = value;
    for (const part of rule.field.split('.')) actual = actual && typeof actual === 'object' && Object.hasOwn(actual, part) ? (actual as Record<string, unknown>)[part] : undefined;
    if (rule.operator === 'exists' ? actual !== undefined : rule.operator === 'contains' ? String(actual ?? '').includes(rule.value) : String(actual) === rule.value) return rule.target;
  }
  return config.fallback;
}
/** Compact Tavily search results: the model needs title, url, snippet and score, not the raw payload. */
export function shapeTavily(raw: unknown): unknown {
  const r = raw as { answer?: unknown; results?: unknown };
  if (!r || typeof r !== 'object' || !Array.isArray(r.results)) return raw;
  return { ...(typeof r.answer === 'string' && r.answer ? { answer: r.answer } : {}), results: r.results.slice(0, 20).map((x: any) => ({ title: String(x?.title ?? ''), url: String(x?.url ?? ''), content: String(x?.content ?? '').slice(0, 1500), ...(typeof x?.score === 'number' ? { score: Math.round(x.score * 1000) / 1000 } : {}), ...(x?.published_date ? { published: String(x.published_date) } : {}) })) };
}
export class AgentResources {
  /** One MCP session per (run, server); the pinned schema is verified once per session before any call. */
  private readonly mcpSessions = new Map<string, { client: McpHttpClient; verified: Map<string, string> }>();
  constructor(private readonly deps: LibraryDeps, private readonly send: typeof fetch = fetch) {}
  storeCredential(project: string, name: 'password' | 'authorization', value: unknown, existing?: string): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\r\n]/.test(value)) throw new LibraryInputError('Enter a single-line secret under 8192 characters.');
    if (existing) this.secret(project, existing, name);
    const id = existing ?? randomUUID();
    this.deps.secrets.set(`${prefix(id)}${name}`, value.trim());
    if (!existing) this.deps.store.saveRecord('architecture_credentials', { id, project, createdAt: Date.now() } satisfies Credential);
    return id;
  }
  linkCredential(project: string, name: 'password' | 'authorization', source: string, existing?: string, prefixValue = ''): string {
    if (existing) this.secret(project, existing, name); const id = existing ?? randomUUID(); this.deps.secrets.alias(`${prefix(id)}${name}`, source, prefixValue);
    if (!existing) this.deps.store.saveRecord('architecture_credentials', { id, project, createdAt: Date.now() } satisfies Credential); return id;
  }
  /** A credential slot with no secret yet (keyless service connections such as public MCP servers). */
  registerCredential(project: string): string { const id = randomUUID(); this.deps.store.saveRecord('architecture_credentials', { id, project, createdAt: Date.now() } satisfies Credential); return id; }
  hasCredential(project: string, id: string, name: 'password' | 'authorization'): boolean { return !!this.secret(project, id, name); }
  sanitize(project: string, text: string): string {
    for (const c of this.deps.store.loadRecords<Credential>('architecture_credentials').filter(c => sameProject(c.project, project))) for (const name of this.deps.secrets.namesUnder(prefix(c.id))) {
      const value = this.deps.secrets.get(`${prefix(c.id)}${name}`); if (value) text = text.split(value).join('[redacted]');
    }
    return text;
  }
  private secret(project: string, id: string | undefined, name: string): string | undefined {
    if (!id) return undefined;
    const c = this.deps.store.loadRecord<Credential>('architecture_credentials', id);
    if (!c || !sameProject(c.project, project)) throw new LibraryInputError('Resource credentials are unavailable in this project.');
    return this.deps.secrets.get(`${prefix(id)}${name}`);
  }
  credentialStatus(project: string, node: ArchitectureNode): { password: boolean; authorization: boolean } {
    const id = node.config && 'credentialId' in node.config ? node.config.credentialId : undefined;
    return { password: !!this.secret(project, id, 'password'), authorization: !!this.secret(project, id, 'authorization') };
  }
  save(store: ArchitectureStore, documentId: string, revision: unknown, nodeId: string, raw: Record<string, unknown>) {
    const doc = store.get(documentId).document; const previous = doc.nodes.find(n => n.id === nodeId);
    if (!previous || previous.kind === 'agent') throw new LibraryInputError('Select a resource block.');
    const input = raw.node as ArchitectureNode;
    if (!input || input.id !== nodeId || input.kind !== previous.kind) throw new LibraryInputError('Resource identity cannot change.');
    let node: ArchitectureNode;
    try { node = validateArchitecture({ ...doc, nodes: doc.nodes.map(n => n.id === nodeId ? input : n) }).nodes.find(n => n.id === nodeId)!; }
    catch (e) { throw new LibraryInputError((e as Error).message); }
    if (!node.config) throw new LibraryInputError('Configure the resource before saving.');
    return this.saveValidated(store, doc, revision, node, raw.secrets);
  }
  private saveValidated(store: ArchitectureStore, doc: ArchitectureDocument, revision: unknown, node: ArchitectureNode, rawSecrets: unknown) {
    // Schema compilation must succeed; validation against actual data happens at invocation time.
    const config = node.config!;
    for (const s of ['inputSchema' in config ? config.inputSchema : undefined, 'schema' in config ? config.schema : undefined]) if (s) { try { new Ajv({ strict: false, validateFormats: false }).compile(s); } catch { throw new LibraryInputError('The JSON schema is invalid.'); } }
    let created: string | undefined; let updated: string | undefined; const prior: Record<string, string | undefined> = {}; const priorRefs: Record<string, { source: string; prefix: string }> = {};
    if (rawSecrets && typeof rawSecrets === 'object' && !Array.isArray(rawSecrets)) {
      const entries = Object.entries(rawSecrets).filter(([, value]) => value !== '');
      if (entries.some(([name, value]) => !['password', 'authorization'].includes(name) || typeof value !== 'string' || !value || value.length > 8192 || /[\r\n]/.test(value))) throw new LibraryInputError('Secrets must be single-line password or authorization values under 8192 characters.');
      if (entries.length) {
        if (!((config.type === 'memory' && config.backend === 'postgres') || (config.type === 'tool' && config.implementation !== 'javascript') || (config.type === 'output' && config.destination === 'webhook'))) throw new LibraryInputError('This resource does not accept credentials.');
        const allowedName = config.type === 'memory' ? 'password' : 'authorization';
        if (entries.some(([name]) => name !== allowedName)) throw new LibraryInputError(`This resource accepts only ${allowedName}.`);
        const existing = 'credentialId' in config ? config.credentialId : undefined;
        if (existing) this.secret(doc.project, existing, allowedName);
        const id = existing || randomUUID(); if (!existing) created = id; else updated = id;
        for (const [name, value] of entries) { const key = `${prefix(id)}${name}`; prior[name] = this.deps.secrets.get(key); const source = this.deps.secrets.reference(key); if (source) priorRefs[name] = { source, prefix: this.deps.secrets.referencePrefix(key) }; this.deps.secrets.set(key, value as string); }
        if (created) this.deps.store.saveRecord('architecture_credentials', { id, project: doc.project, createdAt: Date.now() } satisfies Credential);
        node.config = { ...config, credentialId: id } as typeof config;
      }
    }
    try { return store.update(doc.id, revision, [{ type: 'put_node', node }]); }
    catch (e) { if (created) { this.deps.secrets.deleteUnder(prefix(created)); this.deps.store.deleteRecord('architecture_credentials', created); } if (updated) for (const [name, value] of Object.entries(prior)) { if (priorRefs[name]) this.deps.secrets.alias(`${prefix(updated)}${name}`, priorRefs[name].source, priorRefs[name].prefix); else if (value === undefined) this.deps.secrets.delete(`${prefix(updated)}${name}`); else this.deps.secrets.set(`${prefix(updated)}${name}`, value); } throw e; }
  }
  connected(doc: ArchitectureDocument, agentId: string, kind: 'memory' | 'tool'): ArchitectureNode[] {
    const ids = new Set(doc.edges.flatMap(e => e.source === agentId ? [e.target] : e.target === agentId ? [e.source] : []));
    return doc.nodes.filter(n => n.kind === kind && ids.has(n.id));
  }
  private scope(ctx: ResourceContext, node: ArchitectureNode, config: MemoryConfig): string { return `${ctx.environmentId ? `${ctx.environmentId}:` : ''}${ctx.document.id}:${node.id}:${config.namespace}:${config.scope === 'shared' ? 'shared' : ctx.agentNodeId}`; }
  private memoryConfig(node: ArchitectureNode): MemoryConfig { if (!node.config || node.config.type !== 'memory') throw new LibraryInputError(`Configure memory “${node.name}” first.`); return validateResource('memory', node.config) as MemoryConfig; }
  private async postgres<T>(ctx: ResourceContext, config: MemoryConfig, use: (client: Client, table: string) => Promise<T>): Promise<T> {
    checkNetwork(config.host!, ctx.allowedHosts);
    await assertResolvedHostAllowed(config.host!, 'The PostgreSQL host', OUTBOUND);
    if (config.credentialId && !this.secret(ctx.document.project, config.credentialId, 'password')) throw new LibraryInputError('Database credential is revoked or unavailable. Replace its saved secret.');
    const client = new Client({ host: config.host, port: config.port, database: config.database, user: config.user, password: this.secret(ctx.document.project, config.credentialId, 'password'), ssl: config.tls ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000 });
    const abort = () => { void client.end().catch(() => {}); };
    ctx.signal?.throwIfAborted(); ctx.signal?.addEventListener('abort', abort, { once: true });
    try { await client.connect(); return await use(client, `"${config.table}"`); }
    catch (e) { if (e instanceof LibraryInputError) throw e; throw new LibraryInputError('PostgreSQL operation failed. Check host, database, credentials, TLS, permissions, and initialization.'); }
    finally { ctx.signal?.removeEventListener('abort', abort); await client.end().catch(() => {}); }
  }
  async memory(ctx: ResourceContext, node: ArchitectureNode, action: 'list' | 'get' | 'put' | 'delete', key = '', value?: unknown): Promise<unknown> {
    const c = this.memoryConfig(node); const scope = this.scope(ctx, node, c); const now = Date.now();
    if (action !== 'list' && (!key || key.length > 200)) throw new LibraryInputError('Memory keys must contain 1–200 characters.');
    if (action === 'put' && (value === undefined || JSON.stringify(value).length > 32000)) throw new LibraryInputError('Memory values must be JSON under 32 KB.');
    ctx.signal?.throwIfAborted();
    if (c.backend === 'postgres') return this.postgres(ctx, c, async (client, table) => {
      if (action === 'put') {
        await client.query(`INSERT INTO ${table} (scope,key,value,updated_at,expires_at) VALUES ($1,$2,$3::jsonb,$4,$5) ON CONFLICT(scope,key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at`, [scope, key, JSON.stringify(value), now, now + c.retentionDays * 86400000]);
        await client.query(`DELETE FROM ${table} WHERE scope=$1 AND (expires_at<=$2 OR key IN (SELECT key FROM ${table} WHERE scope=$1 AND key<>$4 ORDER BY updated_at DESC,key OFFSET $3))`, [scope, now, c.maxEntries - 1, key]); return { saved: key };
      }
      if (action === 'delete') { await client.query(`DELETE FROM ${table} WHERE scope=$1 AND key=$2`, [scope, key]); return { deleted: key }; }
      const result = action === 'get' ? await client.query(`SELECT key,value,updated_at FROM ${table} WHERE scope=$1 AND key=$2 AND expires_at>$3`, [scope, key, now]) : await client.query(`SELECT key,value,updated_at FROM ${table} WHERE scope=$1 AND expires_at>$2 ORDER BY updated_at DESC,key LIMIT $3`, [scope, now, Math.min(c.maxEntries, c.contextItems || 30)]);
      return action === 'get' ? result.rows[0] ?? null : result.rows;
    });
    const id = createHash('sha256').update(`${scope}\0${key}`).digest('hex');
    if (action === 'put') {
      const prior = this.deps.store.loadRecords<MemoryRow>('agent_memory_records').filter(r => r.scope === scope);
      const updatedAt = Math.max(now, ...prior.map(r => r.updatedAt + 1));
      this.deps.store.saveRecord('agent_memory_records', { id, scope, key, value, updatedAt, expiresAt: now + c.retentionDays * 86400000 } satisfies MemoryRow);
      const entries = this.deps.store.loadRecords<MemoryRow>('agent_memory_records').filter(r => r.scope === scope).sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
      entries.forEach((row, index) => { if (row.expiresAt <= now || index >= c.maxEntries) this.deps.store.deleteRecord('agent_memory_records', row.id); }); return { saved: key };
    }
    if (action === 'delete') { this.deps.store.deleteRecord('agent_memory_records', id); return { deleted: key }; }
    if (action === 'get') { const r = this.deps.store.loadRecord<MemoryRow>('agent_memory_records', id); return r && r.expiresAt > now ? { key: r.key, value: r.value, updated_at: r.updatedAt } : null; }
    return this.deps.store.loadRecords<MemoryRow>('agent_memory_records').filter(r => r.scope === scope && r.expiresAt > now).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.min(c.contextItems || 30, c.maxEntries)).map(r => ({ key: r.key, value: r.value, updated_at: r.updatedAt }));
  }
  async test(ctx: ResourceContext, node: ArchitectureNode, input: unknown, initialize = false): Promise<unknown> {
    if (!node.config) throw new LibraryInputError('Save the resource configuration before testing.');
    const c = node.config;
    if (c.type === 'memory') {
      if (c.backend === 'postgres' && initialize) await this.postgres(ctx, c, async (client, table) => { await client.query(`CREATE TABLE IF NOT EXISTS ${table} (scope text NOT NULL,key text NOT NULL,value jsonb NOT NULL,updated_at bigint NOT NULL,expires_at bigint NOT NULL,PRIMARY KEY(scope,key))`); });
      const key = 'probe'; const probeNode = { ...node, config: { ...c, namespace: `probe_${randomUUID()}` } };
      await this.memory(ctx, probeNode, 'put', key, { probe: true });
      try { const read = await this.memory(ctx, probeNode, 'get', key); if (!read) throw new LibraryInputError('Memory write succeeded but readback failed.'); return { ok: true, backend: c.backend, message: 'Connected. An isolated test value was written, read, and removed.' }; }
      finally { await this.memory(ctx, probeNode, 'delete', key); }
    }
    if (c.type === 'tool') return { result: await this.invoke(ctx, node, input) };
    if (c.type === 'input') { const value = c.format === 'json' && typeof input === 'string' ? JSON.parse(input) : input; if (c.format === 'json') validateJson(c.schema, value); return { ok: true, value }; }
    if (c.type === 'router') return { target: routeResult(c, input) };
    if (c.type === 'approval') return { ok: true, message: c.message, timeoutMinutes: c.timeoutMinutes };
    return this.deliver(ctx, node, typeof input === 'string' ? input : JSON.stringify(input));
  }
  private async http(ctx: ResourceContext, config: { url?: string; credentialId?: string }, method: string, input: unknown, timeoutMs: number): Promise<string> {
    checkNetwork(new URL(config.url!).hostname, ctx.allowedHosts);
    await assertResolvedHostAllowed(new URL(config.url!).hostname, 'The tool or webhook URL', OUTBOUND);
    if (config.credentialId && !this.secret(ctx.document.project, config.credentialId, 'authorization')) throw new LibraryInputError('Authorization credential is revoked or unavailable. Replace its saved secret.');
    const url = new URL(config.url!); const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (ctx.idempotencyKey && method !== 'GET') headers['idempotency-key'] = ctx.idempotencyKey;
    const authorization = this.secret(ctx.document.project, config.credentialId, 'authorization'); if (authorization) headers.authorization = authorization;
    if (method === 'GET') for (const [key, value] of Object.entries(input && typeof input === 'object' ? input : {})) url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    try {
      const response = await fetch(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(input), redirect: 'error', signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      if (!response.ok) { await response.body?.cancel(); throw new LibraryInputError(`Resource endpoint returned HTTP ${response.status}.`); }
      const reader = response.body?.getReader(); if (!reader) return '';
      let text = ''; let length = 0; const decoder = new TextDecoder();
      while (true) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > 100000) { await reader.cancel(); throw new LibraryInputError('Resource response exceeds 100 KB.'); } text += decoder.decode(next.value, { stream: true }); }
      return this.sanitize(ctx.document.project, text + decoder.decode());
    } catch (e) { if (e instanceof LibraryInputError) throw e; throw new LibraryInputError('Resource request failed, timed out, or was cancelled. Check the endpoint and credentials.'); }
  }
  private async mcpCall(ctx: ResourceContext, c: ToolConfig, args: unknown): Promise<unknown> {
    checkNetwork(new URL(c.url!).hostname, ctx.allowedHosts);
    await assertResolvedHostAllowed(new URL(c.url!).hostname, 'The MCP server URL', OUTBOUND);
    if (c.credentialId && !this.secret(ctx.document.project, c.credentialId, 'authorization')) throw new LibraryInputError('MCP credential is revoked or unavailable. Replace its saved secret.');
    const authorization = this.secret(ctx.document.project, c.credentialId, 'authorization');
    if (!c.schemaHash) throw new LibraryInputError('This MCP tool has no pinned definition. Publish it as an MCP capability.');
    const key = `${ctx.runId}\0${c.url}\0${c.credentialId ?? ''}`;
    ctx.signal?.throwIfAborted();
    let session = this.mcpSessions.get(key);
    if (!session) { session = { client: new McpHttpClient({ url: c.url!, headers: authorization ? { authorization } : {} }, this.send), verified: new Map() }; this.mcpSessions.set(key, session); }
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(c.timeoutMs)]) : AbortSignal.timeout(c.timeoutMs);
    if (!session.verified.has(c.mcpTool!)) {
      const live = (await session.client.listTools(signal)).find(t => t.name === c.mcpTool);
      if (!live) throw new LibraryInputError(`The MCP server no longer offers "${c.mcpTool}". Publish a new capability version.`);
      if (live.schemaHash !== c.schemaHash) throw new LibraryInputError(`The MCP server changed "${c.mcpTool}" since it was reviewed. Publish a new capability version before agents can call it.`);
      session.verified.set(c.mcpTool!, live.schemaHash);
    }
    return JSON.parse(this.sanitize(ctx.document.project, JSON.stringify(await session.client.callTool(c.mcpTool!, args, signal) ?? null)));
  }
  /** Close MCP sessions opened for a run. Called when the run finishes. */
  async closeRun(runId: string): Promise<void> {
    const prefix = `${runId}\0`;
    await Promise.allSettled([...this.mcpSessions.entries()].filter(([k]) => k.startsWith(prefix)).map(async ([k, s]) => { this.mcpSessions.delete(k); await s.client.close(); }));
  }
  async invoke(ctx: ResourceContext, node: ArchitectureNode, input: unknown): Promise<unknown> {
    if (node.config?.type !== 'tool') throw new LibraryInputError(`Configure tool “${node.name}” first.`);
    const c = validateResource('tool', node.config) as ToolConfig; validateJson(c.inputSchema, input); ctx.signal?.throwIfAborted();
    // Model input fills in over defaults; operator-pinned values always win.
    const args = { ...c.defaults, ...(input && typeof input === 'object' ? input as Record<string, unknown> : {}), ...c.pinned };
    if (c.implementation === 'mcp') return this.mcpCall(ctx, c, args);
    if (c.implementation === 'http') { const output = await this.http(ctx, c, c.method!, args, c.timeoutMs); let value: unknown; try { value = JSON.parse(output); } catch { value = output; } return c.transform === 'tavily_search' ? shapeTavily(value) : value; }
    const engine = await getQuickJS();
    try {
      const output = engine.evalCode(`(()=>{const result=(function(input){"use strict";\n${c.code}\n})(${JSON.stringify(input)});if(result&&typeof result.then==='function')throw new Error('Return a synchronous value');return JSON.stringify(result);})()`, { shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + Math.min(c.timeoutMs, 1000)), memoryLimitBytes: 32 * 1024 * 1024, maxStackSizeBytes: 512 * 1024 });
      if (typeof output !== 'string' || output.length > 100000) throw new Error('Return JSON under 100 KB.');
      return JSON.parse(output);
    } catch { throw new LibraryInputError('JavaScript tool failed. Return JSON synchronously within its time and memory limits; Node, network, files, and imports are unavailable.'); }
  }
  async deliver(ctx: ResourceContext, node: ArchitectureNode, text: string): Promise<unknown> {
    if (node.config?.type !== 'output') throw new LibraryInputError(`Configure output “${node.name}” first.`);
    const c = validateResource('output', node.config) as OutputConfig; let value: unknown = text;
    if (c.format === 'json') { try { value = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new LibraryInputError(`Output “${node.name}” requires valid JSON.`); } validateJson(c.schema, value); }
    const content = c.format === 'json' ? JSON.stringify(value, null, 2) : text;
    if (c.destination === 'dashboard') return { destination: 'dashboard', value };
    if (c.destination === 'webhook') { await this.http(ctx, c, 'POST', { runId: ctx.runId, agentId: ctx.agentNodeId, output: value }, 15000); return { destination: 'webhook', delivered: true }; }
    const requested = c.path!.replaceAll('{runId}', ctx.runId);
    try { const safe = resolveInsideCwd(ctx.document.project, requested); mkdirSync(dirname(safe.abs), { recursive: true }); const checked = resolveInsideCwd(ctx.document.project, requested); writeFileSync(checked.abs, content, { encoding: 'utf8', flag: 'wx' }); return { destination: 'file', path: checked.rel }; }
    catch { throw new LibraryInputError('Output file could not be created. Use a writable project-relative path containing {runId}; existing files are never overwritten.'); }
  }
}
