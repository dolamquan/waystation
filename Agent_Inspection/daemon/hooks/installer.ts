import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_FILES = ['claude-hook.mjs', 'hookLogic.mjs'] as const;
const TOWER_MARKER = 'agent-tower';
const PRE_TOOL_USE_TIMEOUT_S = 600;
const OTHER_TIMEOUT_S = 15;

/** Events the tower listens to, and whether each takes a tool matcher. */
export const TOWER_HOOK_EVENTS: ReadonlyArray<{ event: string; matcher: boolean }> = [
  { event: 'PreToolUse', matcher: true },
  { event: 'PostToolUse', matcher: true },
  { event: 'UserPromptSubmit', matcher: false },
  { event: 'Stop', matcher: false },
  { event: 'SessionStart', matcher: false },
  { event: 'SessionEnd', matcher: false },
];

type HookCommand = { type: string; command?: string; timeout?: number };
type HookGroup = { matcher?: string; hooks?: HookCommand[] };
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

const isTowerCommand = (hook: HookCommand): boolean =>
  typeof hook.command === 'string' && hook.command.includes(TOWER_MARKER) && hook.command.includes('claude-hook.mjs');

/** Remove tower hook entries, leaving everything else (including other hooks in shared groups) intact. */
export function stripTowerHooks(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  const hooks = Object.fromEntries(
    Object.entries(settings.hooks)
      .map(([event, groups]) => [
        event,
        groups
          .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isTowerCommand(hook)) }))
          .filter((group) => group.hooks.length > 0),
      ] as const)
      .filter(([, groups]) => groups.length > 0),
  );
  const { hooks: _dropped, ...rest } = settings;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

/** Idempotently add tower hooks (strip first, then append). */
export function mergeTowerHooks(settings: Settings, command: string): Settings {
  const base = stripTowerHooks(settings);
  const hooks = { ...(base.hooks ?? {}) };
  for (const { event, matcher } of TOWER_HOOK_EVENTS) {
    const timeout = event === 'PreToolUse' ? PRE_TOOL_USE_TIMEOUT_S : OTHER_TIMEOUT_S;
    const group: HookGroup = {
      ...(matcher ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command, timeout }],
    };
    hooks[event] = [...(hooks[event] ?? []), group];
  }
  return { ...base, hooks };
}

export function hasTowerHooks(settings: Settings): boolean {
  return Object.values(settings.hooks ?? {}).some((groups) =>
    groups.some((group) => (group.hooks ?? []).some(isTowerCommand)));
}

export interface InstallerPaths {
  readonly settingsFile: string;
  readonly installDir: string;
  readonly backupsDir: string;
}

function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed as Settings;
}

function writeSettingsAtomic(file: string, settings: Settings): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.agent-tower.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, file);
}

function backup(file: string, backupsDir: string): string | undefined {
  if (!existsSync(file)) return undefined;
  mkdirSync(backupsDir, { recursive: true });
  const target = join(backupsDir, `settings.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  copyFileSync(file, target);
  return target;
}

export function hookCommand(installDir: string): string {
  return `node "${join(installDir, 'claude-hook.mjs').replace(/\\/g, '/')}"`;
}

export function installHooks(p: InstallerPaths): { backup?: string; command: string } {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  mkdirSync(p.installDir, { recursive: true });
  for (const name of HOOK_FILES) copyFileSync(join(sourceDir, name), join(p.installDir, name));
  const command = hookCommand(p.installDir);
  if (!command.includes(TOWER_MARKER)) throw new Error('install dir must live under an agent-tower folder');
  const current = readSettings(p.settingsFile);
  const backupFile = backup(p.settingsFile, p.backupsDir);
  writeSettingsAtomic(p.settingsFile, mergeTowerHooks(current, command));
  return { backup: backupFile, command };
}

export function uninstallHooks(p: InstallerPaths): { backup?: string } {
  const current = readSettings(p.settingsFile);
  if (!hasTowerHooks(current)) return {};
  const backupFile = backup(p.settingsFile, p.backupsDir);
  writeSettingsAtomic(p.settingsFile, stripTowerHooks(current));
  return { backup: backupFile };
}

export function hooksInstalled(settingsFile: string): boolean {
  try {
    return hasTowerHooks(readSettings(settingsFile));
  } catch {
    return false;
  }
}
