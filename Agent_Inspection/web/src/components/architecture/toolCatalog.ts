import { request } from '../../api.ts';
import type { ServiceConnection } from '../../../../shared/agentPlatform.ts';
import type { ArchitectureSnapshot } from '../../../../shared/architecture.ts';

/** Shapes returned by the "Add tool" endpoints (daemon/architecture/toolBuilder.ts). */
export interface McpPreset { id: string; name: string; server: string; url: string; auth: 'none' | 'token' | 'optional'; tokenHint: string; description: string }
export interface LibraryMcpServer { id: string; label: string; url: string; hasAuthorization: boolean; unsupportedHeaders: string[] }
export interface ToolWriter { id: string; label: string; provider: string; model: string }
export interface ToolCatalog { mcpPresets: McpPreset[]; libraryMcp: LibraryMcpServer[]; mcpConnections: ServiceConnection[]; searchConnections: ServiceConnection[]; writers: ToolWriter[] }
export interface ProbedTool { name: string; description: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } }
export interface ProbeResult { server: string; label: string; tools: ProbedTool[] }
export interface JsonSchemaLike { type?: string | string[]; properties?: Record<string, JsonSchemaLike>; required?: string[]; description?: string; enum?: unknown[]; items?: JsonSchemaLike }
export interface ToolDraft {
  name: string; description: string; functionName: string; implementation: 'javascript' | 'http';
  inputSchema: JsonSchemaLike; code?: string; method?: string; url?: string; readOnly: boolean;
  sampleInput: unknown; needsCredential?: boolean; credentialHint?: string;
}
export type ToolTest = { input: unknown; output: unknown } | { skipped: string };
export interface GenerateResult { draft: ToolDraft; test: ToolTest; attempts: number }
export interface AddToolResult { snapshot: ArchitectureSnapshot; enabledToolAccess: boolean; message: string }

/** Where an MCP server comes from. Exactly one source is sent to the probe and add calls. */
export type McpSource = { presetId: string } | { libraryId: string } | { connectionId: string } | { url: string };

/** Posts one add-tool request; the flows only describe *what* to add. */
export type AddTool = (body: Record<string, unknown>) => Promise<void>;

export const SERVER_PREFIX = /^[a-z][a-z0-9_]{0,23}$/;
export const MAX_MCP_TOOLS = 50;
export const TAVILY_KEY_URL = 'https://app.tavily.com';

const enc = encodeURIComponent;
export const loadCatalog = (project: string, signal?: AbortSignal): Promise<ToolCatalog> =>
  request<ToolCatalog>('GET', `/api/agent-tools/catalog?project=${enc(project)}`, undefined, signal);
export const toolsUrl = (documentId: string, nodeId: string): string => `/api/architectures/${enc(documentId)}/nodes/${enc(nodeId)}/tools`;

/** Mirrors the daemon's namespacing so the operator sees the exact model-facing name. */
export const exposedName = (server: string, tool: string): string => {
  const safe = `${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, '_');
  return (/^[A-Za-z_]/.test(safe) ? safe : `t_${safe}`).slice(0, 64);
};

/** An auth problem is fixed in the token field, so the flow moves focus there. */
export const isAuthError = (message: string): boolean => /token|authenticat|unauthori[sz]ed|401|403|credential/i.test(message);

export interface ArgumentRow { name: string; type: string; required: boolean; description: string }
const typeOf = (schema: JsonSchemaLike): string => {
  if (schema.enum?.length) return `one of ${schema.enum.slice(0, 6).map(v => JSON.stringify(v)).join(', ')}${schema.enum.length > 6 ? ', …' : ''}`;
  const type = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type ?? 'any';
  return type === 'array' && schema.items?.type ? `list of ${String(schema.items.type)}` : type;
};
/** The top-level arguments a model may pass, in a form an operator can read without knowing JSON Schema. */
export const argumentRows = (schema: JsonSchemaLike | undefined): ArgumentRow[] => {
  const required = new Set(schema?.required ?? []);
  return Object.entries(schema?.properties ?? {}).map(([name, prop]) => ({ name, type: typeOf(prop ?? {}), required: required.has(name), description: prop?.description ?? '' }));
};

export const preview = (value: unknown): string => { try { return JSON.stringify(value, null, 2) ?? 'undefined'; } catch { return String(value); } };
export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';
export const message = (e: unknown): string => e instanceof Error ? e.message : 'Something went wrong. Try again.';
