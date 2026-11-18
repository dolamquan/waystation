import { describe, expect, it, vi } from 'vitest';
import { TowerStore } from '../daemon/store/db.ts';
import { SecretStore } from '../daemon/library/secretStore.ts';
import { ArchitectureStore } from '../daemon/architecture/store.ts';
import { AgentResources } from '../daemon/architecture/resources.ts';
import { BrainConnections } from '../daemon/architecture/brains.ts';
import { AgentRuns } from '../daemon/architecture/runs.ts';
import { AgentPlatform } from '../daemon/architecture/platform.ts';
import { AgentSandboxes } from '../daemon/architecture/sandboxes.ts';
import { AgentToolBuilder } from '../daemon/architecture/toolBuilder.ts';
import { tempDir } from './helpers.ts';

const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
const wait = async (predicate: () => boolean) => { const end = Date.now() + 10000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); } };

/** In-process MCP server (see agentToolGateway.test.ts for why it is not a socket). */
function fakeMcp(requireToken?: string) {
  const seen: { authorization?: string; url: string }[] = [];
  const send = vi.fn<typeof fetch>(async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>; seen.push({ authorization: headers.authorization, url: String(url) });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (requireToken && headers.authorization !== `Bearer ${requireToken}`) return new Response('no', { status: 401 });
    const m = JSON.parse(String(init?.body)); if (m.id === undefined) return new Response(null, { status: 202 });
    const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} } : m.method === 'tools/list'
      ? { tools: [{ name: 'resolve-library-id', description: 'Find a library.', inputSchema: { type: 'object', properties: { libraryName: { type: 'string' } }, required: ['libraryName'] }, annotations: { readOnlyHint: true } }, { name: 'get-library-docs', description: 'Fetch docs.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }] }
      : { content: [{ type: 'text', text: '{"ok":true}' }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 's' } });
  });
  return { send, seen };
}

function setup(model: typeof fetch, mcpSend?: typeof fetch) {
  const project = tempDir('tool-builder-'); const store = new TowerStore(':memory:'); const deps = { store, secrets: new SecretStore(':memory:'), audit: vi.fn(), paths: {} as any };
  const architectures = new ArchitectureStore(store); const brains = new BrainConnections(deps, model); const resources = new AgentResources(deps, mcpSend); const runs = new AgentRuns(deps, architectures, brains, resources);
  const platform = new AgentPlatform(deps, architectures, brains, resources, runs); if (mcpSend) platform.mcpSend = mcpSend;
  const sandboxes = new AgentSandboxes(deps, (p, t) => brains.sanitize(p, resources.sanitize(p, t))); runs.sandboxes = sandboxes;
  const builder = new AgentToolBuilder(deps, architectures, platform, brains, sandboxes, resources);
  const brain = brains.create(project, { label: 'Writer', provider: 'compatible', model: 'fixture', baseUrl: 'http://localhost:12345/v1' });
  const agent = { id: 'a', kind: 'agent' as const, name: 'Agent', description: 'Help.', x: 0, y: 0, runtime: { kind: 'api' as const, policy: 'chat-only' as const, connectionId: brain.id, maxOutputTokens: 512 } };
  const doc = architectures.create({ project, graph: { title: 'T', description: '', nodes: [agent], edges: [] } }).document;
  const revision = () => architectures.get(doc.id).document.revision;
  return { project, store, deps, architectures, brains, resources, runs, platform, builder, brain, doc, revision, close: async () => { platform.shutdown(); await runs.shutdown(); await sandboxes.shutdown(); store.close(); } };
}

const GOOD = { name: 'Word counter', functionName: 'count_words', description: 'Counts words in a text. Use it when the user asks how long a text is.', implementation: 'javascript', inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', description: 'Text to count.' } } }, code: 'return { words: input.text.trim().split(/\\s+/).filter(Boolean).length };', readOnly: true, sampleInput: { text: 'one two three' } };

describe('describe-to-generate tools', () => {
  it('writes a tool from a description, repairs a rejected draft, and test-runs it in the sandbox', async () => {
    const answers = [JSON.stringify({ ...GOOD, sampleInput: { wrong: 1 } }), '```json\n' + JSON.stringify(GOOD) + '\n```'];
    const model = vi.fn<typeof fetch>(async () => reply(answers.shift()!));
    const s = setup(model);
    try {
      const out = await s.builder.generate(s.project, { description: 'Count the words in a piece of text', connectionId: s.brain.id });
      expect(out.attempts).toBe(2); expect(out.draft).toMatchObject({ functionName: 'count_words', implementation: 'javascript', readOnly: true });
      expect(out.test).toEqual({ input: { text: 'one two three' }, output: { words: 3 } });
      expect(String(model.mock.calls[1][1]!.body)).toContain('sampleInput does not satisfy inputSchema');
    } finally { await s.close(); }
  });
  it('gives up with the last problem after three failed attempts and requires a model connection', async () => {
    const s = setup(vi.fn(async () => reply('I cannot do that.')));
    try {
      await expect(s.builder.generate(s.project, { description: 'Do something useful', connectionId: 'missing' })).rejects.toThrow(/Choose a model connection/);
      await expect(s.builder.generate(s.project, { description: 'Do something useful', connectionId: s.brain.id })).rejects.toThrow(/after 3 attempts\. Last problem: The reply was not a JSON object/);
    } finally { await s.close(); }
  });
  it('rejects generated code that throws on its own sample input', async () => {
    const broken = { ...GOOD, code: 'return input.missing.deep;' };
    const s = setup(vi.fn(async () => reply(JSON.stringify(broken))));
    try { await expect(s.builder.generate(s.project, { description: 'Count the words in text', connectionId: s.brain.id })).rejects.toThrow(/Evaluator code failed/); }
    finally { await s.close(); }
  });
});

describe('one-step add tool', () => {
  it('adds a described tool, turns on tool access for a chat-only agent, and the agent can call it', async () => {
    let call = 0;
    const model = vi.fn<typeof fetch>(async (_u, init) => { const body = JSON.parse(String(init!.body)); const tool = body.messages.find((m: any) => m.role === 'tool'); if (tool) return reply(`Done: ${tool.content}`); call++; return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `c${call}`, type: 'function', function: { name: 'count_words', arguments: '{"text":"a b c d"}' } }] } }] })); });
    const s = setup(model);
    try {
      const added = await s.builder.addTool(s.doc.id, 'a', { expectedRevision: 1, kind: 'custom', draft: GOOD });
      expect(added.enabledToolAccess).toBe(true); expect(added.message).toMatch(/now on/);
      const node = added.snapshot.document.nodes.find(n => n.id === 'a')!;
      expect(node.runtime!.policy).toBe('configured-tools'); expect(node.capabilities).toHaveLength(1);
      expect(s.platform.preview(s.doc.id, 'a', undefined).tools.map(t => t.name)).toEqual(['count_words']);
      const run = s.runs.start(s.doc.id, 'a', 'How many words?', s.revision()); await wait(() => s.runs.get(run.id).status === 'succeeded');
      expect(s.runs.get(run.id).output).toContain('"words":4');
      // A second tool with the same function name is renamed instead of colliding.
      const again = await s.builder.addTool(s.doc.id, 'a', { expectedRevision: s.revision(), kind: 'custom', draft: GOOD });
      expect(s.platform.capability(s.project, again.capability!.id).spec).toMatchObject({ config: { functionName: 'count_words_2' } });
      await expect(s.builder.addTool(s.doc.id, 'a', { expectedRevision: 1, kind: 'custom', draft: GOOD })).rejects.toThrow(/workflow changed/);
    } finally { await s.close(); }
  });
  it('turns code execution on per agent so draft runs get run_code, and removes it again', async () => {
    const s = setup(vi.fn(async () => reply('ok')));
    try {
      const added = await s.builder.addTool(s.doc.id, 'a', { expectedRevision: 1, kind: 'code_execution' });
      expect(added.snapshot.document.nodes[0].runtime).toMatchObject({ codeExecution: { backend: 'quickjs' }, policy: 'configured-tools' });
      const run = s.runs.start(s.doc.id, 'a', 'hi', s.revision()); await wait(() => s.runs.get(run.id).status === 'succeeded');
      expect(s.runs.toolManifest(run.id).map(t => t.name)).toEqual(['run_code']);
      const removed = s.builder.removeTool(s.doc.id, 'a', { expectedRevision: s.revision(), codeExecution: true });
      expect(removed.document.nodes[0].runtime!.codeExecution).toBeUndefined();
    } finally { await s.close(); }
  });
  it('adds web search with a pasted key in one step', async () => {
    const s = setup(vi.fn(async () => reply('ok')));
    try {
      await expect(s.builder.addTool(s.doc.id, 'a', { expectedRevision: 1, kind: 'web_search' })).rejects.toThrow(/Tavily API key/);
      const added = await s.builder.addTool(s.doc.id, 'a', { expectedRevision: 1, kind: 'web_search', apiKey: 'tvly-abcdefgh', maxResults: 3 });
      expect(added.capability!.spec).toMatchObject({ kind: 'tavily', functionName: 'web_search', maxResults: 3 });
      expect(s.platform.connections(s.project)).toMatchObject([{ kind: 'tavily', hasSecret: true }]);
      expect(JSON.stringify(added)).not.toContain('tvly-abcdefgh');
    } finally { await s.close(); }
  });
});

describe('friendly MCP setup', () => {
  it('previews a preset server before saving anything, then adds the ticked tools and reuses the connection next time', async () => {
    const mcp = fakeMcp(); const s = setup(vi.fn(async () => reply('ok')), mcp.send);
    try {
      expect(s.builder.catalog(s.project).mcpPresets.map(p => p.id)).toContain('context7');
      const probe = await s.builder.probeMcp(s.project, { presetId: 'context7' });
      expect(probe).toMatchObject({ server: 'context7', label: 'Context7' }); expect(probe.tools.map(t => t.name)).toEqual(['resolve-library-id', 'get-library-docs']);
      expect(s.platform.connections(s.project)).toEqual([]);
      const added = await s.builder.addTool(s.doc.id, 'a', { expectedRevision: 1, kind: 'mcp', presetId: 'context7', allow: ['resolve-library-id'] });
      expect(added.message).toBe('1 tool from Context7 added. Tool access was "Chat only", so it is now on.');
      expect(s.platform.preview(s.doc.id, 'a', undefined).tools.map(t => [t.name, t.approval])).toEqual([['context7__resolve_library_id', true]]);
      await s.builder.addTool(s.doc.id, 'a', { expectedRevision: s.revision(), kind: 'mcp', presetId: 'context7', allow: ['get-library-docs'], name: 'Docs' });
      expect(s.platform.connections(s.project).filter(c => c.kind === 'mcp')).toHaveLength(1);
      await expect(s.builder.addTool(s.doc.id, 'a', { expectedRevision: s.revision(), kind: 'mcp', presetId: 'context7', allow: [] })).rejects.toThrow(/Tick at least one tool/);
    } finally { await s.close(); }
  });
  it('explains missing tokens, and reuses a Library server with its Authorization header but not other headers', async () => {
    const mcp = fakeMcp('lib-token-123'); const s = setup(vi.fn(async () => reply('ok')), mcp.send);
    try {
      await expect(s.builder.probeMcp(s.project, { presetId: 'github' })).rejects.toThrow(/GitHub needs a token/);
      await expect(s.builder.probeMcp(s.project, { url: 'https://private.example.test/mcp' })).rejects.toThrow(/requires authentication\. Paste an access token/);
      s.builder.library = {
        remoteServers: () => [{ id: 'lib1', name: 'internal', label: 'Internal docs', url: 'https://internal.example.test/mcp', hasAuthorization: true, otherHeaders: [] }, { id: 'lib2', name: 'keyed', label: 'Keyed', url: 'https://keyed.example.test/mcp', hasAuthorization: false, otherHeaders: ['X-Api-Key'] }],
        remoteCredentials: id => id === 'lib1' ? { url: 'https://internal.example.test/mcp', name: 'internal', authorization: 'Bearer lib-token-123', otherHeaders: [] } : { url: 'https://keyed.example.test/mcp', name: 'keyed', otherHeaders: ['X-Api-Key'] },
      };
      expect(s.builder.catalog(s.project).libraryMcp).toEqual([expect.objectContaining({ id: 'lib1', hasAuthorization: true }), expect.objectContaining({ id: 'lib2', unsupportedHeaders: ['X-Api-Key'] })]);
      expect(JSON.stringify(s.builder.catalog(s.project))).not.toContain('lib-token-123');
      expect((await s.builder.probeMcp(s.project, { libraryId: 'lib1' })).server).toBe('internal');
      expect(mcp.seen.some(r => r.authorization === 'Bearer lib-token-123')).toBe(true);
      await expect(s.builder.probeMcp(s.project, { libraryId: 'lib2' })).rejects.toThrow(/authenticates with X-Api-Key/);
    } finally { await s.close(); }
  });
});
