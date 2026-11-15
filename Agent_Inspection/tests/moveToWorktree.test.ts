import { existsSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { moveToWorktree, type MoveDeps } from '../daemon/actions/moveToWorktree.ts';
import type { Agent } from '../daemon/domain/types.ts';
import { UserError } from '../daemon/userError.ts';
import { git, makeAgent, makeRepo, tempDir } from './helpers.ts';

function deps(agent: Agent | undefined, overrides: Partial<MoveDeps> = {}): MoveDeps {
  return {
    agent: () => agent,
    launch: vi.fn((raw: unknown) => makeAgent({ id: 'managed:moved', tier: 'A', cwd: (raw as { cwd: string }).cwd })),
    stopAgent: vi.fn(async () => undefined),
    handoffContext: () => 'Recent activity:\n- [tool_call] Edit: src/a.ts',
    audit: vi.fn(),
    ...overrides,
  };
}

describe('moveToWorktree', () => {
  it('creates a branch worktree, continues the task there and stops the original', async () => {
    const repo = makeRepo();
    const agent = makeAgent({ id: 'claude:x', name: 'Pip: fix login', cwd: repo, vendor: 'claude', tier: 'B' });
    const d = deps(agent);
    const result = await moveToWorktree(d, agent.id, Date.UTC(2026, 10, 14));
    expect(result.worktree.branch).toMatch(/^waystation\/pip-fix-login-[a-z0-9]+$/);
    expect(existsSync(result.worktree.path)).toBe(true);
    expect(git(repo, 'branch', '--list', result.worktree.branch!)).toContain(result.worktree.branch);
    const launch = vi.mocked(d.launch).mock.calls[0][0] as { cwd: string; prompt: string; vendor: string; name: string };
    expect(launch).toMatchObject({ cwd: result.worktree.path, vendor: 'claude' });
    expect(launch.prompt).toMatch(/separate git worktree/);
    expect(launch.prompt).toMatch(/uncommitted/);
    expect(launch.prompt).toContain('Recent activity');
    expect(d.stopAgent).toHaveBeenCalledWith('claude:x');
    expect(result.warning).toBeUndefined();
  });

  it('keeps the agent\'s subfolder inside the new worktree', async () => {
    const repo = makeRepo();
    const sub = join(repo, 'packages', 'web');
    mkdirSync(sub, { recursive: true });
    const agent = makeAgent({ cwd: sub, name: 'Mica' });
    const d = deps(agent);
    const result = await moveToWorktree(d, agent.id);
    const launch = vi.mocked(d.launch).mock.calls[0][0] as { cwd: string };
    expect(relative(result.worktree.path, launch.cwd)).toBe(join('packages', 'web'));
  });

  it('launches observe-only vendors as a Claude agent and reports a stop it could not do', async () => {
    const repo = makeRepo();
    const agent = makeAgent({ vendor: 'other', cwd: repo, stopBlockedReason: 'Editor-hosted thread' });
    const d = deps(agent);
    const result = await moveToWorktree(d, agent.id);
    expect(vi.mocked(d.launch).mock.calls[0][0]).toMatchObject({ vendor: 'claude' });
    expect(d.stopAgent).not.toHaveBeenCalled();
    expect(result.warning).toMatch(/Editor-hosted thread/);
  });

  it('explains why it cannot move an agent', async () => {
    await expect(moveToWorktree(deps(undefined), 'gone')).rejects.toThrow(UserError);
    await expect(moveToWorktree(deps(makeAgent({ cwd: undefined })), 'x')).rejects.toThrow(/project folder/);
    await expect(moveToWorktree(deps(makeAgent({ cwd: tempDir() })), 'x')).rejects.toThrow(UserError);
  });
});
