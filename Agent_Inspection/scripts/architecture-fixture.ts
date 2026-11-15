/** Isolated browser fixture. The architect is simulated; all graph HTTP/MCP/storage paths are real. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

process.env.AGENT_TOWER_HOME = mkdtempSync(join(tmpdir(), 'architecture-browser-'));
process.env.CLAUDE_HOME = join(process.env.AGENT_TOWER_HOME, 'claude');
const { Tower } = await import('../daemon/tower.ts');
const { startServer } = await import('../daemon/api/server.ts');
const tower = new Tower(':memory:');
const port = Number(process.env.ARCHITECTURE_VERIFY_PORT ?? 47360);
const token = 'a0c417ec70e0123456789abcdef0123456789abcdef';
const fixtureProject = mkdtempSync(join(tmpdir(), 'architecture-browser-project-'));
let sequence = 0;
tower.launch = raw => {
  const input = raw as { appendSystemPrompt: string; prompt: string; cwd: string; vendor: string };
  const id = /workflow id is ([a-z0-9-]+)/.exec(input.appendSystemPrompt)![1];
  const agent = { id: `managed:fixture-${++sequence}`, vendor: input.vendor, tier: 'A' as const, status: 'busy' as const, name: 'Workflow architect', cwd: input.cwd, project: 'Browser verification', source: 'architecture-fixture', canInstruct: true };
  tower.registry.upsert('architecture-fixture', agent);
  tower.registry.pushEvent({ agentId: agent.id, ts: Date.now(), kind: 'prompt', summary: input.prompt });
  setTimeout(async () => {
    try {
      const automation = tower.library.automation; const host = { agents: () => tower.registry.list(), consoles: () => [] };
      const grant = { agentId: agent.id, cwd: input.cwd };
      const latest = await automation.call('get_architecture', { id }, grant, host) as import('../shared/architecture.ts').ArchitectureSnapshot;
      const edge = latest.document.edges.find(e => e.target === 'response')!;
      await automation.call('update_architecture', { id, expectedRevision: latest.document.revision, operations: [
        { type: 'remove_edge', id: edge.id },
        { type: 'put_node', node: { id: 'human-approval', kind: 'approval', name: 'Human approval', description: 'A person reviews the response before delivery.', x: 820, y: 400 } },
        { type: 'put_edge', edge: { id: 'review-gate', source: edge.source, target: 'human-approval', label: 'Review' } },
        { type: 'put_edge', edge: { id: 'approved-result', source: 'human-approval', target: 'response', label: 'Approved' } },
      ] }, grant, host);
      tower.registry.pushEvent({ agentId: agent.id, ts: Date.now(), kind: 'assistant', summary: `Added human approval before the final response. I read ${latest.document.nodes.find(n => n.id === 'builder')?.name} from your current graph. This response is simulated for browser verification.` });
    } catch (e) { tower.registry.pushEvent({ agentId: agent.id, ts: Date.now(), kind: 'error', summary: (e as Error).message }); }
    tower.registry.upsert('architecture-fixture', { ...agent, status: 'idle' });
  }, 300);
  return agent;
};
const server = await startServer({ tower, host: '127.0.0.1', port, token, webDist: resolve('web/dist') });
const modelServer = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body || '{}');
  if (req.url === '/resource-tool') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ echo: input })); return; }
  if (req.url === '/webhook') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"delivered":true}'); return; }
  if (req.url === '/search') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ results: [{ title: 'Agent architecture reference', url: 'https://example.com/agent-reference', content: 'Agents need a harness, capabilities, state and observability.' }], request_id: 'local-fixture-search' })); return; }
  const task = input.messages?.filter((m: any) => m.role === 'user').at(-1)?.content ?? '';
  const system = input.messages?.find((m: any) => m.role === 'system')?.content ?? '';
  if (String(system).includes('You evaluate agent outputs')) { const sample = JSON.parse(task); const score = String(sample.output).includes(String(sample.reference)) ? 1 : 0; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ score, comment: 'Local simulated judge' }) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } })); return; }
  if (String(system).includes('FIXTURE_INCORRECT')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'Unknown.' } }], usage: { prompt_tokens: 20, completion_tokens: 5 } })); return; }
  const sandboxTool = input.tools?.find((t: any) => t.function?.name === 'execute_sandbox');
  if (sandboxTool && String(task).startsWith('Calculate')) { const result = input.messages?.find((m: any) => m.role === 'tool'); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result ? { choices: [{ message: { content: result.content } }], usage: { prompt_tokens: 20, completion_tokens: 10 } } : { choices: [{ message: { tool_calls: [{ id: 'sandbox-call', function: { name: 'execute_sandbox', arguments: JSON.stringify({ code: 'return { answer: input.n + 1 };', input: { n: 4 } }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })); return; }

  if (task === 'fail') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"simulated provider error"}'); return; }
  if (task === 'slow') await new Promise(resolve => setTimeout(resolve, 4000));
  if (res.destroyed) return;
  res.writeHead(200, { 'content-type': 'application/json' });
  const result = input.messages?.find((m: any) => m.role === 'tool');
  const tavily = input.tools?.find((t: any) => t.function?.name === 'tavily_search');
  if (tavily && String(task).includes('Which city')) { res.end(JSON.stringify({ choices: [{ message: { content: input.messages.some((m: any) => String(m.content).includes('Oslo')) ? 'You told me your city is Oslo.' : 'No city in this conversation.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 65, completion_tokens: 12 } })); return; }
  if (tavily) { res.end(JSON.stringify(result ? { choices: [{ message: { content: 'Research complete: agents need a harness, capabilities, state and observability. Source: https://example.com/agent-reference. Your city is Oslo.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 65, completion_tokens: 25 } } : { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'search-call', type: 'function', function: { name: 'tavily_search', arguments: JSON.stringify({ query: 'agent architecture' }) } }] } }], usage: { prompt_tokens: 30, completion_tokens: 10 } })); return; }
  const tool = input.tools?.find((t: any) => t.function?.name === 'increment');
  res.end(JSON.stringify(tool && !result ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'increment-call', type: 'function', function: { name: 'increment', arguments: '{"n":2}' } }] } }], usage: { prompt_tokens: 30, completion_tokens: 10 } }
    : { choices: [{ message: { content: result ? result.content : `Simulated multipurpose API response to: ${input.messages.at(-1).content}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 45, completion_tokens: 20 } }));
});
await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
const modelPort = (modelServer.address() as { port: number }).port;
console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}`, token, project: fixtureProject, modelUrl: `http://127.0.0.1:${modelPort}/v1` }));
process.on('SIGTERM', () => { server.close(); modelServer.close(); void tower.shutdown().finally(() => process.exit(0)); });
