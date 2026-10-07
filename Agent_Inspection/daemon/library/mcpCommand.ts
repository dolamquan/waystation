import { existsSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';
import { LibraryInputError } from './types.ts';

export interface CommandHost {
  readonly platform: NodeJS.Platform;
  readonly pathEnv: string;
  readonly exists: (path: string) => boolean;
}

export const defaultCommandHost = (): CommandHost => ({
  platform: process.platform,
  pathEnv: process.env.PATH ?? process.env.Path ?? '',
  exists: existsSync,
});

/** Windows resolves a bare command name through PATH in this order (default PATHEXT, most-used first). */
const WINDOWS_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];
/** cmd.exe would interpret these inside an argument, so they cannot pass through `cmd /c` safely. */
const CMD_METACHARS = /[&|<>^%"\r\n]/;

function windowsResolution(command: string, host: CommandHost): string | undefined {
  for (const dir of host.pathEnv.split(delimiter).filter(Boolean)) {
    const ext = WINDOWS_EXTENSIONS.find((candidate) => host.exists(join(dir, `${command}${candidate}`)));
    if (ext) return ext;
  }
  return undefined;
}

/**
 * `npx`, `uvx` and friends are .cmd shims on Windows, which neither Node nor Claude Code nor Codex can
 * start without a shell. A bare name that resolves to one runs as `cmd /c <name> ...args`.
 */
export function normalizeStdioCommand(
  command: string,
  args: readonly string[],
  host: CommandHost = defaultCommandHost(),
): { readonly command: string; readonly args: readonly string[] } {
  const bare = !/[\\/]/.test(command) && extname(command) === '';
  if (host.platform !== 'win32' || !bare) return { command, args };
  const ext = windowsResolution(command, host);
  if (ext !== '.cmd' && ext !== '.bat') return { command, args };
  if (args.some((arg) => CMD_METACHARS.test(arg))) {
    throw new LibraryInputError(`"${command}" runs through cmd.exe on Windows, so its arguments cannot contain & | < > ^ % or quotes.`);
  }
  return { command: 'cmd', args: ['/c', command, ...args] };
}
