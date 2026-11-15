#!/usr/bin/env node
import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const BEGIN = '# BEGIN Waystation MCP (managed by Waystation)';
const END = '# END Waystation MCP';
export const bridge = fileURLToPath(new URL('../daemon/automation/waystation-mcp.mjs', import.meta.url));

/** Markers let upgrades touch only the block we own, leaving every other TOML byte alone. */
export function codexConfig(previous, command = process.execPath, script = bridge) {
  const block = `${BEGIN}\n[mcp_servers.waystation]\ncommand = ${JSON.stringify(command)}\nargs = [${JSON.stringify(script)}]\nstartup_timeout_sec = 30\n${END}`;
  const start = previous.indexOf(BEGIN), end = previous.indexOf(END);
  if (start >= 0 && end > start) return previous.slice(0, start) + block + previous.slice(end + END.length);
  if (start >= 0 || end >= 0) throw new Error('Incomplete Waystation MCP block in Codex config. Restore its backup before retrying.');
  if (/^\s*\[\s*(?:mcp_servers|["']mcp_servers["'])\s*\.\s*(?:waystation|["']waystation["'])\s*(?:\.|\])/m.test(previous)) throw new Error('Codex already has an unowned waystation MCP entry. Rename that entry before installing.');
  return `${previous}${previous.endsWith('\n') || !previous ? '' : '\n'}\n${block}\n`;
}

export function jsonConfig(previous, kind, command = process.execPath, script = bridge) {
  const data = previous.trim() ? JSON.parse(previous) : {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON configuration object.');
  const servers = data.mcpServers ?? {};
  if (typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Expected mcpServers to be an object.');
  const existing = servers.waystation;
  if (existing && !existing.args?.some(arg => typeof arg === 'string' && arg.replaceAll('\\', '/').endsWith('/daemon/automation/waystation-mcp.mjs'))) throw new Error('An unrelated MCP server already uses the name waystation. Rename it before installing.');
  data.mcpServers = { ...servers, waystation: { type: kind === 'copilot' ? 'local' : 'stdio', command, args: [script], ...(kind === 'copilot' ? { tools: ['*'] } : {}) } };
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function configure({ apply = false, home = homedir(), targets = ['codex', 'claude', 'copilot'] } = {}) {
  const files = {
    codex: join(process.env.CODEX_HOME ?? join(home, '.codex'), 'config.toml'),
    claude: process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json'),
    copilot: join(process.env.COPILOT_HOME ?? join(home, '.copilot'), 'mcp-config.json'),
  };
  // Prepare every result before changing any file. No token belongs in agent config.
  const changes = targets.map(target => {
    if (!Object.hasOwn(files, target)) throw new Error(`Unknown agent: ${target}`);
    const file = files[target];
    const previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
    return { target, file, previous, next: target === 'codex' ? codexConfig(previous) : jsonConfig(previous, target) };
  });
  for (const { target, file, previous, next } of changes) {
    if (next === previous) { console.log(`${target}: already configured (${file})`); continue; }
    if (!apply) { console.log(`${target}: would register waystation (${file})`); continue; }
    mkdirSync(dirname(file), { recursive: true });
    // Refuse to clobber a change made by a running agent while configuration was prepared.
    if ((existsSync(file) ? readFileSync(file, 'utf8') : '') !== previous) throw new Error(`${target} configuration changed. Retry installation.`);
    if (existsSync(file)) copyFileSync(file, `${file}.waystation-backup-${Date.now()}`);
    const temp = `${file}.waystation-${process.pid}.tmp`;
    writeFileSync(temp, next, { mode: 0o600, flag: 'wx' }); renameSync(temp, file);
    console.log(`${target}: configured waystation (${file})`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const agents = process.argv.find(arg => arg.startsWith('--agents='))?.slice(9).split(',');
    configure({ apply: process.argv.includes('--apply'), ...(agents ? { targets: agents } : {}) });
    if (!process.argv.includes('--apply')) console.log('Preview only. Pass --apply to save, then restart/reconnect your coding agents.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
