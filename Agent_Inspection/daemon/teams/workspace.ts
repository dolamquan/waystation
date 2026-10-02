import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Git worktree sandboxes: one branch + folder per team member, merged back only by the operator. */

export class WorkspaceError extends Error {}

const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
export const MAX_DIFF_CHARS = 200_000;
const FALLBACK_IDENTITY = ['-c', 'user.name=Agent Tower', '-c', 'user.email=agent-tower@localhost'];

/**
 * Worktrees share the repo's .git/config, which a member with a shell can edit. These overrides stop the
 * tower's own git calls (status, add, diff, commit, merge) from running agent-chosen fsmonitor or hook programs.
 */
const SAFE_GIT_CONFIG = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${join(tmpdir(), 'agent-tower-no-git-hooks')}`];
const SAFE_DIFF = ['--no-ext-diff', '--no-textconv'];

/** Paths that configure agents, editors or git for whoever opens the repo next: never merged automatically. */
const PROTECTED_PATHS: readonly RegExp[] = [
  /^\.(claude|codex|cursor|vscode|githooks|husky)\//i,
  /(^|\/)\.mcp\.json$/i,
  /(^|\/)\.git(attributes|modules)$/i,
  /(^|\/)(CLAUDE|AGENTS)\.md$/i,
];

export function protectedPaths(files: readonly string[]): string[] {
  return files.filter((file) => PROTECTED_PATHS.some((pattern) => pattern.test(file.replace(/\\/g, '/'))));
}

interface GitResult { readonly code: number; readonly stdout: string; readonly stderr: string }

function run(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((done) => {
    execFile('git', [...SAFE_GIT_CONFIG, ...args], { cwd, windowsHide: true, maxBuffer: MAX_GIT_OUTPUT }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : '')) });
    });
  });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await run(cwd, args);
  if (result.code !== 0) throw new WorkspaceError(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}

const normalizePath = (p: string) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
export const samePath = (a: string, b: string) => normalizePath(a) === normalizePath(b);

export interface RepoInfo {
  /** The folder is itself the top of a git repository (not a subfolder of a bigger one). */
  readonly isRepoRoot: boolean;
  /** Top of the enclosing repository, when there is one. */
  readonly enclosingRoot?: string;
  readonly hasCommits: boolean;
  readonly branch?: string;
  readonly head?: string;
  readonly dirty: boolean;
}

export async function inspectRepo(dir: string): Promise<RepoInfo> {
  const top = await run(dir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { isRepoRoot: false, hasCommits: false, dirty: false };
  const enclosingRoot = top.stdout.trim();
  const isRepoRoot = samePath(enclosingRoot, dir);
  if (!isRepoRoot) return { isRepoRoot, enclosingRoot, hasCommits: false, dirty: false };
  const head = await run(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const branch = await run(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const status = await run(dir, ['status', '--porcelain', '--untracked-files=no']);
  return {
    isRepoRoot,
    enclosingRoot,
    hasCommits: head.code === 0,
    head: head.code === 0 ? head.stdout.trim() : undefined,
    branch: branch.code === 0 ? branch.stdout.trim() : undefined,
    dirty: status.stdout.trim().length > 0,
  };
}

/** `-c user.*` overrides, only when the repo has no identity configured. */
async function identityArgs(cwd: string): Promise<string[]> {
  const email = await run(cwd, ['config', 'user.email']);
  return email.code === 0 && email.stdout.trim() ? [] : FALLBACK_IDENTITY;
}

export interface PreparedRepo {
  readonly root: string;
  readonly branch: string;
  readonly head: string;
  /** Human-readable notes about what was done or should be known. */
  readonly notes: readonly string[];
}

/**
 * Make sure `dir` is its own git repository with at least one commit on a branch.
 * Worktrees only contain committed files, so uncommitted edits are reported, not copied.
 */
export async function prepareRepo(dir: string, opts: { initGit: boolean }): Promise<PreparedRepo> {
  const info = await inspectRepo(dir);
  const notes: string[] = [];
  if (!info.isRepoRoot || !info.hasCommits) {
    if (!opts.initGit) {
      const why = !info.isRepoRoot
        ? info.enclosingRoot
          ? `This folder is inside a larger git repository (${info.enclosingRoot}), so team branches would cover that whole repository.`
          : 'This folder is not a git repository.'
        : 'This repository has no commits yet.';
      throw new WorkspaceError(`${why} Teams work on git branches; tick "Set up git for this folder" to create a repository here with an initial commit of the current files.`);
    }
    if (!info.isRepoRoot) await git(dir, ['init']);
    await git(dir, ['add', '-A']);
    const staged = await run(dir, ['diff', '--cached', '--quiet']);
    await git(dir, [...(await identityArgs(dir)), 'commit', ...(staged.code === 0 ? ['--allow-empty'] : []), '-m', 'Initial commit (Agent Tower team setup)']);
    notes.push('Created a git repository here and committed the current files.');
  }
  const ready = await inspectRepo(dir);
  if (!ready.branch || !ready.head) throw new WorkspaceError('The repository is in a detached HEAD state. Check out a branch first.');
  if (ready.dirty) notes.push('The project has uncommitted changes. Teammates start from the last commit and will not see them.');
  return { root: dir, branch: ready.branch, head: ready.head, notes };
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  return (await run(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
}

export async function createWorktree(root: string, path: string, branch: string, baseCommit: string): Promise<void> {
  if (existsSync(path)) throw new WorkspaceError(`worktree folder already exists: ${path}`);
  await git(root, ['worktree', 'add', '-b', branch, path, baseCommit]);
}

/** Commit everything in a member's worktree. Returns false when there was nothing to commit. */
export async function snapshotWorktree(worktree: string, author: string, message: string): Promise<boolean> {
  if (!existsSync(worktree)) throw new WorkspaceError('this member\'s worktree no longer exists');
  await git(worktree, ['add', '-A']);
  const staged = await run(worktree, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return false;
  const name = `${author} (Agent Tower)`.replace(/[<>\n]/g, '');
  await git(worktree, ['-c', `user.name=${name}`, '-c', 'user.email=agent-tower@localhost', 'commit', '--no-verify', '-m', message]);
  return true;
}

export interface MemberDiff {
  readonly stat: string;
  readonly patch: string;
  readonly truncated: boolean;
}

/** Everything a member changed since the team started: commits plus uncommitted edits and new files. */
export async function diffWorktree(worktree: string, baseCommit: string): Promise<MemberDiff> {
  if (!existsSync(worktree)) throw new WorkspaceError('this member\'s worktree no longer exists');
  await git(worktree, ['add', '-A', '-N']);
  const stat = await git(worktree, ['diff', ...SAFE_DIFF, '--stat', baseCommit]);
  const patch = await git(worktree, ['diff', ...SAFE_DIFF, baseCommit]);
  const truncated = patch.length > MAX_DIFF_CHARS;
  return { stat, patch: truncated ? patch.slice(0, MAX_DIFF_CHARS) : patch, truncated };
}

/**
 * Snapshot the member's worktree, then merge its branch into the base branch of the main checkout.
 * Refuses when the main checkout is on another branch or has uncommitted tracked changes; aborts cleanly on conflicts.
 */
export async function mergeMember(
  opts: { root: string; baseBranch: string; branch: string; worktree?: string; memberName: string },
): Promise<{ commits: number }> {
  const { root, baseBranch, branch, worktree, memberName } = opts;
  if (worktree && existsSync(worktree)) await snapshotWorktree(worktree, memberName, `${memberName}: work in progress`);
  const info = await inspectRepo(root);
  if (info.branch !== baseBranch) {
    throw new WorkspaceError(`The project is on "${info.branch ?? 'a detached HEAD'}", not "${baseBranch}". Check out ${baseBranch} first.`);
  }
  if (info.dirty) throw new WorkspaceError('The project has uncommitted changes. Commit or stash them before merging.');
  const ahead = Number(await git(root, ['rev-list', '--count', `${baseBranch}..${branch}`]));
  if (ahead === 0) throw new WorkspaceError(`${memberName} has no changes to merge.`);
  const changed = (await git(root, ['diff', ...SAFE_DIFF, '--name-only', `${baseBranch}...${branch}`])).split('\n').filter(Boolean);
  const risky = protectedPaths(changed);
  if (risky.length > 0) {
    throw new WorkspaceError(`${memberName} changed agent or tool configuration (${risky.join(', ')}). These files can change how Claude, Codex, your editor or git behave, so they are never merged automatically. Review them, then merge ${branch} by hand if you trust them.`);
  }
  const merged = await run(root, [...(await identityArgs(root)), 'merge', '--no-ff', '--no-edit', '--no-verify', '-m', `Merge ${branch} (team member ${memberName})`, branch]);
  if (merged.code !== 0) {
    const conflicts = (await run(root, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim().split('\n').filter(Boolean);
    await run(root, ['merge', '--abort']);
    throw new WorkspaceError(conflicts.length
      ? `Merge conflict in ${conflicts.join(', ')}. Nothing was changed. Ask the agent to rebase on ${baseBranch}, or merge ${branch} by hand.`
      : `Merge failed: ${merged.stderr.trim() || merged.stdout.trim()}`);
  }
  return { commits: ahead };
}

export async function removeWorktree(root: string, path: string): Promise<void> {
  if (existsSync(path)) await git(root, ['worktree', 'remove', '--force', path]);
  await run(root, ['worktree', 'prune']);
}

/** Only used to roll back a team that failed to start: its branches hold no work yet. */
export async function deleteBranch(root: string, branch: string): Promise<void> {
  await run(root, ['branch', '-D', branch]);
}
