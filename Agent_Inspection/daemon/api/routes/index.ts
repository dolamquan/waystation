import type { Tower } from '../../tower.ts';
import { docRoutes } from './docs.ts';
import { integrationRoutes } from './integrations.ts';
import { notifyAgentRoutes, notifyRoutes } from './notify.ts';
import { outputRoutes } from './outputs.ts';
import { previewRoutes } from './preview.ts';
import { commandRoutes } from './commands.ts';
import type { Route } from './route.ts';
import { scheduleRoutes } from './schedules.ts';
import { skillRoutes } from './skills.ts';
import { usageWindowRoutes } from './usageWindows.ts';
import { sessionRoutes } from './sessions.ts';
import { discoveryRoutes } from './discovery.ts';
import { providerRoutes } from './providers.ts';
import { channelAgentRoutes, channelRoutes } from './channels.ts';
import { consoleRoutes } from './consoles.ts';
import { agentConsoleRoutes } from './agentConsole.ts';
import { fileRoutes } from './files.ts';
import { factoryAgentRoutes, factoryRoutes } from './factory.ts';
import { canvasRoutes } from './canvas.ts';
import { worktreeRoutes } from './worktrees.ts';
import { architectureRoutes } from './architecture.ts';
import { agentPlatformRoutes, agentPlatformBridgeRoutes } from './agentPlatform.ts';
import { agentEvaluationRoutes } from './agentEvaluation.ts';
import { sketchRoutes } from './sketch.ts';
import { connectorRoutes, connectorBridgeRoutes } from './connectors.ts';

/** Operator routes (under /api/) contributed by the library features. */
export function libraryRoutes(tower: Tower): Route[] {
  return [
    ...connectorRoutes(tower),
    ...skillRoutes(tower), ...docRoutes(tower), ...integrationRoutes(tower), ...notifyRoutes(tower), ...scheduleRoutes(tower),
    ...usageWindowRoutes(tower), ...outputRoutes(tower), ...previewRoutes(tower), ...commandRoutes(tower), ...sessionRoutes(tower), ...discoveryRoutes(tower), ...providerRoutes(tower),
    ...channelRoutes(tower), ...consoleRoutes(tower), ...agentConsoleRoutes(tower), ...fileRoutes(), ...factoryRoutes(tower), ...canvasRoutes(tower), ...worktreeRoutes(tower), ...architectureRoutes(tower), ...agentPlatformRoutes(tower), ...agentEvaluationRoutes(tower), ...sketchRoutes(tower),
  ];
}

/** Agent bridge routes (under /agent/), each authenticating its own per-agent token. */
export function agentRoutes(tower: Tower): Route[] {
  return [...notifyAgentRoutes(tower), ...channelAgentRoutes(tower), ...factoryAgentRoutes(tower), ...agentPlatformBridgeRoutes(tower), ...connectorBridgeRoutes(tower)];
}
