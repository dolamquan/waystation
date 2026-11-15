import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserError } from '../userError.ts';
import { createWorktree, prepareRepo, snapshotWorktree, diffWorktree, mergeMember } from '../teams/workspace.ts';

export function factoryGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${join(tmpdir(), 'agent-tower-no-git-hooks')}`, ...args],
    { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, out, stderr) => error ? reject(new UserError(stderr.trim() || error.message)) : resolve(out.trim())));
}
export async function prepareFactoryWorkspace(repository: string, root: string, id: string) {
  const repo = await prepareRepo(repository, { initGit: false });
  const branch = `factory/${id}`; const workspace = join(root, id);
  await createWorktree(repository, workspace, branch, repo.head);
  return { workspace, branch, baseBranch: repo.branch, baseCommit: repo.head };
}
export async function snapshotFactoryWorkspace(workspace: string): Promise<string> {
  await snapshotWorktree(workspace, 'Waystation factory', 'Factory: implementation candidate');
  return factoryGit(workspace, ['rev-parse', 'HEAD']);
}
export async function factoryWorkspaceMatches(workspace: string, revision: string): Promise<boolean> {
  return (await factoryGit(workspace, ['rev-parse', 'HEAD'])) === revision && !(await factoryGit(workspace, ['status', '--porcelain', '--untracked-files=all']));
}
export { diffWorktree };
export async function deliverFactoryWorkspace(repository: string, branch: string, baseBranch: string, baseCommit: string, candidate: string) {
  const info = await factoryGit(repository, ['rev-parse', baseBranch]);
  if (info !== baseCommit) throw new UserError('The target branch moved. The reviewed branch is preserved; integrate and validate it against the new target before merging manually.');
  if (await factoryGit(repository, ['rev-parse', branch]) !== candidate) throw new UserError('The candidate branch changed after validation. Validate and accept the new revision before delivery.');
  // Merge the immutable accepted commit. Never snapshot the worktree again during delivery.
  return mergeMember({ root: repository, branch: candidate, baseBranch, memberName: 'Waystation factory' });
}
