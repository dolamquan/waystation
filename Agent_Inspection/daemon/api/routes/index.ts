import type { Tower } from '../../tower.ts';
import { docRoutes } from './docs.ts';
import { integrationRoutes } from './integrations.ts';
import { notifyAgentRoutes, notifyRoutes } from './notify.ts';
import { outputRoutes } from './outputs.ts';
import { commandRoutes } from './commands.ts';
import type { Route } from './route.ts';
import { scheduleRoutes } from './schedules.ts';
import { skillRoutes } from './skills.ts';
import { usageWindowRoutes } from './usageWindows.ts';

/** Operator routes (under /api/) contributed by the library features. */
export function libraryRoutes(tower: Tower): Route[] {
  return [
    ...skillRoutes(tower), ...docRoutes(tower), ...integrationRoutes(tower), ...notifyRoutes(tower), ...scheduleRoutes(tower),
    ...usageWindowRoutes(tower), ...outputRoutes(tower), ...commandRoutes(tower),
  ];
}

/** Agent bridge routes (under /agent/), each authenticating its own per-agent token. */
export function agentRoutes(tower: Tower): Route[] {
  return [...notifyAgentRoutes(tower)];
}
