import { randomUUID } from 'node:crypto';
import type { LibraryDeps } from './deps.ts';
import { defaultCommandHost, normalizeStdioCommand, type CommandHost } from './mcpCommand.ts';
import { MCP_PRESETS } from './mcpPresets.ts';
import { probeRemote, probeStdio } from './mcpProbe.ts';
import {
  LibraryInputError, type LaunchLoadout, type LoadoutContribution, type LoadoutProvider, type McpPreset, type McpServerInput,
  type McpServerView, type McpTestResult, type McpTransport,
} from './types.ts';
import type { ManagedLaunch, RemoteMcpServer, StdioMcpServer } from '../managed/types.ts';

const TABLE = 'mcp_servers';
const NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const PRESET_ID = /^[a-z0-9-]{1,40}$/;
const RESERVED = new Set(['team', 'notify', 'waystation']);
const TRANSPORTS: readonly McpTransport[] = ['stdio', 'http', 'sse'];
const MAX_ARGS = 50;
const MAX_ARG = 1000;
const MAX_ENV = 50;
const MAX_VALUE = 4000;
const MAX_SECRET = 8000;
const MAX_LABEL = 80;
const MAX_URL = 2000;

/** What is stored per server. Secret values live in the SecretStore under `mcp:<id>:<NAME>`. */
interface McpRecord {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly defaultOn: boolean;
  readonly presetId?: string;
  readonly createdAt: number;
}

type Fields = Omit<McpRecord, 'id' | 'createdAt'>;

const fail = (message: string): never => { throw new LibraryInputError(message); };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hasControl = (text: string) => /[\u0000-\u001f]/.test(text);

function stringMap(raw: unknown, what: string, keyPattern: RegExp, maxValue: number): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) return fail(`${what} must be an object`);
  const entries = Object.entries(raw);
  if (entries.length > MAX_ENV) fail(`${what} can have at most ${MAX_ENV} entries`);
  return Object.fromEntries(entries.map(([key, value]) => {
    if (!keyPattern.test(key)) fail(`${what}: "${key}" is not a valid name`);
    if (typeof value !== 'string' || value.length > maxValue) fail(`${what}: "${key}" must be text of at most ${maxValue} characters`);
    return [key, value as string];
  }));
}

function parseArgs(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ARGS) return fail(`args must be a list of at most ${MAX_ARGS} items`);
  return raw.map((arg) => (typeof arg === 'string' && arg.length <= MAX_ARG && !/[\r\n\0]/.test(arg)
    ? arg : fail(`each argument must be one line of at most ${MAX_ARG} characters`)));
}

function parseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_URL) return fail('url is required');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return fail('url is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('url must start with http:// or https://');
  return url.toString();
}

function parseTransportFields(body: Record<string, unknown>, transport: McpTransport): Pick<Fields, 'command' | 'args' | 'env' | 'url'> {
  if (transport !== 'stdio') return { url: parseUrl(body.url) };
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  if (!command || command.length > 500 || hasControl(command)) fail('command is required (one line, at most 500 characters)');
  return { command, args: parseArgs(body.args), env: stringMap(body.env, 'env', ENV_NAME, MAX_VALUE) };
}

/** "ghp_…" alone becomes "Bearer ghp_…": the usual mistake with an Authorization header. */
function normalizeSecret(name: string, value: string): string {
  return name.toLowerCase() === 'authorization' && value && !/\s/.test(value.trim()) ? `Bearer ${value.trim()}` : value;
}

function parseSecrets(raw: unknown, transport: McpTransport): Record<string, string> {
  const pattern = transport === 'stdio' ? ENV_NAME : HEADER_NAME;
  const map = stringMap(raw, 'secrets', pattern, MAX_SECRET);
  return Object.fromEntries(Object.entries(map).map(([name, value]) => [name, normalizeSecret(name, value)]));
}

export interface McpCatalogOptions {
  readonly commandHost?: () => CommandHost;
  readonly timeoutMs?: number;
}

/** Operator-defined MCP servers (stdio, HTTP, SSE) that agents can be launched with. */
export class McpCatalog implements LoadoutProvider {
  constructor(private readonly deps: LibraryDeps, private readonly options: McpCatalogOptions = {}) {}

  list(): McpServerView[] {
    return this.records().map((record) => this.view(record));
  }

  presets(): readonly McpPreset[] {
    return MCP_PRESETS;
  }

  create(raw: unknown): McpServerView {
    const { fields, secrets } = this.parse(raw);
    const record: McpRecord = { id: randomUUID(), createdAt: Date.now(), ...fields };
    this.deps.store.saveRecord(TABLE, record);
    this.applySecrets(record.id, secrets);
    this.deps.audit('mcp_create', record.id, { name: record.name, transport: record.transport, secretNames: Object.keys(secrets) });
    return this.view(record);
  }

  update(id: string, raw: unknown): McpServerView {
    const current = this.require(id);
    const { fields, secrets } = this.parse(raw, id);
    const record: McpRecord = { ...fields, id, createdAt: current.createdAt };
    // A secret meant for the other kind of transport (env var vs header) no longer applies.
    if (current.transport !== record.transport) this.deps.secrets.deleteUnder(this.prefix(id));
    this.deps.store.saveRecord(TABLE, record);
    this.applySecrets(id, secrets);
    this.deps.audit('mcp_update', id, { name: record.name, transport: record.transport, secretNames: Object.keys(secrets) });
    return this.view(record);
  }

  remove(id: string): void {
    const record = this.require(id);
    this.deps.store.deleteRecord(TABLE, id);
    this.deps.secrets.deleteUnder(this.prefix(id));
    this.deps.audit('mcp_delete', id, { name: record.name });
  }

  setDefault(id: string, on: boolean): McpServerView {
    if (typeof on !== 'boolean') fail('on must be true or false');
    const record = { ...this.require(id), defaultOn: on };
    this.deps.store.saveRecord(TABLE, record);
    this.deps.audit('mcp_default', id, { on });
    return this.view(record);
  }

  /** Connects, lists the tools, disconnects. Never throws for a server that misbehaves; secrets never reach the error. */
  async test(id: string): Promise<McpTestResult> {
    const record = this.require(id);
    const secrets = this.secretValues(record.id);
    this.deps.audit('mcp_test', id, { name: record.name });
    if (record.transport !== 'stdio') {
      return probeRemote({ type: record.transport, url: record.url ?? '', headers: secrets }, this.options.timeoutMs);
    }
    let command: { command: string; args: readonly string[] };
    try {
      command = this.normalized(record);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
    return probeStdio(
      { ...command, env: { ...process.env, ...record.env, ...secrets } },
      this.options.timeoutMs,
      Object.values(secrets),
    );
  }

  contribute(loadout: LaunchLoadout, launch: ManagedLaunch): LoadoutContribution {
    const ids = loadout.mcpIds ?? [];
    if (!ids.length) return {};
    const records = ids.map((id) => this.records().find((r) => r.id === id) ?? fail(`unknown MCP server: ${id}`));
    const skipped = launch.vendor === 'codex' ? records.filter((r) => r.transport === 'sse') : [];
    const used = records.filter((r) => !skipped.includes(r));
    const mcpServers = Object.fromEntries(used.filter((r) => r.transport === 'stdio').map((r) => [r.name, this.stdioServer(r)]));
    const remoteMcpServers = Object.fromEntries(used.filter((r) => r.transport !== 'stdio').map((r) => [r.name, this.remoteServer(r)]));
    return {
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      ...(Object.keys(remoteMcpServers).length ? { remoteMcpServers } : {}),
      ...(used.some((r) => r.transport === 'stdio') ? { env: this.stdioEnv(used) } : {}),
      ...(skipped.length ? { notes: skipped.map((r) => `MCP server "${r.name}" uses SSE, which Codex does not support; it was left out.`) } : {}),
    };
  }

  // ---- internals ---------------------------------------------------------------------------------

  private stdioServer(record: McpRecord): StdioMcpServer {
    const { command, args } = this.normalized(record);
    const secretNames = this.deps.secrets.namesUnder(this.prefix(record.id));
    return { command, args, env: { ...record.env }, ...(secretNames.length ? { inheritEnv: secretNames } : {}) };
  }

  private remoteServer(record: McpRecord): RemoteMcpServer {
    const headers = this.secretValues(record.id);
    return { type: record.transport as 'http' | 'sse', url: record.url ?? '', ...(Object.keys(headers).length ? { headers } : {}) };
  }

  /** Stdio secrets share the agent's environment, so two servers may not want different values under one name. */
  private stdioEnv(records: readonly McpRecord[]): Record<string, string> {
    return records.filter((r) => r.transport === 'stdio').reduce<Record<string, string>>((env, record) => {
      const values = this.secretValues(record.id);
      const clash = Object.keys(values).find((key) => key in env && env[key] !== values[key]);
      if (clash) fail(`two selected MCP servers need different values for ${clash}`);
      return { ...env, ...values };
    }, {});
  }

  private normalized(record: McpRecord) {
    return normalizeStdioCommand(record.command ?? '', record.args ?? [], (this.options.commandHost ?? defaultCommandHost)());
  }

  private parse(raw: unknown, selfId?: string): { fields: Fields; secrets: Record<string, string> } {
    if (!isRecord(raw)) return fail('expected an MCP server object');
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!NAME.test(name)) fail('name must start with a letter and use only a-z, 0-9, - and _ (at most 40 characters)');
    if (RESERVED.has(name)) fail(`"${name}" is reserved for Waystation's own tools`);
    if (this.records().some((r) => r.name === name && r.id !== selfId)) fail(`an MCP server named "${name}" already exists`);
    const transport = raw.transport as McpTransport;
    if (!TRANSPORTS.includes(transport)) fail('transport must be stdio, http or sse');
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : name;
    if (label.length > MAX_LABEL || hasControl(label)) fail(`label must be one line of at most ${MAX_LABEL} characters`);
    if (raw.defaultOn !== undefined && typeof raw.defaultOn !== 'boolean') fail('defaultOn must be true or false');
    if (raw.presetId !== undefined && (typeof raw.presetId !== 'string' || !PRESET_ID.test(raw.presetId))) fail('presetId is not valid');
    const transportFields = parseTransportFields(raw, transport);
    const secrets = parseSecrets(raw.secrets, transport);
    const envClash = Object.keys(secrets).find((key) => transportFields.env && key in transportFields.env);
    if (envClash) fail(`${envClash} is both a plain env value and a secret`);
    const fields: Fields = {
      name, label, transport, ...transportFields, defaultOn: raw.defaultOn === true,
      ...(typeof raw.presetId === 'string' ? { presetId: raw.presetId } : {}),
    };
    return { fields, secrets };
  }

  private applySecrets(id: string, secrets: Readonly<Record<string, string>>): void {
    for (const [name, value] of Object.entries(secrets)) {
      const key = `${this.prefix(id)}${name}`;
      if (value === '') this.deps.secrets.delete(key);
      else this.deps.secrets.set(key, value);
    }
  }

  private secretValues(id: string): Record<string, string> {
    const prefix = this.prefix(id);
    return Object.fromEntries(this.deps.secrets.namesUnder(prefix).flatMap((name) => {
      const value = this.deps.secrets.get(`${prefix}${name}`);
      return value === undefined ? [] : [[name, value]];
    }));
  }

  private prefix(id: string): string {
    return `mcp:${id}:`;
  }

  private records(): McpRecord[] {
    return this.deps.store.loadRecords<McpRecord>(TABLE);
  }

  private require(id: string): McpRecord {
    return this.records().find((r) => r.id === id) ?? fail(`unknown MCP server: ${id}`);
  }

  private view(record: McpRecord): McpServerView {
    return {
      id: record.id,
      name: record.name,
      label: record.label,
      transport: record.transport,
      ...(record.transport === 'stdio' ? { command: record.command, args: [...(record.args ?? [])], env: { ...record.env } } : { url: record.url }),
      secretNames: this.deps.secrets.namesUnder(this.prefix(record.id)),
      defaultOn: record.defaultOn,
      ...(record.presetId ? { presetId: record.presetId } : {}),
      createdAt: record.createdAt,
    };
  }
}
