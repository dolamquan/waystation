import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stopProcessTree } from '../actions/kill.ts';
import { MANAGED_ENV_FLAG } from '../config.ts';
import { resolveClaudeExe } from '../managed/cliCommands.ts';
import type { ManagedLaunch } from '../managed/types.ts';
import type { LibraryDeps } from './deps.ts';
import { LibraryInputError, type AvailablePlugin, type LaunchLoadout, type LoadoutContribution, type LoadoutProvider, type PluginView } from './types.ts';

const TABLE = 'plugin_prefs';
// Each part starts alphanumeric so an id can never be read as a CLI option ("-x@m").
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CLI_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 4000;
const MAX_AVAILABLE = 2000;

type Json = Record<string, unknown>;

interface PluginPref {
  readonly id: string;
  readonly defaultOn: boolean;
}

export interface CliResult {
  readonly code: number | null;
  readonly output: string;
}

/** Runs `claude plugin <args>`. Injectable so tests never start the real CLI. */
export type PluginCli = (args: readonly string[]) => Promise<CliResult>;

const fail = (message: string): never => { throw new LibraryInputError(message); };
const isRecord = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

function readJson(path: string): Json | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function checkedId(raw: unknown): string {
  return typeof raw === 'string' && raw.length <= 200 && PLUGIN_ID.test(raw) ? raw : fail('plugin id must look like name@marketplace');
}

function countSkills(installPath: string): number {
  const dir = join(installPath, 'skills');
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md'))).length;
  } catch {
    return 0;
  }
}

function countMcpServers(installPath: string, manifest: Json | undefined): number {
  const file = readJson(join(installPath, '.mcp.json'));
  const fromFile = isRecord(file?.mcpServers) ? file.mcpServers : file;
  if (fromFile && Object.keys(fromFile).length) return Object.keys(fromFile).length;
  return isRecord(manifest?.mcpServers) ? Object.keys(manifest.mcpServers).length : 0;
}

const trimOutput = (text: string) => {
  const trimmed = text.trim();
  return trimmed.length > MAX_OUTPUT ? `…${trimmed.slice(-MAX_OUTPUT)}` : trimmed;
};

/** Default runner: the real Claude Code CLI, spawned without a shell, killed after two minutes. */
export const claudePluginCli: PluginCli = (args) => new Promise((resolve, reject) => {
  const exe = resolveClaudeExe();
  if (!exe) {
    reject(new LibraryInputError('Claude Code was not found. Install it (npm i -g @anthropic-ai/claude-code) or set AGENT_TOWER_CLAUDE_EXE.'));
    return;
  }
  const env = { ...process.env };
  delete env[MANAGED_ENV_FLAG];
  const child = spawn(exe, ['plugin', ...args], { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-MAX_OUTPUT * 2); };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const timer = setTimeout(() => {
    if (child.pid) stopProcessTree(child.pid).catch(() => child.kill());
    reject(new LibraryInputError('claude plugin did not finish within 2 minutes.'));
  }, CLI_TIMEOUT_MS);
  child.on('error', (error) => { clearTimeout(timer); reject(new LibraryInputError(`Could not run claude plugin: ${error.message}`)); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, output: trimOutput(output) }); });
});

/** Installed Claude Code plugins, marketplaces to install from, and which plugins agents get by default. */
export class PluginCatalog implements LoadoutProvider {
  constructor(private readonly deps: LibraryDeps, private readonly cli: PluginCli = claudePluginCli) {}

  private get pluginsDir(): string {
    return join(this.deps.paths.claudeHome, 'plugins');
  }

  list(): PluginView[] {
    const installed = readJson(join(this.pluginsDir, 'installed_plugins.json'));
    const entries = isRecord(installed?.plugins) ? Object.entries(installed.plugins) : [];
    const enabled = this.enabledGlobally();
    const prefs = this.prefs();
    return entries.flatMap(([id, raw]) => {
      if (!PLUGIN_ID.test(id) || !Array.isArray(raw)) return [];
      const installs = raw.filter(isRecord).filter((e) => typeof e.installPath === 'string');
      const install = installs.find((e) => e.scope === 'user') ?? installs[0];
      if (!install) return [];
      const installPath = install.installPath as string;
      const manifest = readJson(join(installPath, '.claude-plugin', 'plugin.json'));
      const [name, marketplace] = id.split('@');
      return [{
        id,
        name,
        marketplace,
        ...(typeof install.version === 'string' ? { version: install.version } : {}),
        ...(typeof manifest?.description === 'string' ? { description: manifest.description } : {}),
        installPath,
        skills: countSkills(installPath),
        mcpServers: countMcpServers(installPath, manifest),
        enabledGlobally: enabled[id] === true,
        defaultOn: prefs.get(id) === true,
      }];
    }).sort((a, b) => a.id.localeCompare(b.id));
  }

  available(): AvailablePlugin[] {
    const root = join(this.pluginsDir, 'marketplaces');
    const installed = new Set(this.list().map((p) => p.id));
    let dirs: string[];
    try {
      dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    return dirs.flatMap((dir) => {
      const manifest = readJson(join(root, dir, '.claude-plugin', 'marketplace.json'));
      const marketplace = typeof manifest?.name === 'string' && /^[A-Za-z0-9._-]+$/.test(manifest.name) ? manifest.name : dir;
      const plugins = Array.isArray(manifest?.plugins) ? manifest.plugins.filter(isRecord) : [];
      return plugins.flatMap((plugin) => {
        const id = `${String(plugin.name)}@${marketplace}`;
        if (typeof plugin.name !== 'string' || !PLUGIN_ID.test(id)) return [];
        return [{
          id, name: plugin.name, marketplace, installed: installed.has(id),
          ...(typeof plugin.description === 'string' ? { description: plugin.description } : {}),
        }];
      });
    }).slice(0, MAX_AVAILABLE);
  }

  setDefault(rawId: unknown, on: unknown): void {
    const id = checkedId(rawId);
    if (typeof on !== 'boolean') fail('on must be true or false');
    this.requireInstalled(id);
    this.deps.store.saveRecord<PluginPref>(TABLE, { id, defaultOn: on as boolean });
    this.deps.audit('plugin_default', id, { on });
  }

  async setEnabled(rawId: unknown, on: unknown): Promise<string> {
    const id = checkedId(rawId);
    if (typeof on !== 'boolean') fail('on must be true or false');
    this.requireInstalled(id);
    return this.run(on ? 'enable' : 'disable', id);
  }

  async install(rawId: unknown): Promise<string> {
    return this.run('install', checkedId(rawId));
  }

  async uninstall(rawId: unknown): Promise<string> {
    const id = checkedId(rawId);
    this.requireInstalled(id);
    const output = await this.run('uninstall', id);
    this.deps.store.deleteRecord(TABLE, id);
    return output;
  }

  contribute(loadout: LaunchLoadout, launch: ManagedLaunch): LoadoutContribution {
    const ids = loadout.pluginIds ?? [];
    if (!ids.length) return {};
    const installed = this.list();
    const chosen = ids.map((id) => installed.find((p) => p.id === id) ?? fail(`unknown or uninstalled plugin: ${id}`));
    if (launch.vendor === 'codex') return { notes: ['Plugins are ignored for Codex agents.'] };
    // Globally enabled plugins already load through the user's settings.
    const plugins = chosen.filter((p) => !p.enabledGlobally).map((p) => p.installPath);
    return plugins.length ? { plugins } : {};
  }

  private async run(verb: 'install' | 'uninstall' | 'enable' | 'disable', id: string): Promise<string> {
    this.deps.audit(`plugin_${verb}`, id, {});
    const result = await this.cli([verb, id, '--scope', 'user']);
    if (result.code !== 0) fail(`claude plugin ${verb} failed${result.output ? `: ${result.output}` : ` (exit code ${result.code})`}`);
    return result.output;
  }

  private requireInstalled(id: string): void {
    if (!this.list().some((p) => p.id === id)) fail(`plugin ${id} is not installed`);
  }

  private enabledGlobally(): Record<string, unknown> {
    const settings = readJson(join(this.deps.paths.claudeHome, 'settings.json'));
    return isRecord(settings?.enabledPlugins) ? settings.enabledPlugins : {};
  }

  private prefs(): Map<string, boolean> {
    return new Map(this.deps.store.loadRecords<PluginPref>(TABLE).map((p) => [p.id, p.defaultOn === true]));
  }
}
