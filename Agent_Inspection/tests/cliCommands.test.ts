import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claudeCliCommand, claudeMcpConfig, codexCliCommand, isNativeExe, resolveClaudeExe,
} from '../daemon/managed/cliCommands.ts';

describe('isNativeExe', () => {
  it('rejects the placeholder npm leaves when postinstall did not run, and missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-exe-'));
    try {
      const stub = join(dir, 'stub.exe');
      const real = join(dir, 'real.exe');
      writeFileSync(stub, 'echo "Error: claude native binary not installed." >&2\n');
      writeFileSync(real, Buffer.alloc(2 * 1024 * 1024));
      expect(isNativeExe(stub)).toBe(false);
      expect(isNativeExe(real)).toBe(true);
      expect(isNativeExe(join(dir, 'missing.exe'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const TEAM_SERVERS = {
  team: { command: 'node.exe', args: ['team-mcp.mjs'], env: { AGENT_TOWER_TEAM_URL: 'http://127.0.0.1:4317' }, inheritEnv: ['AGENT_TOWER_TEAM_TOKEN'] },
};

describe('resolveClaudeExe', () => {
  const npmExe = join('C:\\Users\\me\\AppData\\Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

  it('prefers an explicit override, then the npm install, then PATH', () => {
    const exists = (path: string) => [npmExe, 'D:\\tools\\claude.exe', 'C:\\custom\\claude.exe'].includes(path);
    expect(resolveClaudeExe({ AGENT_TOWER_CLAUDE_EXE: 'C:\\custom\\claude.exe', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, exists)).toBe('C:\\custom\\claude.exe');
    expect(resolveClaudeExe({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, exists)).toBe(npmExe);
    expect(resolveClaudeExe({ PATH: 'C:\\nothing;D:\\tools' }, exists)).toBe('D:\\tools\\claude.exe');
  });

  it('returns undefined when Claude Code is not installed', () => {
    expect(resolveClaudeExe({ PATH: 'C:\\nothing' }, () => false)).toBeUndefined();
  });
});

describe('claudeCliCommand', () => {
  it('resumes a session with its model, team tools and standing instructions', () => {
    const command = claudeCliCommand('C:\\bin\\claude.exe', {
      resumeSessionId: '6f1c2b9e-1111-2222-3333-444455556666',
      model: 'claude-haiku-4-5',
      mcpConfig: claudeMcpConfig(TEAM_SERVERS),
      appendSystemPrompt: 'You are "lead"; use the team tools.',
    });
    expect(command.command).toBe('C:\\bin\\claude.exe');
    expect(command.args).toEqual([
      '--resume', '6f1c2b9e-1111-2222-3333-444455556666',
      '--model', 'claude-haiku-4-5',
      '--mcp-config', JSON.stringify(claudeMcpConfig(TEAM_SERVERS)),
      '--append-system-prompt', 'You are "lead"; use the team tools.',
    ]);
  });

  it('opens a copy of a session that is still running elsewhere', () => {
    expect(claudeCliCommand('claude.exe', { resumeSessionId: 'abc-123', fork: true }).args).toEqual(['--resume', 'abc-123', '--fork-session']);
  });

  it('starts a fresh session when nothing is resumed', () => {
    expect(claudeCliCommand('claude.exe', {}).args).toEqual([]);
  });

  it('refuses a session id that would read as a flag', () => {
    expect(() => claudeCliCommand('claude.exe', { resumeSessionId: '--dangerously-skip-permissions' })).toThrow(/session id/);
  });
});

describe('claudeMcpConfig', () => {
  it('forwards secrets as ${VAR} placeholders that Claude Code expands from its own environment', () => {
    expect(claudeMcpConfig(TEAM_SERVERS)).toEqual({
      mcpServers: {
        team: {
          type: 'stdio',
          command: 'node.exe',
          args: ['team-mcp.mjs'],
          env: { AGENT_TOWER_TEAM_URL: 'http://127.0.0.1:4317', AGENT_TOWER_TEAM_TOKEN: '${AGENT_TOWER_TEAM_TOKEN}' },
        },
      },
    });
  });
});

describe('codexCliCommand', () => {
  it('resumes the thread in the interactive CLI with the sandbox and team tools', () => {
    const command = codexCliCommand('C:\\node\\node.exe', 'C:\\npm\\codex.js', {
      resumeSessionId: '0199aaaa-bbbb-cccc-dddd-eeeeffff0000', model: 'gpt-5.5-codex', sandbox: true, mcpServers: TEAM_SERVERS,
    });
    expect(command.command).toBe('C:\\node\\node.exe');
    expect(command.args.slice(0, 8)).toEqual([
      'C:\\npm\\codex.js', 'resume', '0199aaaa-bbbb-cccc-dddd-eeeeffff0000', '-m', 'gpt-5.5-codex', '-c', 'sandbox_mode="workspace-write"', '-c',
    ]);
    expect(command.args).toContain('mcp_servers.team.env_vars=["AGENT_TOWER_TEAM_TOKEN"]');
  });

  it('forks a thread that is still open in another app', () => {
    expect(codexCliCommand('node.exe', 'codex.js', { resumeSessionId: 'abc-123', fork: true }).args).toEqual(['codex.js', 'fork', 'abc-123']);
  });
});
