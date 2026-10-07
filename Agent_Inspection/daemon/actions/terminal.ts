import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type TerminalKind = 'agent' | 'team';

export interface TerminalTarget {
  readonly kind: TerminalKind;
  readonly id: string;
  readonly title: string;
}

export interface TerminalPaths {
  readonly projectRoot: string;
  readonly nodePath: string;
  readonly towerHome: string;
  readonly script: string;
}

export class TerminalError extends Error {}

export const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const ATTACH_SCRIPT = join(PROJECT_ROOT, 'daemon', 'cli', 'attach.ts');
export const LAUNCH_SCRIPT = join(PROJECT_ROOT, 'daemon', 'cli', 'launchCli.ts');
const TICKET_ID = /^[0-9a-f]{32}$/;

/** Agent ids (`claude:<uuid>`, `managed:<uuid>`, …) and team ids never need more than this. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
/** Windows Terminal splits its command line on `;` even inside quotes. */
const UNSAFE_PATH = /[;"\u0000-\u001f]/;
const MAX_TITLE_CHARS = 60;
const DEFAULT_TITLE = 'Waystation';

export function manualAttachCommand(kind: TerminalKind, id: string): string {
  return `npm run attach -- ${kind} ${id}`;
}

export function terminalTitle(text: string): string {
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[^\p{L}\p{N} ._·-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS)
    .trim();
  return cleaned || DEFAULT_TITLE;
}

/** Arguments for `wt.exe`: a new tab in the latest window, running the attach console in the project folder. */
export function windowsTerminalArgs(target: TerminalTarget, paths: TerminalPaths): string[] {
  if (!SAFE_ID.test(target.id)) throw new TerminalError('That id cannot be opened in a terminal.');
  return tabArgs(target.title, paths, [target.kind, target.id]);
}

/** A new tab running the launcher, which starts the real CLI described by a one-time ticket. */
export function launcherTerminalArgs(ticketId: string, title: string, paths: TerminalPaths): string[] {
  if (!TICKET_ID.test(ticketId)) throw new TerminalError('That ticket cannot be opened in a terminal.');
  return tabArgs(title, paths, [ticketId]);
}

function tabArgs(title: string, paths: TerminalPaths, scriptArgs: readonly string[]): string[] {
  const unsafe = Object.values(paths).find((path) => UNSAFE_PATH.test(path));
  if (unsafe) throw new TerminalError(`The path ${unsafe} contains characters Windows Terminal cannot pass on.`);
  return [
    '-w', '0', 'new-tab', '--title', terminalTitle(title), '-d', paths.projectRoot,
    paths.nodePath, '--import', 'tsx', paths.script, ...scriptArgs, '--home', paths.towerHome,
  ];
}

type SpawnFn = typeof spawn;

/** Start Windows Terminal without a shell and without waiting for the tab to close. */
export function launchTerminal(args: readonly string[], spawnFn: SpawnFn = spawn): Promise<void> {
  return new Promise((resolveLaunch, reject) => {
    const child = spawnFn('wt.exe', [...args], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolveLaunch();
    });
  });
}

const defaultPaths = (towerHome: string, script: string): TerminalPaths =>
  ({ projectRoot: PROJECT_ROOT, nodePath: process.execPath, towerHome: resolve(towerHome), script });

function windowsOnly(): Promise<never> | undefined {
  return process.platform === 'win32'
    ? undefined
    : Promise.reject(new TerminalError('Opening a terminal automatically is only supported on Windows.'));
}

/** The tower's default console launcher. The console reads the access token from daemon.json, never from argv. */
export function openAttachTerminal(target: TerminalTarget, towerHome: string): Promise<void> {
  return windowsOnly() ?? launchTerminal(windowsTerminalArgs(target, defaultPaths(towerHome, ATTACH_SCRIPT)));
}

/** Opens the real Claude Code / Codex CLI for a ticket. Secrets travel in the ticket file, never in argv. */
export function openLauncherTerminal(ticketId: string, title: string, towerHome: string): Promise<void> {
  return windowsOnly() ?? launchTerminal(launcherTerminalArgs(ticketId, title, defaultPaths(towerHome, LAUNCH_SCRIPT)));
}
