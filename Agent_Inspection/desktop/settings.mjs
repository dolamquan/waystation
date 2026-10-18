import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

export const PATH_KEYS = ['claudeHome', 'codexHome', 'claudeExe', 'codexJs'];
export const PATH_ENV = { claudeHome: 'CLAUDE_HOME', codexHome: 'CODEX_HOME', claudeExe: 'AGENT_TOWER_CLAUDE_EXE', codexJs: 'AGENT_TOWER_CODEX_JS' };

export function defaultSettings() {
  return { setupComplete: false, notifications: true, paths: { claudeHome: '', codexHome: '', claudeExe: '', codexJs: '' }, window: { width: 1280, height: 860, maximized: false } };
}

export function readSettings(home) {
  const defaults = defaultSettings();
  try {
    const raw = JSON.parse(readFileSync(join(home, 'desktop.json'), 'utf8'));
    if (!raw || typeof raw !== 'object') return defaults;
    return {
      setupComplete: raw.setupComplete === true,
      notifications: raw.notifications !== false,
      paths: Object.fromEntries(PATH_KEYS.map((key) => [key, typeof raw.paths?.[key] === 'string' ? raw.paths[key] : ''])),
      window: {
        width: bounded(raw.window?.width, 900, 10000, 1280), height: bounded(raw.window?.height, 620, 10000, 860),
        ...(Number.isInteger(raw.window?.x) ? { x: raw.window.x } : {}),
        ...(Number.isInteger(raw.window?.y) ? { y: raw.window.y } : {}),
        maximized: raw.window?.maximized === true,
      },
    };
  } catch { return defaults; }
}

function bounded(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function writeSettings(home, settings) {
  mkdirSync(home, { recursive: true });
  const file = join(home, 'desktop.json');
  writeFileSync(`${file}.tmp`, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** Only these four local paths can be configured; credentials never cross IPC. */
export function validatePreferences(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.notifications !== 'boolean' || typeof raw.setupComplete !== 'boolean' || !raw.paths || typeof raw.paths !== 'object') {
    throw new Error('Desktop preferences are incomplete. Reopen Desktop setup and try again.');
  }
  const paths = {};
  for (const key of PATH_KEYS) {
    if (typeof raw.paths[key] !== 'string' || raw.paths[key].length > 4096 || /[\u0000-\u001f]/.test(raw.paths[key])) throw new Error(`Invalid ${key} path.`);
    const value = raw.paths[key].trim();
    if (value) {
      if (!isAbsolute(value)) throw new Error(`${key} must be an absolute path.`);
      let stat;
      try { stat = statSync(value); } catch { throw new Error(`${key} was not found. Choose an existing path or clear it for automatic detection.`); }
      if (key.endsWith('Home') ? !stat.isDirectory() : !stat.isFile()) throw new Error(`${key} must point to a ${key.endsWith('Home') ? 'folder' : 'file'}.`);
      if (key === 'claudeExe' && !/\.exe$/i.test(value)) throw new Error('Choose the native Claude .exe executable.');
      if (key === 'codexJs' && !/\.(?:m?js)$/i.test(value)) throw new Error('Choose the npm Codex JavaScript entry, usually bin/codex.js.');
    }
    paths[key] = value;
  }
  return { setupComplete: raw.setupComplete, notifications: raw.notifications, paths };
}

export function daemonEnvironment(settings, base = process.env) {
  const env = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of PATH_KEYS) if (settings.paths[key]) env[PATH_ENV[key]] = settings.paths[key];
  return env;
}

export function effectivePaths(settings, base = process.env) {
  return {
    claudeHome: settings.paths.claudeHome || base.CLAUDE_HOME || join(homedir(), '.claude'),
    codexHome: settings.paths.codexHome || base.CODEX_HOME || join(homedir(), '.codex'),
    claudeExe: settings.paths.claudeExe || base.AGENT_TOWER_CLAUDE_EXE || 'Automatic detection',
    codexJs: settings.paths.codexJs || base.AGENT_TOWER_CODEX_JS || 'Automatic detection',
  };
}
