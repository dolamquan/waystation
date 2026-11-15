import type { Tower } from '../../tower.ts';
import { r, type Route } from './route.ts';

/**
 * Opens an agent's session as a console on the board: what `POST /api/agents/:id/cli` does, but the real CLI
 * runs in an in-app pseudo-terminal instead of an external terminal tab. Nothing in the request chooses the command.
 */
export function agentConsoleRoutes(tower: Tower): Route[] {
  return [
    r('POST', '/api/agents/:id/console', async ({ params }) => {
      const result = await tower.openCliInConsole(params[0]);
      tower.store.audit('console_open_agent', params[0], { consoleId: result.consoleId });
      return { ok: true, message: result.message, consoleId: result.consoleId };
    }),
  ];
}
