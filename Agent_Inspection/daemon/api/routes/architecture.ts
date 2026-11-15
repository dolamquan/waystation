import type { Tower } from '../../tower.ts';
import { randomUUID } from 'node:crypto';
import { LibraryInputError } from '../../library/types.ts';
import { architectureInstructions } from '../../architecture/store.ts';
import { bodyOf, r, type Route } from './route.ts';

export function architectureRoutes(tower: Tower): Route[] {
  const store = tower.library.automation.architectures;
  const testing = new Set<string>();
  const testAgents = new Map<string, string>();
  tower.library.agentRuns.bind({ launch: input => tower.launch(input, { agentId: input.agentId, mcpServers: input.mcpServers, env: input.env }),
    prepareResources: (input, id) => tower.library.automation.attachResources(input, id), agent: id => tower.registry.get(id), events: id => tower.events(id), stop: id => tower.stopAgent(id) });
  return [
    r('GET', '/api/agent-runs', () => ({ runs: tower.library.agentRuns.list() })),
    r('GET', '/api/agent-runs/:id', ({ params }) => ({ run: tower.library.agentRuns.get(params[0]) })),
    r('POST', '/api/agent-runs/:id/cancel', async ({ params }) => ({ run: await tower.library.agentRuns.cancel(params[0]) })),
    r('POST', '/api/agent-runs/:id/retry', ({ params }) => ({ run: tower.library.agentRuns.retry(params[0]) })),
    r('POST', '/api/agent-runs/:id/decision', ({ params, body }) => { const b = bodyOf(body); return { run: tower.library.agentRuns.decide(params[0], b.pendingId, b.allow) }; }),
    r('POST', '/api/architectures/:id/nodes/:node/run', ({ params, body }) => { const b = bodyOf(body); return { run: tower.library.agentRuns.start(params[0], params[1], b.text, b.expectedRevision) }; }),
    r('POST', '/api/architectures/:id/nodes/:node/resource', ({ params, body }) => tower.library.resources.save(store, params[0], bodyOf(body).expectedRevision, params[1], bodyOf(body))),
    r('GET', '/api/architectures/:id/nodes/:node/resource', ({ params }) => { const doc = store.get(params[0]).document; const node = doc.nodes.find(n => n.id === params[1]); if (!node) throw new LibraryInputError('Resource not found.'); return { credentials: tower.library.resources.credentialStatus(doc.project, node) }; }),
    r('POST', '/api/architectures/:id/nodes/:node/resource/test', async ({ params, body }) => {
      const doc = store.get(params[0]).document; const b = bodyOf(body); if (b.expectedRevision !== doc.revision) throw new LibraryInputError('Resource changed. Refresh before testing.');
      const node = doc.nodes.find(n => n.id === params[1]); if (!node) throw new LibraryInputError('Resource not found.');
      try { return { result: await tower.library.resources.test({ document: doc, agentNodeId: 'resource-test', runId: randomUUID() }, node, b.input, b.initialize === true) }; }
      catch (e) { throw new LibraryInputError(e instanceof LibraryInputError ? e.message : 'Resource test failed. Check its configuration and test input.'); }
    }),
    r('GET', '/api/architectures/:id/connections', ({ params }) => ({ connections: tower.library.brains.list(store.get(params[0]).document.project) })),
    r('POST', '/api/architectures/:id/connections', ({ params, body }) => ({ connection: tower.library.brains.create(store.get(params[0]).document.project, bodyOf(body)) })),
    r('POST', '/api/architectures/:id/connections/:connection/key', ({ params, body }) => ({ connection: tower.library.brains.replaceKey(params[1], store.get(params[0]).document.project, bodyOf(body).apiKey) })),
    r('POST', '/api/architectures/:id/nodes/:node/test', async ({ params, body, res }) => {
      const doc = store.get(params[0]).document; const node = doc.nodes.find(n => n.id === params[1]); const b = bodyOf(body);
      if (!node || node.kind !== 'agent') throw new LibraryInputError('Select an agent to test.');
      if (!node.runtime) throw new LibraryInputError('Save the agent runtime before testing.');
      if (!node.description.trim()) throw new LibraryInputError('Give this agent role instructions before testing.');
      if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 12000) throw new LibraryInputError('Enter a test message between 1 and 12000 characters.');
      if (b.expectedRevision !== doc.revision) throw new LibraryInputError('The design changed. Review the latest agent settings, then test again.');
      const testId = `${doc.id}:${node.id}`;
      if (testing.has(testId)) throw new LibraryInputError('This agent already has a test in progress.');
      const role = `You are ${node.name}, a multipurpose agent configured by the operator. Follow the role below. Answer the supplied task without assuming it is a coding task.\n\n${node.description}`;
      if (node.runtime.kind === 'managed') {
        const previousId = testAgents.get(testId); const previous = previousId ? tower.registry.get(previousId) : undefined;
        if (previous && !['idle', 'stopped'].includes(previous.status)) throw new LibraryInputError('This agent already has a test running. Open its session to review or interrupt it.');
        if (!['claude', 'copilot'].includes(node.provider ?? 'claude')) throw new LibraryInputError('Restrained runtime tests currently support Claude and Copilot. Choose one, or configure an API brain.');
        const agent = tower.launch({ vendor: node.provider || 'claude', model: node.model || undefined, cwd: doc.project, name: node.name,
          prompt: b.text.trim(), appendSystemPrompt: role, toolPolicy: node.runtime.policy, intercept: node.runtime.policy === 'review-tools' });
        testAgents.set(testId, agent.id);
        return { kind: 'managed', agentId: agent.id };
      }
      testing.add(testId); const abort = new AbortController(); const closed = () => { if (!res.writableEnded) abort.abort(); }; res.on('close', closed);
      try { return await tower.library.brains.run(node.runtime.connectionId, doc.project, role, b.text.trim(), { model: node.model, maxOutputTokens: node.runtime.maxOutputTokens, signal: abort.signal }); }
      finally { testing.delete(testId); res.off('close', closed); }
    }),
    r('GET', '/api/architectures', () => ({ documents: store.list() })),
    r('POST', '/api/architectures', ({ body }) => store.create(bodyOf(body))),
    r('GET', '/api/architectures/:id', ({ params }) => {
      const snapshot = store.get(params[0]);
      const agent = snapshot.agentId ? tower.registry.get(snapshot.agentId) : undefined;
      return { ...snapshot, agent, events: snapshot.agentId ? tower.events(snapshot.agentId).filter(e => ['prompt', 'assistant', 'error'].includes(e.kind)).map(e => e.kind === 'prompt' ? { ...e, summary: e.summary.replace(/^Current workflow:[\s\S]*?\n\n/, '') } : e) : [] };
    }),
    r('POST', '/api/architectures/:id', ({ params, body }) => { const b = bodyOf(body); return store.update(params[0], b.expectedRevision, b.operations); }),
    r('POST', '/api/architectures/:id/history', ({ params, body }) => {
      const b = bodyOf(body);
      if (b.direction !== 'undo' && b.direction !== 'redo') throw new LibraryInputError('Choose undo or redo.');
      return store.history(params[0], b.expectedRevision, b.direction);
    }),
    r('POST', '/api/architectures/:id/chat', async ({ params, body }) => {
      const b = bodyOf(body); const snapshot = store.get(params[0]);
      if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 12000) throw new LibraryInputError('Send a message between 1 and 12000 characters.');
      const prompt = `Current workflow: ${snapshot.document.id}. Read its latest graph with get_architecture before responding.\n${typeof b.selection === 'string' ? `Selected element id (design context): ${b.selection.slice(0, 100)}\n` : ''}\n${b.text.trim()}`;
      const existing = snapshot.agentId ? tower.registry.get(snapshot.agentId) : undefined;
      if (existing && existing.status !== 'stopped') {
        await tower.instruct(existing.id, prompt);
        return { agentId: existing.id };
      }
      const agent = tower.launch({ vendor: b.vendor, model: b.model, cwd: snapshot.document.project, name: 'Workflow architect', prompt,
        appendSystemPrompt: architectureInstructions(snapshot.document.id), intercept: false });
      store.attach(params[0], agent.id);
      return { agentId: agent.id };
    }),
  ];
}
