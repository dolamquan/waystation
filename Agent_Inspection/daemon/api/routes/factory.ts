import type { Tower } from '../../tower.ts';
import { bodyOf, headerOf, r, type Route } from './route.ts';
import { AGENT_TOKEN_HEADER } from './notify.ts';
import { WorkspaceError } from '../../teams/workspace.ts';
import { TeamAuthError } from '../../teams/teamManager.ts';
import { FactoryBridgeAuthError } from '../../factory/bridge.ts';
import { UserError } from '../../userError.ts';
async function perform<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { if (error instanceof WorkspaceError) throw new UserError(error.message); throw error; }
}
/** Bridge auth failures become 401s, matching the other agent bridges. */
function authorized<T>(operation: () => T): T {
  try { return operation(); } catch (error) { if (error instanceof FactoryBridgeAuthError) throw new TeamAuthError(error.message); throw error; }
}
export function factoryRoutes(tower: Tower): Route[] {
  return [
    r('GET', '/api/factory', () => tower.factory.snapshot()),
    r('POST', '/api/factory/definitions', ({ body }) => ({ factory: tower.factory.saveDefinition(body) })),
    r('POST', '/api/factory/definitions/:id', ({ params, body }) => ({ factory: tower.factory.saveDefinition(body, params[0]) })),
    r('POST', '/api/factory/items', ({ body }) => ({ item: tower.factory.createItem(body) })),
    r('POST', '/api/factory/items/:id/action', async ({ params, body }) => ({ item: await perform(() => tower.factory.action(params[0], String(bodyOf(body).action))) })),
    r('GET', '/api/factory/items/:id/diff', async ({ params }) => ({ diff: await perform(() => tower.factory.diff(params[0])) })),
  ];
}
/** Agent bridge routes under /agent/: each call carries a per-attempt token instead of the operator token. */
export function factoryAgentRoutes(tower: Tower): Route[] {
  return [
    r('POST', '/agent/factory/tools', ({ req }) => ({ tools: authorized(() => tower.factory.bridgeTools(headerOf(req, AGENT_TOKEN_HEADER))) })),
    r('POST', '/agent/factory/call', ({ req, body }) => authorized(() => tower.factory.bridgeCall(headerOf(req, AGENT_TOKEN_HEADER), bodyOf(body)))),
  ];
}
