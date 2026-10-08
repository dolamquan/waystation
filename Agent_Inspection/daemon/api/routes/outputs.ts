import type { IncomingMessage } from 'node:http';
import { UserError, type Tower } from '../../tower.ts';
import { OutputsPathError } from '../../outputs/pathSafety.ts';
import { agentFileDiff, agentOutputs, type OutputsDeps } from '../../outputs/service.ts';
import { r, type Route } from './route.ts';

/** Path and lookup problems are the caller's to fix: report them as 400s with their plain message. */
async function asUserErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof OutputsPathError) throw new UserError(error.message);
    throw error;
  }
}

const queryParam = (req: IncomingMessage, name: string): string | null =>
  new URL(req.url ?? '/', 'http://localhost').searchParams.get(name);

/** Read-only "what did this agent produce" routes behind the operator token, for every agent tier. */
export function outputRoutes(tower: Tower): Route[] {
  const deps: OutputsDeps = {
    agent: (agentId) => tower.registry.get(agentId),
    events: (agentId, limit) => {
      const stored = tower.store.eventsFor(agentId, limit);
      return stored.length > 0 ? stored : tower.events(agentId);
    },
  };
  return [
    r('GET', '/api/agents/:id/outputs', ({ params }) => asUserErrors(async () => ({ outputs: await agentOutputs(deps, params[0]) }))),
    r('GET', '/api/agents/:id/outputs/diff', ({ params, req }) =>
      asUserErrors(async () => ({ diff: await agentFileDiff(deps, params[0], queryParam(req, 'path')) }))),
  ];
}
