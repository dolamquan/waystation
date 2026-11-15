export type JsonSchema = Record<string, unknown>;
export type ResourceConfig = MemoryConfig | ToolConfig | OutputConfig | InputConfig | RouterConfig | ApprovalConfig;
export interface MemoryConfig {
  type: 'memory'; backend: 'sqlite' | 'postgres'; namespace: string; scope: 'agent' | 'shared';
  retentionDays: number; maxEntries: number; contextItems: number;
  host?: string; port?: number; database?: string; user?: string; table?: string; tls?: boolean; credentialId?: string;
}
export interface ToolConfig {
  type: 'tool'; implementation: 'http' | 'javascript'; functionName: string; inputSchema: JsonSchema;
  timeoutMs: number; method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url?: string; code?: string; credentialId?: string;
  defaults?: Record<string, unknown>;
}
export interface OutputConfig {
  type: 'output'; destination: 'dashboard' | 'file' | 'webhook'; format: 'text' | 'json'; schema?: JsonSchema;
  path?: string; url?: string; credentialId?: string;
}
export interface InputConfig { type: 'input'; format: 'text' | 'json'; schema?: JsonSchema }
export interface RouterConfig { type: 'router'; rules: { field: string; operator: 'equals' | 'contains' | 'exists'; value: string; target: string }[]; fallback: string }
export interface ApprovalConfig { type: 'approval'; message: string; timeoutMinutes: number }

export const EMPTY_SCHEMA: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };
export function resourceSummary(config: ResourceConfig): string {
  switch (config.type) {
    case 'memory': return `${config.backend === 'postgres' ? 'PostgreSQL' : 'SQLite'} · ${config.namespace}`;
    case 'tool': return `${config.implementation === 'javascript' ? 'JavaScript' : config.method} · ${config.functionName}`;
    case 'output': return config.destination === 'file' ? `File · ${config.path}` : config.destination === 'webhook' ? 'Webhook delivery' : `${config.format.toUpperCase()} · dashboard`;
    case 'input': return `${config.format.toUpperCase()} input`;
    case 'router': return `${config.rules.length} routing rules`;
    case 'approval': return `Human decision · ${config.timeoutMinutes} min`;
  }
}
export function defaultResource(kind: string): ResourceConfig | undefined {
  switch (kind) {
    case 'memory': return { type: 'memory', backend: 'sqlite', namespace: 'default', scope: 'agent', retentionDays: 30, maxEntries: 100, contextItems: 10 };
    case 'tool': return { type: 'tool', implementation: 'javascript', functionName: 'custom_tool', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, code: 'return { result: input.text };', timeoutMs: 1000 };
    case 'output': return { type: 'output', destination: 'dashboard', format: 'text' };
    case 'input': return { type: 'input', format: 'text' };
    case 'router': return { type: 'router', rules: [], fallback: '' };
    case 'approval': return { type: 'approval', message: 'Review the result before it is delivered.', timeoutMinutes: 15 };
  }
}

export function resourceUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2000) throw new Error('Enter a resource URL under 2000 characters.');
  let url: URL; try { url = new URL(raw); } catch { throw new Error('Enter a valid resource URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) || url.username || url.password || url.search || url.hash) throw new Error('Use HTTPS or localhost HTTP. Store authorization separately; URLs cannot contain credentials, query parameters, or fragments.');
  return url.href;
}
export function validateResource(kind: string, raw: unknown): ResourceConfig {
  const fail = (message: string): never => { throw new Error(message); };
  const obj = (x: unknown) => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : fail('Resource configuration must be an object.');
  const r = obj(raw); if (r.type !== kind) fail('Resource type must match the block.');
  const text = (x: unknown, label: string, max = 200, empty = false): string => typeof x === 'string' && x.length <= max && (empty || !!x.trim()) ? x : fail(`${label} is required (up to ${max} characters).`);
  const integer = (x: unknown, min: number, max: number, label: string): number => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? x : fail(`${label} must be between ${min} and ${max}.`);
  const choice = <T extends string>(x: unknown, values: readonly T[], label: string): T => values.includes(x as T) ? x as T : fail(`Choose a valid ${label}.`);
  const schema = (x: unknown): JsonSchema => { const value = obj(x); if (JSON.stringify(value).length > 16000 || value.$async) fail('Use a synchronous JSON schema under 16 KB.'); return structuredClone(value); };
  const credential = r.credentialId === undefined || r.credentialId === '' ? {} : { credentialId: /^[A-Za-z0-9_-]{1,100}$/.test(String(r.credentialId)) ? String(r.credentialId) : fail('Invalid credential reference.') };
  switch (kind) {
    case 'memory': {
      const backend = choice(r.backend, ['sqlite', 'postgres'], 'memory backend');
      const base: MemoryConfig = { type: 'memory', backend, namespace: text(r.namespace, 'Namespace', 100), scope: choice(r.scope, ['agent', 'shared'], 'memory scope'), retentionDays: integer(r.retentionDays, 1, 3650, 'Retention'), maxEntries: integer(r.maxEntries, 1, 1000, 'Entry limit'), contextItems: integer(r.contextItems, 0, 30, 'Context items') };
      if (backend === 'sqlite') return base;
      const host = text(r.host, 'PostgreSQL host', 253); if (/[\s/@?#]/.test(host)) fail('Enter a host name, not a connection string.');
      const table = text(r.table, 'Memory table', 63); if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table)) fail('Table names can contain letters, digits, and underscores.');
      return { ...base, host, port: integer(r.port, 1, 65535, 'PostgreSQL port'), database: text(r.database, 'Database', 100), user: text(r.user, 'Database user', 100), table, tls: r.tls !== false, ...credential };
    }
    case 'tool': {
      const implementation = choice(r.implementation, ['http', 'javascript'], 'tool implementation');
      const functionName = text(r.functionName, 'Function name', 64); if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(functionName)) fail('Use a function name containing letters, digits, and underscores.');
      const inputSchema = schema(r.inputSchema); if (inputSchema.type !== 'object') fail('Tool input schema must describe an object.');
      const base: ToolConfig = { type: 'tool', implementation, functionName, inputSchema, timeoutMs: integer(r.timeoutMs, 100, 30000, 'Timeout (ms)') };
      const defaults = r.defaults === undefined ? {} : { defaults: obj(r.defaults) }; if (JSON.stringify(defaults).length > 8000) fail('HTTP defaults must fit in 8 KB.');
      return implementation === 'javascript' ? { ...base, code: text(r.code, 'JavaScript function body', 20000) } : { ...base, method: choice(r.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const, 'HTTP method'), url: resourceUrl(r.url), ...credential, ...defaults };
    }
    case 'output': {
      const destination = choice(r.destination, ['dashboard', 'file', 'webhook'], 'output destination');
      const base: OutputConfig = { type: 'output', destination, format: choice(r.format, ['text', 'json'], 'output format'), ...(r.schema === undefined ? {} : { schema: schema(r.schema) }) };
      if (destination === 'webhook') return { ...base, url: resourceUrl(r.url), ...credential };
      if (destination === 'file') { const path = text(r.path, 'Project-relative output path', 500); if (/^[\\/]|^[A-Za-z]:|[\x00-\x1f]/.test(path) || path.split(/[\\/]/).some(p => p === '..' || p.toLowerCase() === '.git')) fail('Use a path inside the project, without parent traversal or .git.'); return { ...base, path }; }
      return base;
    }
    case 'input': { const format = choice(r.format, ['text', 'json'], 'input format'); return { type: 'input', format, ...(format !== 'json' || r.schema === undefined ? {} : { schema: schema(r.schema) }) }; }
    case 'approval': return { type: 'approval', message: text(r.message, 'Approval request', 2000), timeoutMinutes: integer(r.timeoutMinutes, 1, 120, 'Approval timeout') };
    case 'router': {
      if (!Array.isArray(r.rules) || r.rules.length > 20) fail('Use up to 20 routing rules.');
      return { type: 'router', rules: (r.rules as unknown[]).map(x => { const rule = obj(x); return { field: text(rule.field, 'JSON field', 200), operator: choice(rule.operator, ['equals', 'contains', 'exists'], 'operator'), value: text(rule.value, 'Match value', 1000, true), target: text(rule.target, 'Destination node', 100) }; }), fallback: text(r.fallback, 'Fallback node', 100, true) };
    }
    default: return fail('This block is not a configurable resource.');
  }
}
