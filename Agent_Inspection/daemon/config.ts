import { homedir } from 'node:os';
import { join } from 'node:path';

const LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');

/** Runtime state lives outside OneDrive to avoid sync churn and SQLite lock issues. */
export const TOWER_HOME = process.env.AGENT_TOWER_HOME ?? join(LOCAL_APP_DATA, 'agent-tower');

export const paths = {
  towerHome: TOWER_HOME,
  daemonInfo: join(TOWER_HOME, 'daemon.json'),
  interceptDir: join(TOWER_HOME, 'intercept'),
  hooksInstallDir: join(TOWER_HOME, 'hooks'),
  backupsDir: join(TOWER_HOME, 'backups'),
  database: join(TOWER_HOME, 'tower.db'),
  /** Team member worktrees (outside OneDrive, like the rest of the runtime state). */
  teamsDir: join(TOWER_HOME, 'teams'),
  claudeHome: process.env.CLAUDE_HOME ?? join(homedir(), '.claude'),
  codexHome: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
} as const;

export const claudePaths = {
  sessions: join(paths.claudeHome, 'sessions'),
  projects: join(paths.claudeHome, 'projects'),
  settings: join(paths.claudeHome, 'settings.json'),
  skills: join(paths.claudeHome, 'skills'),
  plugins: join(paths.claudeHome, 'plugins'),
} as const;

export const DAEMON_PORT = Number(process.env.AGENT_TOWER_PORT ?? 4317);
export const DAEMON_HOST = '127.0.0.1';

export const timings = {
  claudeRegistryPollMs: 1500,
  codexScanPollMs: 3000,
  processScanPollMs: 4000,
  codexLiveWindowMs: 60 * 60 * 1000,
  codexBusyWindowMs: 20 * 1000,
  hookDecisionTimeoutMs: 570_000,
  eventRetentionMs: 7 * 24 * 60 * 60 * 1000,
} as const;

/** Env var set on agents launched by the tower so the global hook ignores them. */
export const MANAGED_ENV_FLAG = 'AGENT_TOWER_MANAGED';
