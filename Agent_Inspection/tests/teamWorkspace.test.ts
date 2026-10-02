import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createWorktree, diffWorktree, inspectRepo, mergeMember, prepareRepo, protectedPaths, removeWorktree, snapshotWorktree,
} from '../daemon/teams/workspace.ts';
import { GIT_TEST_IDENTITY, git, makeRepo, tempDir } from './helpers.ts';

/** core.autocrlf may rewrite line endings on checkout; compare content, not newline style. */
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('prepareRepo', () => {
  it('uses an existing repo as-is', async () => {
    const repo = makeRepo();
    const prepared = await prepareRepo(repo, { initGit: false });
    expect(prepared.branch).toBe('main');
    expect(prepared.head).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(prepared.notes).toEqual([]);
  });

  it('refuses a plain folder unless asked to set up git', async () => {
    const dir = tempDir('team-plain-');
    writeFileSync(join(dir, 'a.txt'), 'x');
    await expect(prepareRepo(dir, { initGit: false })).rejects.toThrow(/not a git repository|inside a larger git repository/);
    const prepared = await prepareRepo(dir, { initGit: true });
    expect(prepared.notes[0]).toMatch(/Created a git repository/);
    expect(git(dir, 'ls-files')).toBe('a.txt');
  });

  it('refuses a subfolder of a bigger repo instead of branching the whole thing', async () => {
    const repo = makeRepo();
    const sub = join(repo, 'packages', 'web');
    mkdirSync(sub, { recursive: true });
    await expect(prepareRepo(sub, { initGit: false })).rejects.toThrow(/inside a larger git repository/);
    expect((await inspectRepo(sub)).isRepoRoot).toBe(false);
  });

  it('warns that uncommitted edits are not copied to worktrees', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'app.txt'), 'edited\n');
    expect((await prepareRepo(repo, { initGit: false })).notes[0]).toMatch(/uncommitted changes/);
  });
});

describe('worktrees, diff and merge', () => {
  async function setup() {
    const repo = makeRepo();
    const head = git(repo, 'rev-parse', 'HEAD');
    const wt = join(tempDir('team-wt-'), 'api');
    await createWorktree(repo, wt, 'team/t-1/api', head);
    return { repo, head, wt };
  }

  it('gives each member an isolated checkout on its own branch', async () => {
    const { repo, wt } = await setup();
    expect(read(join(wt, 'app.txt'))).toBe('hello\n');
    writeFileSync(join(wt, 'app.txt'), 'changed in worktree\n');
    expect(read(join(repo, 'app.txt'))).toBe('hello\n');
    expect(git(wt, 'branch', '--show-current')).toBe('team/t-1/api');
  });

  it('diffs committed, modified and new files against the team base', async () => {
    const { head, wt } = await setup();
    writeFileSync(join(wt, 'app.txt'), 'changed\n');
    writeFileSync(join(wt, 'new.txt'), 'brand new\n');
    const diff = await diffWorktree(wt, head);
    expect(diff.stat).toMatch(/app\.txt/);
    expect(diff.stat).toMatch(/new\.txt/);
    expect(diff.patch).toContain('+brand new');
    expect(diff.truncated).toBe(false);
  });

  it('snapshots and merges a member branch into the base branch', async () => {
    const { repo, wt } = await setup();
    writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    const result = await mergeMember({ root: repo, baseBranch: 'main', branch: 'team/t-1/api', worktree: wt, memberName: 'api' });
    expect(result.commits).toBe(1);
    expect(read(join(repo, 'feature.txt'))).toBe('feature\n');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Merge team/t-1/api (team member api)');
    expect(git(repo, 'log', '-1', '--format=%an', 'team/t-1/api')).toBe('api (Agent Tower)');
  });

  it('refuses to merge onto the wrong branch, a dirty checkout, or with nothing to merge', async () => {
    const { repo, wt } = await setup();
    const opts = { root: repo, baseBranch: 'main', branch: 'team/t-1/api', worktree: wt, memberName: 'api' };
    await expect(mergeMember(opts)).rejects.toThrow(/no changes to merge/);
    writeFileSync(join(wt, 'x.txt'), 'x');
    writeFileSync(join(repo, 'app.txt'), 'dirty\n');
    await expect(mergeMember(opts)).rejects.toThrow(/uncommitted changes/);
    git(repo, 'checkout', '--', 'app.txt');
    git(repo, 'checkout', '-b', 'other');
    await expect(mergeMember(opts)).rejects.toThrow(/not "main"/);
  });

  it('aborts cleanly on a conflict and leaves the project untouched', async () => {
    const { repo, wt } = await setup();
    writeFileSync(join(wt, 'app.txt'), 'from the agent\n');
    writeFileSync(join(repo, 'app.txt'), 'from the human\n');
    git(repo, ...GIT_TEST_IDENTITY, 'commit', '-am', 'human edit');
    const before = git(repo, 'rev-parse', 'HEAD');
    await expect(mergeMember({ root: repo, baseBranch: 'main', branch: 'team/t-1/api', worktree: wt, memberName: 'api' }))
      .rejects.toThrow(/Merge conflict in app\.txt/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('never auto-merges agent, editor or git configuration', async () => {
    const { repo, wt } = await setup();
    mkdirSync(join(wt, '.claude'), { recursive: true });
    writeFileSync(join(wt, '.claude', 'settings.json'), '{"hooks":{}}');
    writeFileSync(join(wt, 'feature.txt'), 'ok\n');
    const before = git(repo, 'rev-parse', 'HEAD');
    await expect(mergeMember({ root: repo, baseBranch: 'main', branch: 'team/t-1/api', worktree: wt, memberName: 'api' }))
      .rejects.toThrow(/\.claude\/settings\.json.*never merged automatically/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(protectedPaths(['src/a.ts', 'CLAUDE.md', 'pkg/.mcp.json', '.gitattributes'])).toEqual(['CLAUDE.md', 'pkg/.mcp.json', '.gitattributes']);
  });

  it('ignores git hooks planted in the shared repo when committing and merging', async () => {
    const { repo, wt } = await setup();
    const hooks = join(repo, '.git', 'hooks');
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    writeFileSync(join(hooks, 'pre-merge-commit'), '#!/bin/sh\nexit 1\n');
    writeFileSync(join(wt, 'feature.txt'), 'ok\n');
    await expect(mergeMember({ root: repo, baseBranch: 'main', branch: 'team/t-1/api', worktree: wt, memberName: 'api' }))
      .resolves.toEqual({ commits: 1 });
  });

  it('snapshot reports when there is nothing to commit', async () => {
    const { wt } = await setup();
    expect(await snapshotWorktree(wt, 'api', 'nothing')).toBe(false);
  });

  it('removes worktrees but keeps the branch', async () => {
    const { repo, wt } = await setup();
    await removeWorktree(repo, wt);
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, 'branch', '--list', 'team/t-1/api')).toContain('team/t-1/api');
  });
});
