import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Port and access token of the running tower, from the per-user daemon.json (as `npm run open` reads it). */
export interface DaemonInfo {
  readonly port: number;
  readonly token: string;
}

export function readDaemonInfo(home: string): DaemonInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { port?: unknown; token?: unknown };
    return typeof info.port === 'number' && typeof info.token === 'string' ? { port: info.port, token: info.token } : undefined;
  } catch {
    return undefined;
  }
}

/** Value of `--name <value>` in argv, if present. */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
