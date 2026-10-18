import { UserError, type Tower } from '../../tower.ts';
import { bodyOf, r, type Route } from './route.ts';

/** Sends a context doc to a running agent: it is told to read the file before continuing. */
export async function sendDocToAgent(tower: Tower, agentId: string, rawDocId: unknown): Promise<void> {
  const agent = tower.registry.get(agentId);
  if (!agent) throw new UserError('Unknown agent.');
  if (!agent.canInstruct) throw new UserError('This agent cannot receive instructions, so it cannot be sent a doc.');
  if (typeof rawDocId !== 'string' || !rawDocId) throw new UserError('docId is required.');
  const { doc, text } = tower.library.docs.readingInstruction(rawDocId);
  await tower.instruct(agentId, text);
  tower.registry.pushEvent({ agentId, ts: Date.now(), kind: 'system', summary: `Context doc sent: ${doc.title}` });
  tower.store.audit('doc_send', agentId, { docId: doc.id, title: doc.title });
}

export function docRoutes(tower: Tower): Route[] {
  const docs = tower.library.docs;
  return [
    r('GET', '/api/library/docs', () => ({ docs: docs.list() })),
    r('GET', '/api/library/docs/:id', ({ params }) => ({ doc: docs.get(params[0]) })),
    r('POST', '/api/library/docs', ({ body }) => ({ ok: true, doc: docs.create(body) })),
    r('POST', '/api/library/docs/:id/delete', ({ params, body }) => {
      if (bodyOf(body).confirm !== true) throw new UserError('Deleting a doc requires confirm: true.');
      docs.remove(params[0]);
      return { ok: true };
    }),
    r('POST', '/api/library/docs/:id', ({ params, body }) => ({ ok: true, doc: docs.update(params[0], body) })),
    r('POST', '/api/agents/:id/docs', async ({ params, body }) => {
      await sendDocToAgent(tower, params[0], bodyOf(body).docId);
      return { ok: true };
    }),
  ];
}
