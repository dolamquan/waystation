import type { Agent } from '../../api.ts';
import type { CommandResult } from '../../../../shared/claudeCommands.ts';
import { availableCommands, commandQuery, matchCommands, type ComposerCommand } from '../../composer/commands.ts';

/**
 * Slash commands for the small input under a board tile. It uses the same catalogue and routing as the agent drawer,
 * so an observed session gets the same /usage, /context, /model… as one launched here, and /compact runs wherever
 * Waystation can reach the session's real input. Controls that need a confirmation or a waiting tool call stay in Details.
 */
const DRAWER_ONLY: ReadonlySet<string> = new Set(['stop', 'cli', 'approve', 'deny', 'ask', 'intercept']);

export function tileCommands(agent: Agent): readonly ComposerCommand[] {
  return availableCommands({ agent, hasPending: false, canIntercept: false, canOpenCli: false })
    .filter((command) => !(command.kind === 'waystation' && DRAWER_ONLY.has(command.name)));
}

/** Tab completion: "/usa" becomes "/usage ". Anything that is not a partial command is returned unchanged. */
export function completeCommand(text: string, commands: readonly ComposerCommand[]): string {
  const query = commandQuery(text);
  if (query === undefined) return text;
  const [first] = matchCommands(query, commands);
  return first ? `/${first.name} ` : text;
}

/** A native command's answer, flattened into lines the terminal-style feed can print. */
export function resultLines(command: string, result: CommandResult): readonly string[] {
  const rows = result.sections.flatMap((section) => [
    ...(section.heading ? [section.heading] : []),
    ...section.rows.map((row) => `  ${row.label}${row.value ? `: ${row.value}` : ''}${row.detail ? ` (${row.detail})` : ''}`),
  ]);
  return [`${command} · ${result.title}`, ...rows, ...(result.note ? [result.note] : [])];
}
