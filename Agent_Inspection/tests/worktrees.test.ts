import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addWorktree, listWorktrees, parseWorktrees } from '../daemon/git/worktrees.ts';
import { git, makeRepo, tempDir } from './helpers.ts';

describe('operator Git worktrees', () => {
  it('parses unquoted paths, detached heads, locks, missing and bare worktrees', () => {
    expect(parseWorktrees('worktree /repo with spaces\0HEAD abc\0branch refs/heads/main\0\0worktree /tab\tand\nnewline\0HEAD def\0detached\0locked operator reason\0prunable missing folder\0\0worktree /bare\0bare\0\0'))
      .toEqual([
        { path: '/repo with spaces', head: 'abc', branch: 'main', main: true, bare: false, detached: false },
        { path: '/tab\tand\nnewline', head: 'def', main: false, bare: false, detached: true, locked: 'operator reason', prunable: 'missing folder' },
        { path: '/bare', main: false, bare: true, detached: false },
      ]);
  });

  it('creates from the selected commit without copying or changing uncommitted work', async () => {
    const root = makeRepo();
    const path = join(tempDir('worktree destinations '), 'feature with spaces');
    writeFileSync(join(root, 'app.txt'), 'uncommitted edits');
    writeFileSync(join(root, 'untracked.txt'), 'untracked');
    const before = git(root, 'status', '--porcelain');
    const result = await addWorktree({ root, path, branch: 'feature/search', mode: 'new', base: 'main' });
    expect(resolve(result.worktree.path)).toBe(resolve(path));
    expect(git(path, 'branch', '--show-current')).toBe('feature/search');
    expect(readFileSync(join(path, 'app.txt'), 'utf8').trim()).toBe('hello');
    expect(existsSync(join(path, 'untracked.txt'))).toBe(false);
    expect(git(root, 'status', '--porcelain')).toBe(before);
    const listing = await listWorktrees(path);
    expect(listing.worktrees).toEqual(expect.arrayContaining([expect.objectContaining({ branch: 'feature/search', main: false })]));
    expect((await listWorktrees(root)).dirty).toBe(true);
  });

  it('discovers the enclosing repository from a subfolder and adds an existing branch', async () => {
    const root = makeRepo();
    const sub = join(root, 'src'); mkdirSync(sub);
    git(root, 'branch', 'existing');
    const listing = await listWorktrees(sub);
    expect(resolve(listing.root)).toBe(resolve(root));
    expect(listing.branches).toContain('existing');
    const result = await addWorktree({ root: sub, branch: 'existing', mode: 'existing' });
    expect(dirname(result.worktree.path)).toBe(dirname(listing.root));
    expect(basename(result.worktree.path)).toBe(`${basename(root)}--existing`);
    expect(git(result.worktree.path, 'branch', '--show-current')).toBe('existing');
  });

  it('leaves an existing folder and checked-out branches alone', async () => {
    const root = makeRepo();
    const path = tempDir('worktree-occupied-');
    writeFileSync(join(path, 'keep.txt'), 'keep');
    await expect(addWorktree({ root, path, branch: 'main', mode: 'existing' })).rejects.toThrow(/already checked out/);
    await expect(addWorktree({ root, path, branch: 'feature/occupied', mode: 'new' })).rejects.toThrow(/already exists/);
    expect(readFileSync(join(path, 'keep.txt'), 'utf8')).toBe('keep');
    expect(git(root, 'branch', '--list', 'feature/occupied')).toBe('');
  });

  it('rejects invalid names, refs, paths and modes before creating a branch', async () => {
    const root = makeRepo();
    const path = join(tempDir(), 'new-worktree');
    for (const branch of ['--force', 'HEAD', 'bad..name', 'bad branch', 'bad\nname']) {
      await expect(addWorktree({ root, path, branch, mode: 'new' })).rejects.toThrow();
    }
    for (const extra of [
      { base: '--help' }, { path: 'relative/path' }, { path: join(root, '.git', 'worktree') },
      { mode: 'force' }, { mode: 'existing' }, { base: 'missing' },
    ]) await expect(addWorktree({ root, path, branch: 'feature/invalid', mode: 'new', ...extra })).rejects.toThrow();
    expect(git(root, 'branch', '--list', 'feature/invalid')).toBe('');
    expect(existsSync(path)).toBe(false);
  });

  it('rejects an invalid folder and does not commit an unborn repository', async () => {
    const plain = tempDir();
    await expect(listWorktrees('relative')).rejects.toThrow(/full path/);
    expect(existsSync(join(plain, '.git'))).toBe(false);
    git(plain, 'init', '-b', 'main');
    expect((await listWorktrees(plain)).hasCommits).toBe(false);
    await expect(addWorktree({ root: plain, branch: 'new', mode: 'new' })).rejects.toThrow(/at least once/);
    expect(git(plain, 'branch', '--list')).toBe('');
  });
});
