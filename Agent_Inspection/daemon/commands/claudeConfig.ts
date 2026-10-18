import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Read-only views of Claude Code's own configuration, for sessions Waystation did not launch (it cannot ask them).
 * Only names, scopes and transport types leave this module: never commands, arguments, env or headers.
 */

export interface ConfiguredMcpServer {
  readonly name: string;
  readonly scope: 'user' | 'local' | 'project';
  readonly transport: string;
}

export interface MemoryFile {
  readonly label: string;
  readonly path: string;
  readonly bytes: number;
  readonly modifiedAt: number;
}

/** Files bigger than this are not parsed (a corrupt or unusual config should not stall a command). */
const MAX_CONFIG_BYTES = 20 * 1024 * 1024;

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;

async function readJson(file: string): Promise<Json | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return undefined;
    return asRecord(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return undefined;
  }
}

const normalPath = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function servers(block: unknown, scope: ConfiguredMcpServer['scope']): ConfiguredMcpServer[] {
  return Object.entries(asRecord(block) ?? {}).map(([name, raw]) => {
    const entry = asRecord(raw) ?? {};
    const transport = typeof entry.type === 'string' ? entry.type : typeof entry.url === 'string' ? 'http' : 'stdio';
    return { name, scope, transport };
  });
}

/** User and local servers from ~/.claude.json, project servers from <cwd>/.mcp.json. Plugin servers are not listed. */
export async function configuredMcpServers(userConfigFile: string, cwd: string | undefined): Promise<ConfiguredMcpServer[]> {
  const user = await readJson(userConfigFile);
  const projects = asRecord(user?.projects) ?? {};
  const local = cwd ? Object.entries(projects).find(([path]) => normalPath(path) === normalPath(cwd))?.[1] : undefined;
  const project = cwd ? await readJson(join(cwd, '.mcp.json')) : undefined;
  return [...servers(user?.mcpServers, 'user'), ...servers(asRecord(local)?.mcpServers, 'local'), ...servers(project?.mcpServers, 'project')];
}

/** The CLAUDE.md files Claude Code loads for this folder (only those that exist). */
export async function memoryFiles(claudeHome: string, cwd: string | undefined): Promise<MemoryFile[]> {
  const candidates: Array<readonly [string, string]> = [
    ['User memory', join(claudeHome, 'CLAUDE.md')],
    ...(cwd ? [
      ['Project memory', join(cwd, 'CLAUDE.md')] as const,
      ['Project memory', join(cwd, '.claude', 'CLAUDE.md')] as const,
      ['Local memory', join(cwd, 'CLAUDE.local.md')] as const,
    ] : []),
  ];
  const found = await Promise.all(candidates.map(async ([label, path]): Promise<MemoryFile | undefined> => {
    const info = await stat(path).catch(() => undefined);
    return info?.isFile() ? { label, path, bytes: info.size, modifiedAt: info.mtimeMs } : undefined;
  }));
  return found.filter((file): file is MemoryFile => file !== undefined);
}

/** Subagent definitions (.md files) in ~/.claude/agents and <cwd>/.claude/agents. */
export async function agentDefinitions(claudeHome: string, cwd: string | undefined): Promise<Array<{ name: string; scope: 'user' | 'project' }>> {
  const list = async (dir: string, scope: 'user' | 'project') =>
    (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.md')).map((name) => ({ name: name.slice(0, -3), scope }));
  return [...await list(join(claudeHome, 'agents'), 'user'), ...(cwd ? await list(join(cwd, '.claude', 'agents'), 'project') : [])];
}
