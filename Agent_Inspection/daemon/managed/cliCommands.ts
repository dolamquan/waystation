import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ManagedLaunch, RemoteMcpServer } from './types.ts';

/** Command lines for the real, interactive Claude Code and Codex CLIs (used when a session is handed to the operator's terminal). */

export interface CliCommand {
  readonly command: string;
  readonly args: readonly string[];
}

type McpServers = NonNullable<ManagedLaunch['mcpServers']>;
type RemoteServers = Readonly<Record<string, RemoteMcpServer>>;

/** Session ids are UUIDs; anything that could read as a flag is refused. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const ENV_NAME = /^[A-Za-z0-9_]+$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

function checkedSessionId(id: string): string {
  if (!SESSION_ID.test(id)) throw new Error(`Refusing an unexpected session id: ${id}`);
  return id;
}

/** npm installs ship a native claude.exe behind a .cmd shim, which cannot be started without a shell. */
export function resolveClaudeExe(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | undefined {
  const searchPath = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const candidates = [
    env.AGENT_TOWER_CLAUDE_EXE,
    env.APPDATA ? join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : undefined,
    env.USERPROFILE ? join(env.USERPROFILE, '.local', 'bin', 'claude.exe') : undefined,
    ...searchPath.map((dir) => join(dir, 'claude.exe')),
  ];
  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && exists(candidate));
}

// ---- remote MCP headers ------------------------------------------------------------------------

/**
 * Remote MCP header values are secrets. Both CLIs take MCP config on the command line, which any
 * process on the machine can read, so each header value moves into an environment variable:
 * Claude Code expands `${VAR}` in `--mcp-config` headers, Codex reads `env_http_headers`.
 */
export interface RemoteHeaderPlan {
  /** server name -> header name -> environment variable holding its value. */
  readonly vars: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The values, for the agent process environment only. */
  readonly env: Readonly<Record<string, string>>;
}

export function remoteHeaderPlan(servers: RemoteServers | undefined): RemoteHeaderPlan {
  const entries = Object.entries(servers ?? {});
  const perServer = entries.map(([name, server], i) => {
    if (!SERVER_NAME.test(name)) throw new Error(`invalid MCP server name "${name}"`);
    const headers = Object.entries(server.headers ?? {}).map(([header, value], j) => {
      if (!HEADER_NAME.test(header)) throw new Error(`invalid header name for MCP server "${name}"`);
      return { header, value, variable: `WAYSTATION_MCP_H${i}_${j}` };
    });
    return { name, headers };
  });
  return {
    vars: Object.fromEntries(perServer.map(({ name, headers }) => [name, Object.fromEntries(headers.map((h) => [h.header, h.variable]))])),
    env: Object.fromEntries(perServer.flatMap(({ headers }) => headers.map((h) => [h.variable, h.value]))),
  };
}

// ---- Claude Code -------------------------------------------------------------------------------

/**
 * Claude Code MCP config. Secret variables (`inheritEnv`) take their value from `secrets` when given (for a
 * config file in the tower's private folder); otherwise they are written as `${VAR}` placeholders.
 * Remote servers get `${VAR}` header placeholders from `remoteHeaderPlan` unless `inlineHeaders` is set
 * (only for a config file in the tower's private folder).
 */
export function claudeMcpConfig(
  servers: McpServers,
  secrets: Readonly<Record<string, string>> = {},
  remote: RemoteServers = {},
  inlineHeaders = false,
): { mcpServers: Record<string, unknown> } {
  const plan = remoteHeaderPlan(remote);
  const stdio = Object.entries(servers).map(([name, server]) => [name, {
    type: 'stdio',
    command: server.command,
    args: [...server.args],
    env: { ...server.env, ...Object.fromEntries((server.inheritEnv ?? []).map((key) => [key, secrets[key] ?? `\${${key}}`])) },
  }]);
  const remotes = Object.entries(remote).map(([name, server]) => {
    const headers = inlineHeaders
      ? { ...server.headers }
      : Object.fromEntries(Object.entries(plan.vars[name] ?? {}).map(([header, variable]) => [header, `\${${variable}}`]));
    return [name, { type: server.type, url: server.url, ...(Object.keys(headers).length ? { headers } : {}) }];
  });
  return { mcpServers: Object.fromEntries([...stdio, ...remotes]) };
}

export function claudeCliCommand(exe: string, opts: {
  readonly resumeSessionId?: string;
  /** Open a copy (new session id) instead of continuing the session itself, e.g. while it runs elsewhere. */
  readonly fork?: boolean;
  readonly model?: string;
  /** A config object (passed inline) or the path of a config file. */
  readonly mcpConfig?: object | string;
  readonly appendSystemPrompt?: string;
  /** Local plugin directories (library skills bundle, installed plugins not enabled globally). */
  readonly plugins?: readonly string[];
}): CliCommand {
  const mcpConfig = typeof opts.mcpConfig === 'string' ? opts.mcpConfig : opts.mcpConfig ? JSON.stringify(opts.mcpConfig) : undefined;
  return {
    command: exe,
    args: [
      ...(opts.resumeSessionId ? ['--resume', checkedSessionId(opts.resumeSessionId)] : []),
      ...(opts.resumeSessionId && opts.fork ? ['--fork-session'] : []),
      ...(opts.model ? ['--model', opts.model] : []),
      ...(mcpConfig ? ['--mcp-config', mcpConfig] : []),
      ...(opts.plugins ?? []).flatMap((dir) => ['--plugin-dir', dir]),
      ...(opts.appendSystemPrompt ? ['--append-system-prompt', opts.appendSystemPrompt] : []),
    ],
  };
}

// ---- Codex ---------------------------------------------------------------------------------------

/** TOML-safe literal: JSON strings and string arrays are valid TOML basic strings/arrays. */
const toml = (value: string | readonly string[]) => JSON.stringify(value);
/** Keys are checked (env names, header names) to be valid TOML bare keys. */
const tomlTable = (table: Readonly<Record<string, string>>) =>
  `{${Object.entries(table).map(([key, value]) => `${key}=${toml(value)}`).join(', ')}}`;

/** `-c` overrides that register stdio MCP servers for this run, auto-approving their tools. */
export function codexMcpArgs(servers: ManagedLaunch['mcpServers']): string[] {
  return Object.entries(servers ?? {}).flatMap(([name, server]) => {
    const envNames = [...Object.keys(server.env), ...(server.inheritEnv ?? [])];
    if (!SERVER_NAME.test(name) || !envNames.every((key) => ENV_NAME.test(key))) {
      throw new Error(`invalid MCP server config for "${name}"`);
    }
    const prefix = `mcp_servers.${name}`;
    return [
      '-c', `${prefix}.command=${toml(server.command)}`,
      '-c', `${prefix}.args=${toml(server.args)}`,
      '-c', `${prefix}.env=${tomlTable(server.env)}`,
      // Secrets travel in the codex process environment and are forwarded by name, never on argv.
      ...(server.inheritEnv?.length ? ['-c', `${prefix}.env_vars=${toml(server.inheritEnv)}`] : []),
      '-c', `${prefix}.default_tools_approval_mode="approve"`,
    ];
  });
}

/**
 * `-c` overrides for remote MCP servers. Codex speaks streamable HTTP only, so SSE servers are skipped
 * (the MCP catalog warns about them at launch). Header values come from `env_http_headers`.
 */
export function codexRemoteMcpArgs(servers: RemoteServers | undefined): string[] {
  const plan = remoteHeaderPlan(servers);
  return Object.entries(servers ?? {}).filter(([, server]) => server.type === 'http').flatMap(([name, server]) => {
    const prefix = `mcp_servers.${name}`;
    const vars = plan.vars[name] ?? {};
    return [
      '-c', `${prefix}.url=${toml(server.url)}`,
      ...(Object.keys(vars).length ? ['-c', `${prefix}.env_http_headers=${tomlTable(vars)}`] : []),
      '-c', `${prefix}.default_tools_approval_mode="approve"`,
    ];
  });
}

export function codexCliCommand(nodePath: string, entry: string, opts: {
  readonly resumeSessionId: string;
  /** `codex fork` (a new thread with the same history) instead of `codex resume`. */
  readonly fork?: boolean;
  readonly model?: string;
  readonly sandbox?: boolean;
  readonly mcpServers?: McpServers;
  /** Header values must be in the CLI's environment under `remoteHeaderPlan(...).env`. */
  readonly remoteMcpServers?: RemoteServers;
}): CliCommand {
  return {
    command: nodePath,
    args: [
      entry, opts.fork ? 'fork' : 'resume', checkedSessionId(opts.resumeSessionId),
      ...(opts.model ? ['-m', opts.model] : []),
      ...(opts.sandbox ? ['-c', 'sandbox_mode="workspace-write"'] : []),
      ...codexMcpArgs(opts.mcpServers),
      ...codexRemoteMcpArgs(opts.remoteMcpServers),
    ],
  };
}
