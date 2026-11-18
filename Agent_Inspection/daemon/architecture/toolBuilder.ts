import Ajv from 'ajv';
import type { LibraryDeps } from '../library/deps.ts';
import { LibraryInputError } from '../library/types.ts';
import { folderRoot } from '../files/folderFiles.ts';
import { assertResolvedHostAllowed } from '../library/urlGuard.ts';
import { resourceUrl, validateResource, type JsonSchema, type ToolConfig } from '../../shared/agentResources.ts';
import { DEFAULT_SANDBOX, validateSandbox } from '../../shared/agentEvaluation.ts';
import type { AgentCapability } from '../../shared/agentPlatform.ts';
import type { ArchitectureNode, ArchitectureSnapshot } from '../../shared/architecture.ts';
import type { ArchitectureStore } from './store.ts';
import type { AgentPlatform } from './platform.ts';
import type { BrainConnections } from './brains.ts';
import type { AgentSandboxes } from './sandboxes.ts';
import type { AgentResources } from './resources.ts';
import { McpHttpClient, type McpToolDefinition } from './mcpClient.ts';

/**
 * Turns "I want my agent to be able to do X" into a working, attached tool in one step, so operators never have
 * to know the order of connections → capabilities → attachments, and never have to write tool code by hand.
 */

/** Well-known remote MCP servers. URLs are the vendors' published Streamable HTTP endpoints. */
export const MCP_SERVER_PRESETS = [
  { id: 'context7', name: 'Context7', server: 'context7', url: 'https://mcp.context7.com/mcp', auth: 'none', tokenHint: '', description: 'Up-to-date library and framework documentation.' },
  { id: 'deepwiki', name: 'DeepWiki', server: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp', auth: 'none', tokenHint: '', description: 'Ask questions about public GitHub repositories.' },
  { id: 'github', name: 'GitHub', server: 'github', url: 'https://api.githubcopilot.com/mcp/', auth: 'token', tokenHint: 'A GitHub personal access token.', description: 'Issues, pull requests, code search and repositories.' },
  { id: 'tavily', name: 'Tavily', server: 'tavily', url: 'https://mcp.tavily.com/mcp/', auth: 'token', tokenHint: 'Your Tavily API key.', description: 'Web search, extract, map and crawl.' },
  { id: 'huggingface', name: 'Hugging Face', server: 'huggingface', url: 'https://huggingface.co/mcp', auth: 'optional', tokenHint: 'Optional Hugging Face access token.', description: 'Models, datasets, Spaces and papers.' },
] as const;

export interface ToolDraft {
  name: string; description: string; functionName: string; implementation: 'javascript' | 'http';
  inputSchema: JsonSchema; code?: string; method?: ToolConfig['method']; url?: string; readOnly: boolean;
  sampleInput: unknown; needsCredential?: boolean; credentialHint?: string;
}
export type ToolTest = { input: unknown; output: unknown } | { skipped: string };
export interface LibraryMcpSource {
  remoteServers(): { id: string; name: string; label: string; url: string; hasAuthorization: boolean; otherHeaders: string[] }[];
  remoteCredentials(id: string): { url: string; authorization?: string; name: string; otherHeaders: string[] };
}

const FUNCTION_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_REPAIRS = 2;
const PROBE_TIMEOUT_MS = 20_000;
const slug = (text: string, max = 24) => (text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 's$1') || 'server').slice(0, max);
const stripFence = (text: string) => text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');

const WRITER_ROLE = `You write tools for AI agents on an agent platform. The operator describes what the tool should do; you return the tool.

Choose one implementation:
- "javascript": pure computation or text processing. The code is the BODY of a synchronous function that receives \`input\` (the validated arguments object) and returns a JSON-serialisable value. It runs in an isolated interpreter: no network, files, imports, require, timers or async. Keep it under 300 lines, defensive and deterministic.
- "http": calling an existing web API. Give the HTTPS endpoint URL (no query string, no credentials in the URL) and method. GET sends arguments as query parameters; other methods send them as the JSON body. If the API needs a key, set needsCredential true and say in credentialHint exactly what to paste (it is sent as the Authorization header value).

Rules for the interface the model will see:
- functionName: snake_case verb phrase, at most 64 chars (e.g. "convert_currency").
- description: 1-3 sentences telling an AI agent WHEN to use the tool and what it returns.
- inputSchema: a JSON Schema object with "type":"object", "additionalProperties": false, a "required" list, and a "description" on every property. Use enums and bounds where they apply.
- readOnly: true only if calling the tool never changes anything outside the agent.
- sampleInput: one realistic arguments object that satisfies inputSchema; it is used to test the tool.

Return ONLY one JSON object, no prose:
{"name": "...", "functionName": "...", "description": "...", "implementation": "javascript" | "http", "inputSchema": {...}, "code": "...", "method": "GET|POST|PUT|PATCH|DELETE", "url": "https://...", "readOnly": true, "needsCredential": false, "credentialHint": "", "sampleInput": {...}}
Omit "code" for http tools and omit "method"/"url" for javascript tools.`;

export class AgentToolBuilder {
  library?: LibraryMcpSource;
  constructor(private readonly deps: LibraryDeps, private readonly architectures: ArchitectureStore, private readonly platform: AgentPlatform, private readonly brains: BrainConnections, private readonly sandboxes: AgentSandboxes, private readonly resources: AgentResources) {}

  /** Everything the "Add tool" dialog needs in one call. Never returns secret values. */
  catalog(project: unknown) {
    const root = this.root(project);
    const connections = this.platform.connections(root);
    return {
      mcpPresets: MCP_SERVER_PRESETS,
      libraryMcp: (this.library?.remoteServers() ?? []).map(({ id, label, name, url, hasAuthorization, otherHeaders }) => ({ id, label: label || name, url, hasAuthorization, unsupportedHeaders: otherHeaders })),
      mcpConnections: connections.filter(c => c.kind === 'mcp'),
      searchConnections: connections.filter(c => c.kind === 'tavily'),
      writers: this.brains.list(root).map(({ id, label, provider, model }) => ({ id, label, provider, model })),
    };
  }

  private root(project: unknown): string { try { return folderRoot(project); } catch (e) { throw new LibraryInputError((e as Error).message); } }

  /** Resolves where an MCP server lives and how to authenticate: a saved connection, a Library server, a preset, or a pasted URL. */
  private mcpEndpoint(root: string, raw: Record<string, unknown>): { url: string; authorization?: string; connectionId?: string; suggested: string; label: string } {
    const token = typeof raw.token === 'string' && raw.token.trim() ? raw.token.trim() : undefined;
    const bearer = token ? (/^bearer\s/i.test(token) ? token : `Bearer ${token}`) : undefined;
    if (typeof raw.connectionId === 'string' && raw.connectionId) {
      const c = this.platform.connections(root).find(x => x.id === raw.connectionId && x.kind === 'mcp');
      if (!c) throw new LibraryInputError('That MCP connection is not in this project.');
      const authorization = c.hasSecret ? this.deps.secrets.get(`architecture-resource:${c.id}:authorization`) : undefined;
      return { url: c.endpoint!, ...(authorization ? { authorization } : {}), connectionId: c.id, suggested: slug(c.name), label: c.name };
    }
    if (typeof raw.libraryId === 'string' && raw.libraryId) {
      if (!this.library) throw new LibraryInputError('The MCP library is unavailable.');
      const server = this.library.remoteCredentials(raw.libraryId);
      if (server.otherHeaders.length) throw new LibraryInputError(`This Library server authenticates with ${server.otherHeaders.join(', ')}. Built agents send credentials only as an Authorization header; paste the URL and a token instead.`);
      const authorization = bearer ?? server.authorization;
      return { url: server.url, ...(authorization ? { authorization } : {}), suggested: slug(server.name), label: server.name };
    }
    const preset = MCP_SERVER_PRESETS.find(p => p.id === raw.presetId);
    if (preset && preset.auth === 'token' && !bearer) throw new LibraryInputError(`${preset.name} needs a token: ${preset.tokenHint}`);
    let url: string; try { url = resourceUrl(preset?.url ?? raw.url); } catch (e) { throw new LibraryInputError(`${(e as Error).message} Paste the server's MCP endpoint, e.g. https://example.com/mcp`); }
    const host = new URL(url).hostname.replace(/^(mcp|api|www)\./, '').split('.')[0];
    return { url, ...(bearer ? { authorization: bearer } : {}), suggested: preset?.server ?? slug(host), label: preset?.name ?? new URL(url).hostname };
  }

  /** Connects and lists tools without saving anything, so the operator sees what a server offers before committing. */
  async probeMcp(project: unknown, raw: Record<string, unknown>): Promise<{ server: string; label: string; tools: Omit<McpToolDefinition, 'schemaHash'>[] }> {
    const root = this.root(project); const endpoint = this.mcpEndpoint(root, raw);
    await assertResolvedHostAllowed(new URL(endpoint.url).hostname, 'The MCP server URL', { allowLoopback: true });
    const client = new McpHttpClient({ url: endpoint.url, headers: endpoint.authorization ? { authorization: endpoint.authorization } : {} }, this.platform.mcpSend);
    try {
      const tools = await client.listTools(AbortSignal.timeout(PROBE_TIMEOUT_MS));
      if (!tools.length) throw new LibraryInputError('The server answered but offers no tools.');
      return { server: endpoint.suggested, label: endpoint.label, tools: tools.map(({ schemaHash: _, ...t }) => t) };
    } catch (e) {
      if (e instanceof LibraryInputError && /credentials/.test(e.message) && !endpoint.authorization) throw new LibraryInputError('The server requires authentication. Paste an access token and try again.');
      throw e;
    } finally { await client.close(); }
  }

  /**
   * A model writes the tool from the operator's description; the platform validates the interface, test-runs
   * JavaScript in the sandbox, and feeds failures back for up to two repairs. Nothing is saved until the operator adds it.
   */
  async generate(project: unknown, raw: Record<string, unknown>): Promise<{ draft: ToolDraft; test: ToolTest; attempts: number }> {
    const root = this.root(project);
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (description.length < 10 || description.length > 4000) throw new LibraryInputError('Describe what the tool should do in 10–4000 characters.');
    const connectionId = String(raw.connectionId ?? '');
    if (!this.brains.list(root).some(c => c.id === connectionId)) throw new LibraryInputError('Choose a model connection to write the tool. Add one under Agents → Model connections if the list is empty.');
    const current = raw.current && typeof raw.current === 'object' ? JSON.stringify(raw.current).slice(0, 30000) : undefined;
    const request = current ? `Revise this existing tool.\n\nCurrent tool:\n${current}\n\nRequested change:\n${description}` : `Write a tool that does the following:\n${description}`;
    let prompt = request; let lastError = '';
    for (let attempt = 1; attempt <= MAX_REPAIRS + 1; attempt++) {
      const reply = await this.brains.run(connectionId, root, WRITER_ROLE, prompt, { maxOutputTokens: 4096, maxSteps: 1, maxToolCalls: 0 });
      let candidate: unknown;
      try { candidate = JSON.parse(stripFence(reply.text)); } catch { candidate = undefined; }
      try {
        if (!candidate || typeof candidate !== 'object') throw new LibraryInputError('The reply was not a JSON object.');
        const draft = this.checkDraft(candidate as Record<string, unknown>);
        const test = await this.testDraft(root, draft);
        this.deps.audit('agent_tool_generate', draft.functionName, { implementation: draft.implementation, attempts: attempt });
        return { draft, test, attempts: attempt };
      } catch (e) {
        lastError = e instanceof LibraryInputError ? e.message : 'The draft could not be validated.';
        prompt = `${request}\n\nYour previous answer:\n${stripFence(reply.text).slice(0, 12000)}\n\nIt was rejected: ${lastError}\nReturn a corrected JSON object only.`;
      }
    }
    throw new LibraryInputError(`The model could not produce a working tool after ${MAX_REPAIRS + 1} attempts. Last problem: ${lastError} Try a more specific description or a stronger model.`);
  }

  private checkDraft(d: Record<string, unknown>): ToolDraft {
    const functionName = typeof d.functionName === 'string' ? d.functionName.trim() : '';
    if (!FUNCTION_NAME.test(functionName)) throw new LibraryInputError('functionName must be snake_case, start with a letter, and be at most 64 characters.');
    const description = typeof d.description === 'string' ? d.description.trim() : '';
    if (description.length < 10 || description.length > 2000) throw new LibraryInputError('description must explain when to use the tool (10–2000 characters).');
    if (d.implementation !== 'javascript' && d.implementation !== 'http') throw new LibraryInputError('implementation must be "javascript" or "http".');
    const inputSchema = d.inputSchema as JsonSchema;
    if (!inputSchema || typeof inputSchema !== 'object' || inputSchema.type !== 'object') throw new LibraryInputError('inputSchema must be a JSON Schema with "type": "object".');
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    let validate: ReturnType<Ajv['compile']>;
    try { validate = ajv.compile(inputSchema); } catch (e) { throw new LibraryInputError(`inputSchema does not compile: ${(e as Error).message.slice(0, 300)}`); }
    if (!validate(d.sampleInput)) throw new LibraryInputError(`sampleInput does not satisfy inputSchema: ${ajv.errorsText(validate.errors).slice(0, 400)}`);
    const base = { type: 'tool', functionName, inputSchema, timeoutMs: d.implementation === 'http' ? 15000 : 1000, readOnly: typeof d.readOnly === 'boolean' ? d.readOnly : d.implementation === 'javascript' };
    const config = d.implementation === 'javascript' ? { ...base, implementation: 'javascript', code: d.code } : { ...base, implementation: 'http', method: d.method, url: d.url };
    let checked: ToolConfig; try { checked = validateResource('tool', config) as ToolConfig; } catch (e) { throw new LibraryInputError((e as Error).message); }
    return {
      name: typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 100) : functionName.replace(/_/g, ' '), description, functionName,
      implementation: checked.implementation as ToolDraft['implementation'], inputSchema, ...(checked.code ? { code: checked.code } : {}), ...(checked.method ? { method: checked.method, url: checked.url } : {}),
      readOnly: checked.readOnly ?? true, sampleInput: d.sampleInput,
      ...(checked.implementation === 'http' && d.needsCredential === true ? { needsCredential: true, credentialHint: typeof d.credentialHint === 'string' ? d.credentialHint.slice(0, 300) : '' } : {}),
    };
  }

  private async testDraft(root: string, draft: ToolDraft): Promise<ToolTest> {
    if (draft.implementation === 'http') return { skipped: 'HTTP tools call a live service; use Test after adding it (and after adding its key, if it needs one).' };
    const output = await this.sandboxes.evaluateJavaScript(root, draft.code!, draft.sampleInput);
    return { input: draft.sampleInput, output };
  }

  /** Names the agent already exposes, so a new tool never collides with an existing one. */
  private usedNames(node: ArchitectureNode, project: string, graphTools: ArchitectureNode[]): Set<string> {
    const names = new Set(graphTools.map(n => (n.config as ToolConfig | undefined)?.functionName).filter((n): n is string => !!n));
    for (const ref of node.capabilities ?? []) {
      try { const spec = this.platform.capability(project, ref.id, ref.version).spec; if (spec.kind === 'tool') names.add(spec.config.functionName); if (spec.kind === 'tavily') names.add(spec.functionName); } catch { /* A missing capability is reported at deploy. */ }
    }
    return names;
  }
  private unique(name: string, used: Set<string>): string { if (!used.has(name)) return name; for (let i = 2; ; i++) { const next = `${name.slice(0, 60)}_${i}`; if (!used.has(next)) return next; } }

  /**
   * One step from intent to an attached tool: creates or reuses the connection, publishes the capability,
   * attaches it to the agent, and turns on tool access if the agent was chat-only. Returns what changed.
   */
  async addTool(architectureId: string, nodeId: string, raw: Record<string, unknown>): Promise<{ snapshot: ArchitectureSnapshot; capability?: AgentCapability; enabledToolAccess: boolean; message: string }> {
    const doc = this.architectures.get(architectureId).document;
    if (raw.expectedRevision !== doc.revision) throw new LibraryInputError('The workflow changed. Reload it, then add the tool again.');
    const node = doc.nodes.find(n => n.id === nodeId);
    if (!node || node.kind !== 'agent' || !node.runtime) throw new LibraryInputError('Choose a model for this agent before adding tools.');
    const used = this.usedNames(node, doc.project, this.resources.connected(doc, nodeId, 'tool'));
    let next: ArchitectureNode = structuredClone(node); let capability: AgentCapability | undefined; let message: string;
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 100) : undefined;
    switch (raw.kind) {
      case 'code_execution': {
        if (node.runtime.kind !== 'api') throw new LibraryInputError('Code execution is for API agents. Coding runtimes already run code on the host, with approvals.');
        let sandbox; try { sandbox = raw.sandbox ? validateSandbox(raw.sandbox) : DEFAULT_SANDBOX; } catch (e) { throw new LibraryInputError((e as Error).message); }
        next = { ...next, runtime: { ...next.runtime!, codeExecution: sandbox } };
        message = `Code execution is on: the agent can call run_code (${sandbox.language}, ${sandbox.backend === 'docker' ? 'container' : 'isolated interpreter'}).`;
        break;
      }
      case 'web_search': {
        let connectionId = typeof raw.connectionId === 'string' ? raw.connectionId : '';
        if (!connectionId) { if (typeof raw.apiKey !== 'string' || !raw.apiKey.trim()) throw new LibraryInputError('Paste your Tavily API key (from app.tavily.com), or pick a saved key.'); connectionId = this.platform.saveConnection(doc.project, { kind: 'tavily', name: 'Tavily', secret: raw.apiKey.trim() }).id; }
        capability = await this.platform.publishCapability(doc.project, { name: name ?? 'Web search', description: '', spec: { kind: 'tavily', connectionId, functionName: this.unique('web_search', used), maxResults: Number.isInteger(raw.maxResults) ? raw.maxResults : 5, searchDepth: raw.searchDepth === 'advanced' ? 'advanced' : 'basic', includeDomains: Array.isArray(raw.includeDomains) ? raw.includeDomains : [], excludeDomains: Array.isArray(raw.excludeDomains) ? raw.excludeDomains : [] } });
        message = 'Web search added.';
        break;
      }
      case 'mcp': {
        const endpoint = this.mcpEndpoint(doc.project, raw);
        if (!Array.isArray(raw.allow) || !raw.allow.length) throw new LibraryInputError('Tick at least one tool to give the agent.');
        const server = typeof raw.server === 'string' && raw.server ? raw.server : endpoint.suggested;
        // Reuse a saved connection to the same server unless a new token was supplied.
        const existing = endpoint.connectionId ?? (!raw.token ? this.platform.connections(doc.project).find(c => c.kind === 'mcp' && c.endpoint === endpoint.url && c.hasSecret === !!endpoint.authorization)?.id : undefined);
        const connectionId = existing ?? this.platform.saveConnection(doc.project, { kind: 'mcp', name: endpoint.label, endpoint: endpoint.url, ...(endpoint.authorization ? { secret: endpoint.authorization } : {}) }).id;
        capability = await this.platform.publishCapability(doc.project, { name: name ?? endpoint.label, description: '', spec: { kind: 'mcp', connectionId, server, approval: raw.approval === 'trust_read_only' ? 'trust_read_only' : 'always', allow: raw.allow } });
        message = `${raw.allow.length} tool${raw.allow.length === 1 ? '' : 's'} from ${endpoint.label} added.`;
        break;
      }
      case 'custom': {
        const draft = this.checkDraft((raw.draft ?? {}) as Record<string, unknown>);
        const config: Record<string, unknown> = draft.implementation === 'javascript'
          ? { type: 'tool', implementation: 'javascript', functionName: this.unique(draft.functionName, used), inputSchema: draft.inputSchema, code: draft.code, timeoutMs: 1000, readOnly: draft.readOnly }
          : { type: 'tool', implementation: 'http', functionName: this.unique(draft.functionName, used), inputSchema: draft.inputSchema, method: draft.method, url: draft.url, timeoutMs: 15000, readOnly: draft.readOnly };
        if (draft.implementation === 'http' && typeof raw.secret === 'string' && raw.secret.trim()) config.credentialId = this.resources.storeCredential(doc.project, 'authorization', raw.secret.trim());
        capability = await this.platform.publishCapability(doc.project, { name: name ?? draft.name, description: draft.description, spec: { kind: 'tool', config } });
        message = `${draft.name} added${draft.readOnly ? '' : '; it can change things, so each call asks for approval'}.`;
        break;
      }
      default: throw new LibraryInputError('Choose web search, an MCP server, code execution, or a tool to describe.');
    }
    if (capability) next.capabilities = [...(next.capabilities ?? []).filter(c => c.id !== capability!.id), { id: capability.id, version: capability.version }];
    // Adding a tool is an explicit request for the agent to use tools: lift the "Chat only" trap instead of failing later.
    const enabledToolAccess = next.runtime!.policy === 'chat-only';
    if (enabledToolAccess) next = { ...next, runtime: { ...next.runtime!, policy: next.runtime!.kind === 'api' ? 'configured-tools' : 'review-tools' } };
    const snapshot = this.architectures.update(doc.id, doc.revision, [{ type: 'put_node', node: next }]);
    this.deps.audit('agent_tool_add', `${doc.id}:${nodeId}`, { kind: String(raw.kind), capabilityId: capability?.id ?? null, enabledToolAccess });
    return { snapshot, ...(capability ? { capability } : {}), enabledToolAccess, message: enabledToolAccess ? `${message} Tool access was "Chat only", so it is now on.` : message };
  }

  /** Detaches a capability (or turns code execution off). The capability itself stays in the library for reuse. */
  removeTool(architectureId: string, nodeId: string, raw: Record<string, unknown>): ArchitectureSnapshot {
    const doc = this.architectures.get(architectureId).document;
    if (raw.expectedRevision !== doc.revision) throw new LibraryInputError('The workflow changed. Reload it, then try again.');
    const node = doc.nodes.find(n => n.id === nodeId); if (!node || node.kind !== 'agent') throw new LibraryInputError('Agent not found.');
    let next: ArchitectureNode;
    if (raw.codeExecution === true) { const { codeExecution: _, ...runtime } = node.runtime ?? ({} as NonNullable<ArchitectureNode['runtime']>); next = { ...node, ...(node.runtime ? { runtime: runtime as NonNullable<ArchitectureNode['runtime']> } : {}) }; }
    else next = { ...node, capabilities: (node.capabilities ?? []).filter(c => c.id !== raw.capabilityId) };
    this.deps.audit('agent_tool_remove', `${doc.id}:${nodeId}`, { capabilityId: raw.capabilityId ?? null, codeExecution: raw.codeExecution === true });
    return this.architectures.update(doc.id, doc.revision, [{ type: 'put_node', node: next }]);
  }
}
