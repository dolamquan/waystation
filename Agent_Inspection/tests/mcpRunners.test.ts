import { describe, expect, it } from 'vitest';
import { claudeSdkMcp, sdkPlugins } from '../daemon/managed/claudeRunner.ts';
import { claudeCliCommand, claudeMcpConfig, codexCliCommand, codexRemoteMcpArgs, remoteHeaderPlan } from '../daemon/managed/cliCommands.ts';
import { codexArgs, codexEnv } from '../daemon/managed/codexRunner.ts';
import type { ManagedLaunch } from '../daemon/managed/types.ts';

const SECRET = 'Bearer ghp_topsecret';
const LAUNCH: ManagedLaunch = {
  vendor: 'claude',
  cwd: 'C:\\work',
  prompt: 'go',
  env: { CTX_KEY: 'k1' },
  mcpServers: {
    team: { command: 'node', args: ['team.mjs'], env: {}, inheritEnv: ['TEAM_TOKEN'] },
    ctx: { command: 'cmd', args: ['/c', 'npx', '-y', 'pkg'], env: { MODE: 'x' }, inheritEnv: ['CTX_KEY'] },
  },
  remoteMcpServers: {
    github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: SECRET } },
    legacy: { type: 'sse', url: 'https://x.test/sse' },
  },
  plugins: ['C:\\plugins\\a', 'C:\\plugins\\a', 'C:\\plugins\\b'],
};

describe('remoteHeaderPlan', () => {
  it('moves each header value into its own environment variable', () => {
    const plan = remoteHeaderPlan(LAUNCH.remoteMcpServers);
    expect(plan.vars).toEqual({ github: { Authorization: 'WAYSTATION_MCP_H0_0' }, legacy: {} });
    expect(plan.env).toEqual({ WAYSTATION_MCP_H0_0: SECRET });
  });

  it('refuses names that could break the config', () => {
    expect(() => remoteHeaderPlan({ 'a.b': { type: 'http', url: 'https://x' } })).toThrow();
    expect(() => remoteHeaderPlan({ a: { type: 'http', url: 'https://x', headers: { 'X Bad': 'v' } } })).toThrow();
  });
});

describe('claudeSdkMcp', () => {
  it('keeps secrets off the command line and alwaysLoad for the team bridge only', () => {
    const mcp = claudeSdkMcp(LAUNCH);
    expect(JSON.stringify(mcp.mcpServers)).not.toContain('topsecret');
    expect(mcp.env).toEqual({ WAYSTATION_MCP_H0_0: SECRET });
    expect(mcp.mcpServers?.team).toMatchObject({ alwaysLoad: true, env: { TEAM_TOKEN: '${TEAM_TOKEN}' } });
    expect(mcp.mcpServers?.ctx).toEqual({ type: 'stdio', command: 'cmd', args: ['/c', 'npx', '-y', 'pkg'], env: { MODE: 'x', CTX_KEY: '${CTX_KEY}' } });
    expect(mcp.mcpServers?.github).toEqual({ type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: '${WAYSTATION_MCP_H0_0}' } });
    expect(mcp.mcpServers?.legacy).toEqual({ type: 'sse', url: 'https://x.test/sse' });
  });

  it('returns no servers for a plain launch', () => {
    expect(claudeSdkMcp({})).toEqual({ mcpServers: undefined, env: {} });
  });

  it('maps plugin dirs to local SDK plugins, once each', () => {
    expect(sdkPlugins(LAUNCH.plugins)).toEqual([{ type: 'local', path: 'C:\\plugins\\a' }, { type: 'local', path: 'C:\\plugins\\b' }]);
    expect(sdkPlugins([])).toBeUndefined();
  });
});

describe('codex remote MCP', () => {
  it('registers streamable HTTP servers with env_http_headers and skips SSE', () => {
    const args = codexRemoteMcpArgs(LAUNCH.remoteMcpServers);
    expect(args).toEqual([
      '-c', 'mcp_servers.github.url="https://api.githubcopilot.com/mcp/"',
      '-c', 'mcp_servers.github.env_http_headers={Authorization="WAYSTATION_MCP_H0_0"}',
      '-c', 'mcp_servers.github.default_tools_approval_mode="approve"',
    ]);
    expect(args.join(' ')).not.toContain('legacy');
  });

  it('puts the header values in the codex environment, never in its args', () => {
    const launch = { ...LAUNCH, vendor: 'codex' as const };
    expect(codexArgs('codex.js', launch).join(' ')).not.toContain('topsecret');
    expect(codexEnv(launch, {})).toMatchObject({ WAYSTATION_MCP_H0_0: SECRET, CTX_KEY: 'k1' });
  });
});

describe('CLI hand-off', () => {
  it('passes plugin dirs to Claude Code', () => {
    expect(claudeCliCommand('claude.exe', { plugins: ['C:\\p\\a', 'C:\\p\\b'] }).args).toEqual(['--plugin-dir', 'C:\\p\\a', '--plugin-dir', 'C:\\p\\b']);
  });

  it('writes remote servers into the private MCP config, inline or as placeholders', () => {
    const remote = { github: LAUNCH.remoteMcpServers!.github };
    expect(claudeMcpConfig({}, {}, remote, true).mcpServers.github).toEqual({ type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: SECRET } });
    expect(claudeMcpConfig({}, {}, remote).mcpServers.github).toEqual({ type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: '${WAYSTATION_MCP_H0_0}' } });
  });

  it('carries remote servers into the Codex resume command', () => {
    const command = codexCliCommand('node', 'codex.js', { resumeSessionId: 'abc', remoteMcpServers: LAUNCH.remoteMcpServers });
    expect(command.args).toContain('mcp_servers.github.url="https://api.githubcopilot.com/mcp/"');
    expect(command.args.join(' ')).not.toContain('topsecret');
  });
});
