import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse, type ParseError } from 'jsonc-parser';
import { BUILTIN_DISCOVERY, NATIVE_PROVIDERS, replaceProviderCatalog, type DiscoveryRule, type ProviderDescriptor } from '../../shared/agentProviders.ts';
import { paths } from '../config.ts';

export interface AcpRegistration {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** ACP's experimental usage field has divergent implementations. Unspecified means display only. */
  readonly usageMode?: 'turn' | 'session';
}
export interface ResolvedCommand { readonly command: string; readonly args: readonly string[] }
const file = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };
function nodeScript(path: string): boolean {
  if (/\.(?:m?js|cjs)$/i.test(path)) return true;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r'); const header = Buffer.alloc(256);
    const bytes = readSync(descriptor, header, 0, header.length, 0);
    return /^#![^\r\n]*\bnode\b/.test(header.toString('utf8', 0, bytes));
  } catch { return false; } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
/** Documented ACP startup profiles. Adding a profile never requires edits to feature surfaces. */
export const AUTO_ACP_PROFILES = [
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', args: ['--acp'], configuration: ['.gemini/settings.json'] },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', args: ['acp'], configuration: ['.config/opencode/opencode.json', '.config/opencode/opencode.jsonc'] },
  { id: 'qwen', label: 'Qwen Code', command: 'qwen', args: ['--acp'], configuration: ['.qwen/settings.json'] },
  { id: 'goose', label: 'Goose', command: 'goose', args: ['acp'], configuration: ['.config/goose/config.yaml'] },
] as const;

/** Resolve npm shims to their actual entry script; never interpolate a shell command. */
export function resolveAgentCommand(command: string, args: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): ResolvedCommand | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).map(dir => dir.replace(/^"|"$/g, '')).filter(Boolean);
  if (env.APPDATA) dirs.push(join(env.APPDATA, 'npm'));
  const candidates = isAbsolute(command) ? [command] : dirs.flatMap(dir => process.platform === 'win32'
    ? [join(dir, command), join(dir, `${command}.exe`), join(dir, `${command}.cmd`)] : [join(dir, command)]);
  for (const candidate of candidates) {
    if (!file(candidate)) continue;
    if (/\.(cmd|ps1|bat)$/i.test(candidate)) {
      let shim: string;
      try { shim = readFileSync(candidate, 'utf8'); } catch { continue; }
      const entry = /(?:%dp0%|\$basedir)[\\/](node_modules[\\/][^"\r\n]+)"/i.exec(shim)?.[1]
        ?? /(?:%dp0%|\$basedir)[\\/]([^"\r\n]*?\.(?:m?js|cjs))/i.exec(shim)?.[1];
      if (entry) {
        const script = resolve(dirname(candidate), entry.replace(/\\/g, '/'));
        if (file(script) && /\.exe$/i.test(script)) return { command: script, args };
        if (file(script) && nodeScript(script)) return { command: process.execPath, args: [script, ...args] };
      }
      continue;
    }
    return /\.(?:m?js|cjs)$/i.test(candidate) ? { command: process.execPath, args: [candidate, ...args] } : { command: candidate, args };
  }
  return undefined;
}

function registration(raw: unknown, key?: string): AcpRegistration {
  if (!raw || typeof raw !== 'object') throw new Error('Each ACP provider must be an object.');
  const body = raw as Record<string, unknown>;
  const id = key ? `acp-${key.toLowerCase().replace(/[^a-z0-9-]/g, '-')}` : body.id;
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id) || ['other', 'constructor', 'prototype'].includes(id) || NATIVE_PROVIDERS.some(p => p.id === id)) throw new Error('ACP provider IDs must be unique lowercase names.');
  const label = body.label ?? body.name ?? key ?? id;
  if (typeof label !== 'string' || !label.trim() || label.length > 80) throw new Error(`Invalid label for ${id}.`);
  if (typeof body.command !== 'string' || !body.command.trim() || body.command.length > 2048) throw new Error(`Missing executable for ${id}.`);
  if (body.args !== undefined && (!Array.isArray(body.args) || body.args.length > 100 || body.args.some(arg => typeof arg !== 'string' || arg.length > 8192))) throw new Error(`Arguments for ${id} must be an array of strings.`);
  if (body.env !== undefined && (!body.env || typeof body.env !== 'object' || Array.isArray(body.env) || Object.entries(body.env).some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string'))) throw new Error(`Invalid environment for ${id}.`);
  if (body.usageMode !== undefined && body.usageMode !== 'turn' && body.usageMode !== 'session') throw new Error('Usage reporting must be turn or session. Leave it unspecified if the agent does not document its usage scope.');
  return { id, label: label.trim(), command: body.command, args: body.args as string[] ?? [], env: body.env as Record<string, string> | undefined, usageMode: body.usageMode as 'turn' | 'session' | undefined };
}

/** Local configuration is trusted executable configuration. Discovery never installs or runs probes. */
export class ProviderRegistry {
  private registrations = new Map<string, AcpRegistration>();
  private descriptors: ProviderDescriptor[] = [...NATIVE_PROVIDERS];
  private lastGood = new Map<string, AcpRegistration[]>();
  private warnings: string[] = [];
  readonly configFile: string;
  private readonly files: readonly string[];
  constructor(private readonly options: { configFile?: string; files?: readonly string[]; env?: NodeJS.ProcessEnv; home?: string } = {}) {
    const home = options.home ?? homedir();
    this.configFile = options.configFile ?? join(paths.towerHome, 'providers.json');
    this.files = options.files ?? [join(home, '.waystation', 'providers.json'), join(home, '.config', 'zed', 'settings.json'), ...(process.env.APPDATA ? [join(process.env.APPDATA, 'Zed', 'settings.json')] : []), this.configFile];
    this.refresh();
  }
  refresh(): void {
    const next = new Map<string, AcpRegistration>();
    this.warnings = [];
    // Only inspect executable/configuration presence. Never read credentials or make a model request.
    const home = this.options.home ?? homedir();
    for (const profile of AUTO_ACP_PROFILES) if (resolveAgentCommand(profile.command, [], this.options.env) || profile.configuration.some(path => file(join(home, path)))) {
      next.set(profile.id, { id: profile.id, label: profile.label, command: profile.command, args: profile.args });
    }
    for (const path of this.files) {
      if (!existsSync(path)) { this.lastGood.delete(path); continue; }
      try {
        if (statSync(path).size > 1_048_576) throw new Error('Configuration exceeds 1 MB.');
        const errors: ParseError[] = [];
        const body = parse(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true, disallowComments: false });
        if (errors.length || !body || typeof body !== 'object') throw new Error('Invalid JSON configuration.');
        const list = path.endsWith('settings.json')
          ? Object.entries(body.agent_servers ?? {}).filter(([, value]) => value && typeof value === 'object' && 'command' in value).map(([key, value]) => registration(value, key))
          : Array.isArray(body.providers) ? body.providers.map((value: unknown) => registration(value)) : (() => { throw new Error('Expected a providers array.'); })();
        if (new Set(list.map((item: AcpRegistration) => item.id)).size !== list.length) throw new Error('Duplicate provider IDs.');
        this.lastGood.set(path, list);
      } catch { this.warnings.push(`Could not read ${path}. Keeping its last valid registrations; check provider IDs, commands and JSON syntax.`); }
      for (const item of this.lastGood.get(path) ?? []) next.set(item.id, item);
    }
    this.registrations = next;
    this.descriptors = [...NATIVE_PROVIDERS, ...[...next.values()].map(item => {
      const available = !!this.resolve(item.id);
      return { id: item.id, label: item.label, launchLabel: item.label, adapter: 'acp' as const, intercept: true, plugins: false, cli: false, usageMode: item.usageMode,
        available, detail: available ? 'ACP · uses the agent’s existing sign-in' : 'Executable not found; check its configured path.' };
    })];
    replaceProviderCatalog(this.descriptors);
  }
  list(): readonly ProviderDescriptor[] { return this.descriptors; }
  report() { return { providers: this.list(), warnings: this.warnings, configFile: this.configFile }; }
  add(raw: unknown): void {
    const item = registration(raw);
    this.refresh();
    if (this.descriptors.some(provider => provider.id === item.id)) throw new Error('That provider ID is already registered.');
    const body = this.ownConfiguration();
    this.saveConfiguration({ ...body, providers: [...body.providers, item] });
  }
  remove(id: string): void {
    const body = this.ownConfiguration();
    if (!body.providers.some(item => item.id === id)) throw new Error('Remove automatically discovered agents from their original configuration.');
    this.saveConfiguration({ ...body, providers: body.providers.filter(item => item.id !== id) });
  }
  private ownConfiguration(): { providers: AcpRegistration[]; [key: string]: unknown } {
    if (!existsSync(this.configFile)) return { providers: [] };
    const errors: ParseError[] = [];
    const body = parse(readFileSync(this.configFile, 'utf8'), errors, { allowTrailingComma: true });
    if (errors.length || !body || !Array.isArray(body.providers)) throw new Error('Repair providers.json before saving another agent.');
    body.providers.forEach((item: unknown) => registration(item));
    return body;
  }
  private saveConfiguration(body: unknown): void {
    mkdirSync(dirname(this.configFile), { recursive: true });
    const temporary = `${this.configFile}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(body, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, this.configFile);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    this.refresh();
  }
  get(id: string): AcpRegistration | undefined { return this.registrations.get(id); }
  resolve(id: string): ResolvedCommand | undefined {
    const item = this.get(id);
    return item ? resolveAgentCommand(item.command, item.args, { ...(this.options.env ?? process.env), ...item.env }) : undefined;
  }
  discoveryRules(): DiscoveryRule[] {
    return [...this.registrations.values()].filter(item => !BUILTIN_DISCOVERY.some(rule => rule.id === item.id)).map(item => ({ id: item.id, label: item.label,
      executables: /^(node|python[\d.]*|cmd|pwsh|powershell)(\.exe)?$/i.test(basename(item.command)) ? [] : [basename(item.command).replace(/\.(exe|cmd|ps1)$/i, '').toLowerCase()], packages: [] })).filter(rule => rule.executables.length > 0);
  }
}
