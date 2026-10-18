import { readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { resolveCodexEntry } from '../managed/codexRunner.ts';
import { runCli, type CliResult } from './cliRunner.ts';
import type { LibraryDeps } from './deps.ts';
import { checkedId, isRecord, PLUGIN_ID, readJson } from './pluginCatalog.ts';
import { LibraryInputError, type AvailablePlugin, type CodexPluginView } from './types.ts';

const MAX_AVAILABLE = 2000;
/** Remote marketplace entries named only by an opaque connector id ("app-6a05…"): nothing an operator could pick from. */
const OPAQUE_NAME = /^app-[0-9a-f]{16,}$/i;
const MARKETPLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Json = Record<string, unknown>;

/** Runs `codex plugin <args>`. Injectable so tests never start the real CLI. */
export type CodexPluginCli = (args: readonly string[]) => Promise<CliResult>;

const fail = (message: string): never => { throw new LibraryInputError(message); };
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** Default runner: the npm-installed Codex CLI (`node codex.js plugin …`), spawned without a shell. */
export const codexPluginCli: CodexPluginCli = async (args) => {
  const entry = resolveCodexEntry();
  if (!entry) throw new LibraryInputError('Codex was not found. Install it with npm i -g @openai/codex.');
  return runCli({ label: 'codex plugin', command: process.execPath, args: [entry, 'plugin', ...args] });
};

/** One entry of `codex plugin list --json` (installed or available). */
interface ListedPlugin {
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  readonly version?: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly source?: string;
  readonly installable: boolean;
}

function parseListed(raw: unknown): ListedPlugin | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw.pluginId);
  const name = str(raw.name);
  const marketplace = str(raw.marketplaceName);
  if (!id || !name || !marketplace || !PLUGIN_ID.test(id) || id !== `${name}@${marketplace}`) return undefined;
  return {
    id, name, marketplace,
    ...(str(raw.version) ? { version: str(raw.version) } : {}),
    installed: raw.installed === true,
    enabled: raw.enabled === true,
    ...(isRecord(raw.source) && str(raw.source.source) ? { source: str(raw.source.source) } : {}),
    installable: raw.installPolicy !== 'NOT_AVAILABLE',
  };
}

function parseJson(result: CliResult, what: string): Json {
  if (result.code !== 0) fail(`codex plugin ${what} failed${result.output ? `: ${result.output}` : ` (exit code ${result.code})`}`);
  try {
    const parsed = JSON.parse(result.stdout ?? '') as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // fall through to the error below
  }
  return fail(`codex plugin ${what} printed output Waystation could not read.`);
}

const listOf = (json: Json, key: string): ListedPlugin[] =>
  (Array.isArray(json[key]) ? json[key] as unknown[] : []).flatMap((raw) => parseListed(raw) ?? []);

/**
 * Descriptions from the manifests of local marketplaces (`<root>/.agents/plugins/*.json` listing
 * `./plugins/<name>`, each with `.codex-plugin/plugin.json`). Keyed by "name@marketplace" and by bare name,
 * since the remote catalog ("openai-curated-remote") mirrors the local one ("openai-curated").
 */
export function readMarketplaceDescriptions(roots: readonly string[]): Map<string, string> {
  const descriptions = new Map<string, string>();
  for (const root of roots) {
    const manifestDir = join(root, '.agents', 'plugins');
    let files: string[];
    try {
      files = readdirSync(manifestDir).filter((file) => file.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      const manifest = readJson(join(manifestDir, file));
      const marketplace = str(manifest?.name);
      const plugins = Array.isArray(manifest?.plugins) ? manifest.plugins.filter(isRecord) : [];
      for (const plugin of plugins) {
        const name = str(plugin.name);
        const path = isRecord(plugin.source) ? str(plugin.source.path) : undefined;
        if (!name || !path) continue;
        const dir = resolve(root, path);
        const inside = relative(resolve(root), dir);
        if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
        const pluginJson = readJson(join(dir, '.codex-plugin', 'plugin.json'));
        const ui = isRecord(pluginJson?.interface) ? pluginJson.interface : undefined;
        const description = str(ui?.shortDescription) ?? str(pluginJson?.description);
        if (!description) continue;
        if (marketplace) descriptions.set(`${name}@${marketplace}`, description);
        if (!descriptions.has(name)) descriptions.set(name, description);
      }
    }
  }
  return descriptions;
}

/** Codex's own plugin system (`codex plugin`): installed plugins and the marketplaces to install from. */
export class CodexPluginCatalog {
  constructor(private readonly deps: LibraryDeps, private readonly cli: CodexPluginCli = codexPluginCli) {}

  async list(): Promise<CodexPluginView[]> {
    const [listed, descriptions] = await Promise.all([this.listJson(false), this.descriptions()]);
    return listOf(listed, 'installed').filter((p) => p.installed).map((p) => {
      const description = this.describe(descriptions, p);
      return {
        id: p.id,
        name: p.name,
        marketplace: p.marketplace,
        ...(p.version ? { version: p.version } : {}),
        ...(description ? { description } : {}),
        enabled: p.enabled,
        ...(p.source ? { source: p.source } : {}),
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
  }

  async available(): Promise<AvailablePlugin[]> {
    const [listed, descriptions] = await Promise.all([this.listJson(true), this.descriptions()]);
    const seen = new Set<string>();
    const plugins = [...listOf(listed, 'installed'), ...listOf(listed, 'available')].flatMap((p) => {
      if (seen.has(p.id) || !p.installable || OPAQUE_NAME.test(p.name)) return [];
      seen.add(p.id);
      const description = this.describe(descriptions, p);
      return [{ id: p.id, name: p.name, marketplace: p.marketplace, installed: p.installed, ...(description ? { description } : {}) }];
    });
    // Curated plugins (with a description) first, then alphabetical.
    return plugins
      .sort((a, b) => Number(!a.description) - Number(!b.description) || a.name.localeCompare(b.name))
      .slice(0, MAX_AVAILABLE);
  }

  async install(rawId: unknown): Promise<string> {
    return this.run('add', checkedId(rawId));
  }

  async uninstall(rawId: unknown): Promise<string> {
    const id = checkedId(rawId);
    if (!(await this.list()).some((p) => p.id === id)) fail(`Codex plugin ${id} is not installed`);
    return this.run('remove', id);
  }

  private describe(descriptions: Map<string, string>, p: ListedPlugin): string | undefined {
    return descriptions.get(p.id) ?? descriptions.get(p.name);
  }

  private async listJson(includeAvailable: boolean): Promise<Json> {
    const result = await this.cli(['list', '--json', ...(includeAvailable ? ['--available'] : [])]);
    return parseJson(result, 'list');
  }

  /** Marketplace roots come from `codex plugin marketplace list --json`; a failure only costs the descriptions. */
  private async descriptions(): Promise<Map<string, string>> {
    try {
      const json = parseJson(await this.cli(['marketplace', 'list', '--json']), 'marketplace list');
      const marketplaces = Array.isArray(json.marketplaces) ? json.marketplaces.filter(isRecord) : [];
      const roots = marketplaces.filter((m) => MARKETPLACE_NAME.test(str(m.name) ?? '')).flatMap((m) => str(m.root) ?? []);
      return readMarketplaceDescriptions(roots);
    } catch {
      return new Map();
    }
  }

  private async run(verb: 'add' | 'remove', id: string): Promise<string> {
    this.deps.audit(`codex_plugin_${verb}`, id, {});
    const result = await this.cli([verb, id]);
    if (result.code !== 0) fail(`codex plugin ${verb} failed${result.output ? `: ${result.output}` : ` (exit code ${result.code})`}`);
    return result.output;
  }
}
