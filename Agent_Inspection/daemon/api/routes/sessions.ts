import type { Tower } from '../../tower.ts';
import { r, type Route } from './route.ts';

export function sessionRoutes(tower: Tower): Route[] {
  const bodyOf = (body: unknown) => (body ?? {}) as Record<string, unknown>;
  return [
    r('GET', '/api/sessions', ({ req }) => {
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
      return { sessions: tower.history.list(tower.registry.list(), query.get('q') ?? '', query.get('project') ?? '', query.get('state') ?? '') };
    }),
    r('POST', '/api/sessions/:id/resume', async ({ params }) => ({ ok: true, agent: await tower.resumeSession(params[0]) })),
    r('GET', '/api/agents/:id/queue', ({ params }) => ({ messages: tower.messageQueue.list(params[0]) })),
    r('POST', '/api/agents/:id/queue/:message/:action', async ({ params, body }) => {
      await tower.changeQueuedMessage(params[0], params[1], params[2], bodyOf(body));
      return { ok: true, messages: tower.messageQueue.list(params[0]) };
    }),
  ];
}
