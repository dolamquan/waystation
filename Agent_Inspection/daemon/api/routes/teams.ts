import type { Tower } from '../../tower.ts';
import { UserError } from '../../userError.ts';
import { bodyOf, headerOf, r, type Route } from './route.ts';

/** Destructive team actions are only taken with an explicit `confirm: true` in the body. */
function requireConfirm(body: unknown, action: string): Record<string, unknown> {
  const fields = bodyOf(body);
  if (fields.confirm !== true) throw new UserError(`${action} requires confirm: true.`);
  return fields;
}

/** Operator routes (under /api/teams) for creating, steering, reviewing and archiving agent teams. */
export function teamRoutes(tower: Tower): Route[] {
  const teams = tower.teamOps;
  return [
    r('GET', '/api/teams', () => ({ teams: tower.teams.list() })),
    r('POST', '/api/teams', async ({ body }) => ({ ok: true, ...(await teams.create(body)) })),
    r('GET', '/api/teams/:id/log', async ({ params }) => ({ entries: await teams.log(params[0]) })),
    r('POST', '/api/teams/:id/message', async ({ params, body }) => ({ ok: true, message: await teams.message(params[0], bodyOf(body)) })),
    r('POST', '/api/teams/:id/pause', async ({ params }) => {
      await teams.pause(params[0]);
      return { ok: true };
    }),
    r('POST', '/api/teams/:id/resume', async ({ params }) => {
      await teams.resume(params[0]);
      return { ok: true };
    }),
    r('POST', '/api/teams/:id/plan/approve', async ({ params }) => {
      await teams.approvePlan(params[0]);
      return { ok: true, message: 'Plan approved. The team is running.' };
    }),
    r('POST', '/api/teams/:id/tasks', async ({ params, body }) => ({ ok: true, task: await teams.createTask(params[0], bodyOf(body)) })),
    r('POST', '/api/teams/:id/tasks/:task', async ({ params, body }) => ({ ok: true, task: await teams.updateTask(params[0], params[1], bodyOf(body)) })),
    r('POST', '/api/teams/:id/tasks/:task/remove', async ({ params }) => {
      await teams.removeTask(params[0], params[1]);
      return { ok: true };
    }),
    r('GET', '/api/teams/:id/members/:member/diff', async ({ params }) => ({ diff: await teams.diff(params[0], params[1]) })),
    r('POST', '/api/teams/:id/members/:member/merge', async ({ params, body }) => {
      requireConfirm(body, 'Merging');
      return { ok: true, message: await teams.merge(params[0], params[1]) };
    }),
    r('POST', '/api/teams/:id/merge-all', async ({ params, body }) => {
      requireConfirm(body, 'Merging');
      return { ok: true, ...(await teams.mergeAll(params[0])) };
    }),
    r('POST', '/api/teams/:id/disband', async ({ params, body }) => {
      const fields = requireConfirm(body, 'Disbanding');
      return { ok: true, ...(await teams.disband(params[0], fields.removeWorktrees !== false)) };
    }),
    r('POST', '/api/teams/:id/remove', async ({ params, body }) => {
      requireConfirm(body, 'Removing a team');
      await teams.remove(params[0]);
      return { ok: true };
    }),
    r('POST', '/api/teams/:id/operator-cli', async ({ params }) => ({ ok: true, ...(await teams.openOperator(params[0])) })),
    r('POST', '/api/teams/:id/members/:member/return', ({ params }) => ({ ok: true, ...teams.returnMember(params[0], params[1]) })),
  ];
}

/** Routes for team members' MCP bridges (under /team/). They carry a per-member token, never the operator token. */
export function teamBridgeRoutes(tower: Tower): Route[] {
  return [
    r('POST', '/team/tools', ({ req }) => ({ tools: tower.teamOps.tools(headerOf(req, 'x-team-token')) })),
    r('POST', '/team/call', ({ req, body }) => tower.teamOps.call(headerOf(req, 'x-team-token'), bodyOf(body))),
  ];
}
