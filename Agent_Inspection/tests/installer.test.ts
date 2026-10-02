import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TOWER_HOOK_EVENTS, hasTowerHooks, hookCommand, hooksInstalled, installHooks, mergeTowerHooks, stripTowerHooks, uninstallHooks,
} from '../daemon/hooks/installer.ts';
import { tempDir } from './helpers.ts';

const CMD = 'node "C:/Users/me/AppData/Local/agent-tower/hooks/claude-hook.mjs"';
const OTHER = { type: 'command', command: 'node other-hook.js' };

describe('settings merge', () => {
  it('adds every event, PreToolUse with a long timeout, and is idempotent', () => {
    const once = mergeTowerHooks({}, CMD);
    const twice = mergeTowerHooks(once, CMD);
    expect(twice).toEqual(once);
    expect(Object.keys(once.hooks ?? {})).toEqual(TOWER_HOOK_EVENTS.map((e) => e.event));
    expect(once.hooks?.PreToolUse?.[0]).toEqual({ matcher: '*', hooks: [{ type: 'command', command: CMD, timeout: 600 }] });
    expect(once.hooks?.Stop?.[0].matcher).toBeUndefined();
  });

  it('preserves unrelated settings and other hooks, and strips only ours', () => {
    const original = { theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [OTHER] }] } };
    const merged = mergeTowerHooks(original, CMD);
    expect(merged.theme).toBe('dark');
    expect(merged.hooks?.PreToolUse).toHaveLength(2);
    expect(hasTowerHooks(merged)).toBe(true);
    expect(stripTowerHooks(merged)).toEqual(original);
  });

  it('removes the hooks key entirely when nothing else remains', () => {
    expect(stripTowerHooks(mergeTowerHooks({ model: 'x' }, CMD))).toEqual({ model: 'x' });
  });
});

describe('install / uninstall on disk', () => {
  it('copies the hook, backs up settings, and round-trips cleanly', () => {
    const root = tempDir();
    const settingsFile = join(root, 'settings.json');
    const installDir = join(root, 'agent-tower', 'hooks');
    const backupsDir = join(root, 'agent-tower', 'backups');
    writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [OTHER] }] } }));

    const result = installHooks({ settingsFile, installDir, backupsDir });
    expect(result.command).toBe(hookCommand(installDir));
    expect(existsSync(join(installDir, 'claude-hook.mjs'))).toBe(true);
    expect(existsSync(join(installDir, 'hookLogic.mjs'))).toBe(true);
    expect(readdirSync(backupsDir)).toHaveLength(1);
    expect(hooksInstalled(settingsFile)).toBe(true);

    uninstallHooks({ settingsFile, installDir, backupsDir });
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({ hooks: { Stop: [{ hooks: [OTHER] }] } });
    expect(hooksInstalled(settingsFile)).toBe(false);
  });

  it('creates settings when missing and refuses non-object settings', () => {
    const root = tempDir();
    const paths = { settingsFile: join(root, 'settings.json'), installDir: join(root, 'agent-tower', 'hooks'), backupsDir: join(root, 'b') };
    installHooks(paths);
    expect(hooksInstalled(paths.settingsFile)).toBe(true);
    writeFileSync(paths.settingsFile, '[]');
    expect(() => installHooks(paths)).toThrow(/not a JSON object/);
    expect(hooksInstalled(join(root, 'nope.json'))).toBe(false);
    expect(uninstallHooks({ ...paths, settingsFile: join(root, 'nope.json') })).toEqual({});
  });
});
