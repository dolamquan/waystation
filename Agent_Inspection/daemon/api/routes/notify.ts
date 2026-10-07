import { TeamAuthError } from '../../teams/teamManager.ts';
import type { Tower } from '../../tower.ts';
import { headerOf, r, type Route } from './route.ts';

export const AGENT_TOKEN_HEADER = 'x-agent-token';

/** Operator routes under /api/ (operator token already checked). */
export function notifyRoutes(tower: Tower): Route[] {
  const notifier = tower.library.notifier;
  return [
    r('GET', '/api/library/notify', () => ({ channels: notifier.listChannels() })),
    r('POST', '/api/library/notify', ({ body }) => ({ ok: true, channel: notifier.createChannel(body) })),
    r('POST', '/api/library/notify/:id', ({ params, body }) => ({ ok: true, channel: notifier.updateChannel(params[0], body) })),
    r('POST', '/api/library/notify/:id/delete', ({ params, body }) => {
      notifier.deleteChannel(params[0], body);
      return { ok: true };
    }),
    r('POST', '/api/library/notify/:id/test', async ({ params }) => ({ result: await notifier.test(params[0]) })),
    r('GET', '/api/notifications', ({ req }) => notifier.notifications(new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit') ?? undefined)),
    r('POST', '/api/notifications/read', ({ body }) => ({ ok: true, changed: notifier.markRead(body) })),
    r('POST', '/api/notifications/send', async ({ body }) => ({ results: await notifier.sendManual(body) })),
  ];
}

/**
 * Agent-facing routes under /agent/ for the notify MCP bridge. The operator token is NOT checked
 * for these: each handler authenticates the caller's own per-agent token (`x-agent-token`).
 * A missing or unknown token answers 401 (TeamAuthError is what the server maps to 401).
 */
export function notifyAgentRoutes(tower: Tower): Route[] {
  const notifier = tower.library.notifier;
  return [
    r('POST', '/agent/notify', async ({ req, body }) => {
      const grant = notifier.authenticate(headerOf(req, AGENT_TOKEN_HEADER));
      if (!grant) throw new TeamAuthError('missing or invalid agent token');
      const results = await notifier.postFromAgent(grant, body, tower.registry.get(grant.agentId)?.name);
      return { ok: true, results };
    }),
  ];
}
