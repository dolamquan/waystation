import { homedir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../../config.ts';
import { UserError, type Tower } from '../../tower.ts';
import { runAgentCommand, type CommandDeps } from '../../commands/agentCommands.ts';
import { CommandError } from '../../commands/types.ts';
import { bodyOf, r, type Route } from './route.ts';

/** Claude Code's ~/.claude.json (moves with CLAUDE_CONFIG_DIR). */
const claudeUserConfig = (): string => join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');

/** The composer's Claude Code commands (/usage, /mcp, /model…), answered or carried out by Waystation. */
export function commandRoutes(tower: Tower): Route[] {
  const deps: CommandDeps = {
    agent: (id) => tower.registry.get(id),
    control: (id) => tower.claudeControl(id),
    usageWindows: () => tower.usageWindows.report(),
    restartWithModel: (id, model) => tower.ops.restartAgent(id, { model }),
    claudeHome: paths.claudeHome,
    userConfigFile: claudeUserConfig(),
    audit: (action, target, detail) => tower.store.audit(action, target, detail),
  };
  return [
    r('POST', '/api/agents/:id/command', async ({ params, body }) => {
      const { name, arg } = bodyOf(body);
      try {
        return { result: await runAgentCommand(deps, params[0], name, arg) };
      } catch (error) {
        if (error instanceof CommandError) throw new UserError(error.message);
        // SDK control requests fail when the agent is mid-shutdown or the CLI is too old for the request.
        throw new UserError(`The agent couldn’t answer that: ${(error as Error).message}`);
      }
    }),
  ];
}
