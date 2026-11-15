import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { folderRoot } from '../files/folderFiles.ts';
import type { GitWorktree, WorktreeListing } from '../../shared/worktrees.ts';

export class WorktreeError extends Error {}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((done, reject) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${join(tmpdir(), 'agent-tower-no-git-hooks')}`, ...args],
      { cwd, windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => error
        ? reject(new WorktreeError(String(stderr).trim() || error.message))
        : done(String(stdout)));
  });
}

/** -z leaves paths and lock reasons unquoted, including spaces, tabs and newlines. */
export function parseWorktrees(output: string): GitWorktree[] {
  const result: GitWorktree[] = [];
  for (const record of output.split('\0\0')) {
    const fields = record.split('\0').filter(Boolean);
    const path = fields.find(field => field.startsWith('worktree '))?.slice(9);
    if (!path) continue;
    const value = (key: string) => fields.find(field => field.startsWith(`${key} `))?.slice(key.length + 1);
    result.push({ path, head: value('HEAD'), branch: value('branch')?.replace(/^refs\/heads\//, ''), main: result.length === 0,
      bare: fields.includes('bare'), detached: fields.includes('detached'),
      ...(fields.some(field => field === 'locked' || field.startsWith('locked ')) ? { locked: value('locked') || 'Locked' } : {}),
      ...(fields.some(field => field === 'prunable' || field.startsWith('prunable ')) ? { prunable: value('prunable') || 'Missing folder' } : {}),
    });
  }
  return result;
}

export async function listWorktrees(rawRoot: unknown): Promise<WorktreeListing> {
  const cwd = folderRoot(rawRoot);
  let root: string;
  try { root = folderRoot((await git(cwd, ['rev-parse', '--show-toplevel'])).trim()); }
  catch { throw new WorktreeError('Choose a folder inside a Git repository. Git must be installed.'); }
  const [output, refs, status] = await Promise.all([
    git(root, ['worktree', 'list', '--porcelain', '-z']),
    git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads/']),
    git(root, ['status', '--porcelain', '--untracked-files=normal']),
  ]);
  // Git prints forward slashes on Windows; saved tiles and terminal cwd use native real paths.
  const worktrees = parseWorktrees(output).map(tree => ({ ...tree, path: existsSync(tree.path) ? folderRoot(tree.path) : resolve(tree.path) }));
  const hasCommits = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
  return { root, worktrees, branches: refs.trim().split('\n').map(ref => ref.trim().replace(/^refs\/heads\//, '')).filter(Boolean),
    dirty: status.length > 0, hasCommits, suggestedParent: dirname(root) };
}

function text(raw: unknown, label: string, fallback?: string): string {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024 || /[\0\r\n]/.test(raw)) throw new WorktreeError(`Enter a valid ${label}.`);
  return raw.trim();
}

const within = (parent: string, target: string) => {
  const rel = relative(parent, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

/** No forced checkout, branch reset, auto-commit, or cleanup: failures preserve existing work. */
export async function addWorktree(input: Record<string, unknown>): Promise<{ worktree: GitWorktree; root: string }> {
  const listing = await listWorktrees(input.root);
  if (!listing.hasCommits) throw new WorktreeError('Commit your project at least once before creating a worktree.');
  const branch = text(input.branch, 'branch name');
  if (branch.startsWith('-') || branch === 'HEAD') throw new WorktreeError('Choose a branch name that does not start with a dash and is not HEAD.');
  try { await git(listing.root, ['check-ref-format', `refs/heads/${branch}`]); }
  catch { throw new WorktreeError('That branch name is not valid. Use a name such as feature/search.'); }
  if (input.mode !== 'new' && input.mode !== 'existing') throw new WorktreeError('Choose a new or existing branch.');
  if (input.mode === 'new' && listing.branches.includes(branch)) throw new WorktreeError('That branch already exists. Choose an existing branch or enter a new name.');
  if (input.mode === 'existing' && !listing.branches.includes(branch)) throw new WorktreeError('That local branch does not exist. Refresh the worktree list.');
  if (listing.worktrees.some(tree => tree.branch === branch)) throw new WorktreeError('That branch is already checked out. Select its worktree instead.');
  const defaultPath = join(listing.suggestedParent, `${basename(listing.root)}--${branch.replace(/[^a-zA-Z0-9._-]/g, '-')}`);
  const path = text(input.path, 'worktree folder', defaultPath);
  if (!isAbsolute(path) || /^[/\\]{2}/.test(path)) throw new WorktreeError('Use an absolute local path for the new worktree folder.');
  if (existsSync(path)) throw new WorktreeError('That folder already exists. Choose a new folder for the worktree.');
  // Resolve its existing parent to prevent a junction from placing a worktree in Git metadata.
  const parent = folderRoot(dirname(path));
  const target = resolve(parent, basename(path));
  const common = realpathSync.native((await git(listing.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  if (within(common, target)) throw new WorktreeError('Choose a worktree folder outside the repository’s .git directory.');
  let head: string;
  if (input.mode === 'new') {
    const base = text(input.base, 'starting commit or branch', 'HEAD');
    try { head = (await git(listing.root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).trim(); }
    catch { throw new WorktreeError('That starting commit or branch does not exist.'); }
    await git(listing.root, ['worktree', 'add', '-b', branch, '--', target, head]);
  } else {
    head = (await git(listing.root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).trim();
    await git(listing.root, ['worktree', 'add', '--', target, branch]);
  }
  return { root: listing.root, worktree: { path: target, head, branch, main: false, bare: false, detached: false } };
}
