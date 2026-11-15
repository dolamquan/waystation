import type { Tower } from '../../tower.ts';
import { UserError } from '../../userError.ts';
import { addWorktree, listWorktrees } from '../../git/worktrees.ts';
import { bodyOf, r, type Route } from './route.ts';

export function worktreeRoutes(tower: Tower): Route[] {
  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (error) { throw new UserError((error as Error).message); }
  };
  return [
    r('GET', '/api/worktrees', ({ req }) => guarded(() => listWorktrees(new URL(req.url ?? '/', 'http://localhost').searchParams.get('root')))),
    r('POST', '/api/worktrees', ({ body }) => guarded(async () => {
      const result = await addWorktree(bodyOf(body));
      tower.store.audit('worktree_create', result.worktree.path, { root: result.root, branch: result.worktree.branch });
      return { ok: true, ...result };
    })),
  ];
}
