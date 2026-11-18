import { createHash } from 'node:crypto';
import { LibraryInputError } from '../library/types.ts';
import type { JsonSchema } from '../../shared/agentResources.ts';

/**
 * Minimal MCP client over Streamable HTTP (MCP 2025-06-18+): initialize, tools/list (paginated), tools/call.
 * Used by built agents through the tool gateway. Stdio servers are intentionally not supported here: a built
 * agent must not spawn arbitrary local processes; stdio servers stay a coding-CLI feature.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const MAX_TOOLS = 200;
const MAX_PAGES = 10;
const MAX_REPLY_BYTES = 2_000_000;

export interface McpToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
export interface McpToolDefinition { name: string; description: string; inputSchema: JsonSchema; annotations: McpToolAnnotations; schemaHash: string }
export interface McpEndpoint { url: string; headers: Record<string, string> }

type Json = Record<string, unknown>;

/** Stable hash of what the model sees. A change means the server altered the tool after publish and it must be re-reviewed. */
export function mcpSchemaHash(tool: { name: string; description?: unknown; inputSchema?: unknown }): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value as Json).sort().map(k => [k, canonical((value as Json)[k])])) : value;
  return createHash('sha256').update(JSON.stringify(canonical({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? {} }))).digest('hex');
}

async function readReply(response: Response, id: number): Promise<Json> {
  const type = response.headers.get('content-type') ?? '';
  const reader = response.body?.getReader(); if (!reader) throw new LibraryInputError('The MCP server returned an empty response.');
  const decoder = new TextDecoder(); let text = ''; let bytes = 0;
  const parse = (raw: string): Json | undefined => { try { const m = JSON.parse(raw) as Json; return m && m.id === id ? m : undefined; } catch { return undefined; } };
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.length; if (bytes > MAX_REPLY_BYTES) throw new LibraryInputError('The MCP server reply exceeds 2 MB.');
      text += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
      if (type.includes('text/event-stream')) {
        let cut = text.indexOf('\n\n');
        while (cut !== -1) {
          const block = text.slice(0, cut); text = text.slice(cut + 2);
          const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
          const message = data ? parse(data) : undefined; if (message) return message;
          cut = text.indexOf('\n\n');
        }
      }
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const message = type.includes('text/event-stream') ? undefined : parse(text);
  if (!message) throw new LibraryInputError('The MCP server did not answer the request.');
  return message;
}

export class McpHttpClient {
  private session?: string;
  private nextId = 1;
  private initialized = false;
  private connecting?: Promise<void>;
  constructor(private readonly endpoint: McpEndpoint, private readonly send: typeof fetch = fetch) {}

  private headers(): Record<string, string> {
    return { ...this.endpoint.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(this.initialized ? { 'mcp-protocol-version': MCP_PROTOCOL_VERSION } : {}), ...(this.session ? { 'mcp-session-id': this.session } : {}) };
  }

  private async rpc(method: string, params: Json, signal: AbortSignal): Promise<Json> {
    const id = this.nextId++;
    let response: Response;
    try { response = await this.send(this.endpoint.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), redirect: 'error', signal }); }
    catch { throw new LibraryInputError(signal.aborted ? 'The MCP request timed out or was cancelled.' : 'Could not reach the MCP server.'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new LibraryInputError(response.status === 401 || response.status === 403 ? `The MCP server rejected the credentials (HTTP ${response.status}).` : `The MCP server answered HTTP ${response.status}.`);
    }
    this.session ??= response.headers.get('mcp-session-id') ?? undefined;
    const reply = await readReply(response, id);
    const error = reply.error as Json | undefined;
    if (error) throw new LibraryInputError(`The MCP server returned an error: ${String(error.message ?? 'unknown error').slice(0, 200)}`);
    return (reply.result ?? {}) as Json;
  }

  /** Single-flight: parallel first calls share one initialize handshake. */
  connect(signal: AbortSignal): Promise<void> {
    if (this.initialized) return Promise.resolve();
    this.connecting ??= this.handshake(signal).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async handshake(signal: AbortSignal): Promise<void> {
    await this.rpc('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'waystation-agent', version: '1.0.0' } }, signal);
    this.initialized = true;
    try { const r = await this.send(this.endpoint.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), redirect: 'error', signal }); await r.body?.cancel(); }
    catch { /* The notification is best-effort; servers that require it reject the next call. */ }
  }

  async listTools(signal: AbortSignal): Promise<McpToolDefinition[]> {
    await this.connect(signal);
    const tools: McpToolDefinition[] = []; let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.rpc('tools/list', cursor ? { cursor } : {}, signal);
      for (const raw of Array.isArray(result.tools) ? result.tools as Json[] : []) {
        if (typeof raw?.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(raw.name)) continue;
        const schema = raw.inputSchema && typeof raw.inputSchema === 'object' && !Array.isArray(raw.inputSchema) ? raw.inputSchema as JsonSchema : { type: 'object' };
        const a = (raw.annotations && typeof raw.annotations === 'object' ? raw.annotations : {}) as Json;
        const annotations: McpToolAnnotations = Object.fromEntries(['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].filter(k => typeof a[k] === 'boolean').map(k => [k, a[k]]));
        tools.push({ name: raw.name, description: typeof raw.description === 'string' ? raw.description.slice(0, 2000) : '', inputSchema: schema.type === 'object' ? schema : { type: 'object' }, annotations, schemaHash: mcpSchemaHash(raw as { name: string }) });
        if (tools.length >= MAX_TOOLS) return tools;
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  /** Calls a tool. Server-reported failures (isError) become errors the model sees; structured output is preferred over text. */
  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    await this.connect(signal);
    const result = await this.rpc('tools/call', { name, arguments: args ?? {} }, signal);
    const content = Array.isArray(result.content) ? result.content as Json[] : [];
    const text = content.map(c => c.type === 'text' && typeof c.text === 'string' ? c.text : c.type === 'resource_link' ? `[resource] ${String(c.uri ?? '')}` : `[${String(c.type ?? 'content')} omitted]`).join('\n');
    if (result.isError === true) throw new LibraryInputError(`The MCP tool reported an error: ${text.slice(0, 1000) || 'no details'}`);
    if (result.structuredContent !== undefined) return result.structuredContent;
    if (content.length === 1 && content[0].type === 'text') { try { return JSON.parse(text); } catch { return { text }; } }
    return { text };
  }

  async close(): Promise<void> {
    if (!this.session) return;
    try { const r = await this.send(this.endpoint.url, { method: 'DELETE', headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(3000) }); await r.body?.cancel(); }
    catch { /* Session cleanup is best-effort. */ }
    this.session = undefined; this.initialized = false;
  }
}

/** Model-facing name for an MCP tool: `<server>__<tool>`, restricted to the strictest common provider subset. */
export function namespacedToolName(server: string, tool: string): string {
  const safe = `${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, '_');
  return (/^[A-Za-z_]/.test(safe) ? safe : `t_${safe}`).slice(0, 64);
}
