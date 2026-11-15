import { request } from '../../api.ts';
import type { GitWorktree, NewWorktree, WorktreeListing } from '../../../../shared/worktrees.ts';

export type { GitWorktree, WorktreeListing };
export const worktreesApi = {
  list: (root: string) => request<WorktreeListing>('GET', `/api/worktrees?root=${encodeURIComponent(root)}`),
  create: (input: NewWorktree) => request<{ root: string; worktree: GitWorktree }>('POST', '/api/worktrees', input),
};
