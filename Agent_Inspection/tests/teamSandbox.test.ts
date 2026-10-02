import { describe, expect, it } from 'vitest';
import { isInside, readViolation, writeViolation } from '../daemon/managed/writeGuard.ts';
import { codexArgs, codexMcpArgs } from '../daemon/managed/codexRunner.ts';
import type { ManagedLaunch } from '../daemon/managed/types.ts';
import { parseTeamInput, slug } from '../daemon/teams/teamInput.ts';
import { tempDir } from './helpers.ts';

const ROOT = 'C:\\tower\\teams\\abc\\api';

describe('write guard', () => {
  it('allows writes inside the worktree, including relative paths', () => {
    expect(isInside(ROOT, `${ROOT}\\src\\a.ts`)).toBe(true);
    expect(isInside(ROOT, 'src/a.ts')).toBe(true);
    expect(writeViolation('Write', { file_path: `${ROOT}\\x.ts` }, ROOT)).toBeUndefined();
  });

  it('denies file-writing tools that escape the worktree', () => {
    expect(writeViolation('Edit', { file_path: 'C:\\repo\\main.ts' }, ROOT)).toMatch(/only write inside its own worktree/);
    expect(writeViolation('Write', { file_path: '..\\ui\\x.ts' }, ROOT)).toBeDefined();
    expect(writeViolation('NotebookEdit', { notebook_path: 'D:\\n.ipynb' }, ROOT)).toBeDefined();
    expect(isInside(ROOT, `${ROOT}-evil\\x.ts`)).toBe(false);
  });

  it('denies agent and git configuration even inside the worktree', () => {
    expect(writeViolation('Write', { file_path: `${ROOT}\\.claude\\settings.json` }, ROOT)).toMatch(/agent or git configuration/);
    expect(writeViolation('Edit', { file_path: '.mcp.json' }, ROOT)).toBeDefined();
    expect(writeViolation('Write', { file_path: '.git/hooks/pre-commit' }, ROOT)).toBeDefined();
    expect(writeViolation('Write', { file_path: 'src/.claude-notes.md' }, ROOT)).toBeUndefined();
  });

  it('keeps file-reading tools out of the tower state, except the team folder', () => {
    const guard = { deny: 'C:\\tower', allow: 'C:\\tower\\teams\\abc' };
    expect(readViolation('Read', { file_path: 'C:\\tower\\daemon.json' }, ROOT, guard)).toMatch(/private state/);
    expect(readViolation('Read', { file_path: '..\\..\\..\\daemon.json' }, ROOT, guard)).toBeDefined();
    expect(readViolation('Grep', { path: 'C:\\tower\\teams\\abc\\ui' }, ROOT, guard)).toBeUndefined();
    expect(readViolation('Read', { file_path: 'C:\\repo\\a.ts' }, ROOT, guard)).toBeUndefined();
  });

  it('ignores tools that do not write files', () => {
    expect(writeViolation('Read', { file_path: 'C:\\elsewhere.ts' }, ROOT)).toBeUndefined();
    expect(writeViolation('Bash', { command: 'echo' }, ROOT)).toBeUndefined();
  });
});

describe('codex launch arguments', () => {
  const base: ManagedLaunch = { vendor: 'codex', cwd: ROOT, prompt: 'hi' };

  it('keeps plain launches unchanged', () => {
    expect(codexArgs('codex.js', base)).toEqual(['codex.js', 'exec', '--json', '--skip-git-repo-check', '-C', ROOT, '-']);
    expect(codexArgs('codex.js', base, 'thread-1')).toEqual(['codex.js', 'exec', 'resume', 'thread-1', '--json', '--skip-git-repo-check', '-']);
  });

  it('adds model, sandbox and the team MCP server for team members', () => {
    const args = codexArgs('codex.js', {
      ...base,
      model: 'gpt-5.5-codex',
      writeRoot: ROOT,
      env: { AGENT_TOWER_TEAM_TOKEN: 'secret-token' },
      mcpServers: {
        team: { command: 'C:\\node.exe', args: ['C:\\x\\team-mcp.mjs'], env: { AGENT_TOWER_TEAM_URL: 'http://127.0.0.1:1' }, inheritEnv: ['AGENT_TOWER_TEAM_TOKEN'] },
      },
    }, 'thread-1');
    expect(args).toEqual(expect.arrayContaining(['-m', 'gpt-5.5-codex', 'sandbox_mode="workspace-write"']));
    expect(args).toContain('mcp_servers.team.command="C:\\\\node.exe"');
    expect(args).toContain('mcp_servers.team.args=["C:\\\\x\\\\team-mcp.mjs"]');
    expect(args).toContain('mcp_servers.team.env={AGENT_TOWER_TEAM_URL="http://127.0.0.1:1"}');
    expect(args).toContain('mcp_servers.team.env_vars=["AGENT_TOWER_TEAM_TOKEN"]');
    expect(args.join(' ')).not.toContain('secret-token');
    expect(args).toContain('mcp_servers.team.default_tools_approval_mode="approve"');
    expect(args.at(-1)).toBe('-');
  });

  it('rejects server names or env keys that could inject TOML', () => {
    expect(() => codexMcpArgs({ 'bad.name': { command: 'x', args: [], env: {} } })).toThrow(/invalid MCP server config/);
    expect(() => codexMcpArgs({ team: { command: 'x', args: [], env: { 'A=1,B': 'x' } } })).toThrow(/invalid/);
  });
});

describe('team input', () => {
  const cwd = tempDir('team-input-');
  const members = [{ name: 'Lead', role: 'lead', vendor: 'claude' }, { name: 'api', vendor: 'codex', model: 'gpt-5.5' }];

  it('normalizes a valid request with defaults', () => {
    const input = parseTeamInput({ goal: 'Do it', cwd, members });
    expect(input).toMatchObject({ name: 'Team', maxWakes: 40, maxMinutes: 60, initGit: false });
    expect(input.members).toEqual([
      { name: 'lead', role: 'lead', vendor: 'claude', model: undefined },
      { name: 'api', role: 'worker', vendor: 'codex', model: 'gpt-5.5' },
    ]);
  });

  it.each([
    [{ goal: '', cwd, members }, /goal/],
    [{ goal: 'x', cwd: 'relative', members }, /absolute/],
    [{ goal: 'x', cwd, members: [members[0]] }, /2 to 6/],
    [{ goal: 'x', cwd, members: [members[1], { name: 'b', vendor: 'claude' }] }, /exactly one lead/],
    [{ goal: 'x', cwd, members: [members[0], { name: 'lead', vendor: 'claude' }] }, /unique/],
    [{ goal: 'x', cwd, members: [members[0], { name: 'all', vendor: 'claude' }] }, /reserved/],
    [{ goal: 'x', cwd, members: [members[0], { name: 'Bad Name', vendor: 'claude' }] }, /must start with a letter/],
    [{ goal: 'x', cwd, members: [members[0], { name: 'b', vendor: 'gemini' }] }, /vendor/],
    [{ goal: 'x', cwd, members: [members[0], { name: 'b', vendor: 'claude', model: 'x y' }] }, /model/],
    [{ goal: 'x', cwd, members, maxWakes: 0 }, /Wake-up budget/],
    [{ goal: 'x', cwd, members: [members[0], { name: 'b', vendor: 'codex', model: '-x' }] }, /model/],
  ])('rejects invalid input %#', (body, error) => {
    expect(() => parseTeamInput(body)).toThrow(error);
  });

  it('slugs team names for branch names', () => {
    expect(slug('Auth Refactor!!')).toBe('auth-refactor');
    expect(slug('***')).toBe('team');
  });
});
