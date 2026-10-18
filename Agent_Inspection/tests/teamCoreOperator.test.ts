import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPERATOR } from '../daemon/teams/types.ts';
import { cleanup, startCoreTeam } from './teamCoreHarness.ts';

afterEach(cleanup);

const RUNNING = { requirePlanApproval: false };

describe('operator task board', () => {
  it('creates an assigned task and wakes the assignee with a tower notice', async () => {
    const { teams, team, runnerFor, events, view } = await startCoreTeam(RUNNING);
    const task = teams.createTask(team.id, { title: 'Docs', details: 'README', assignee: 'ui' });
    expect(task).toMatchObject({ title: 'Docs', assignee: 'ui', createdBy: OPERATOR });
    expect(view().tasks).toHaveLength(1);
    expect(runnerFor('ui')?.launch.prompt).toContain(`assigned you ${task.id}: Docs`);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'task', actor: OPERATOR, summary: expect.stringContaining(`created ${task.id}`) }));
  });

  it('reassigns a task, notifying the new owner, and removes tasks', async () => {
    const { teams, team, runnerFor, idle, view } = await startCoreTeam(RUNNING);
    const task = teams.createTask(team.id, { title: 'Docs', assignee: 'ui' });
    idle(runnerFor('ui')!);
    const moved = teams.updateTask(team.id, task.id, { assignee: 'api', note: 'api knows this' });
    expect(moved).toMatchObject({ assignee: 'api', note: 'api knows this' });
    expect(runnerFor('api')?.launch.prompt).toContain(`assigned you ${task.id}`);
    expect(runnerFor('ui')?.sent.at(-1)).toContain(`moved ${task.id}`);
    teams.removeTask(team.id, task.id);
    expect(view().tasks).toEqual([]);
  });

  it('does not notify assignees while the plan is being drafted', async () => {
    const { teams, team, runners } = await startCoreTeam();
    teams.createTask(team.id, { title: 'Docs', assignee: 'ui' });
    expect(runners).toHaveLength(1);
  });

  it('rejects bad task input as an expected error', async () => {
    const { teams, team } = await startCoreTeam(RUNNING);
    expect(() => teams.createTask(team.id, { title: '' })).toThrow(/title is required/);
    expect(() => teams.updateTask(team.id, 't9', { status: 'done' })).toThrow(/unknown task/);
  });
});

describe('disband archives', () => {
  it('keeps a read-only archive with its log, refuses operator actions, and can then be removed', async () => {
    const { teams, team, runners, view } = await startCoreTeam(RUNNING);
    const token = runners[0].token;
    await teams.disband(team.id, { removeWorktrees: true });
    expect(view()).toMatchObject({ status: 'disbanded', archivedAt: expect.any(Number) });
    expect(runners[0].status).toBe('stopped');
    expect(teams.log(team.id).length).toBeGreaterThan(0);
    expect(() => teams.callForToken(token, 'list_tasks', {})).toThrow();
    expect(() => teams.message(team.id, 'lead', 'hi')).toThrow(/disbanded/);
    expect(() => teams.resume(team.id)).toThrow(/disbanded/);
    expect(() => teams.createTask(team.id, { title: 'x' })).toThrow(/disbanded/);
    expect(() => teams.operatorAccess(team.id)).toThrow(/disbanded/);
    await expect(teams.mergeAll(team.id)).rejects.toThrow(/disbanded/);

    teams.remove(team.id);
    expect(teams.list()).toEqual([]);
    expect(() => teams.log(team.id)).toThrow(/not found/);
  });

  it('refuses to remove a team that is not disbanded', async () => {
    const { teams, team } = await startCoreTeam(RUNNING);
    expect(() => teams.remove(team.id)).toThrow(/Disband it first/);
  });
});

describe('merge all', () => {
  it('merges workers with changes first, then the lead, skipping members without changes', async () => {
    const { teams, team, repo, runners, idle, member } = await startCoreTeam(RUNNING);
    teams.pause(team.id);
    idle(runners[0]);
    writeFileSync(join(member('api').worktree, 'api.ts'), 'export const api = 1;\n');
    writeFileSync(join(member('lead').worktree, 'plan.md'), '# plan\n');
    const result = await teams.mergeAll(team.id);
    expect(result).toEqual({ merged: ['api', 'lead'], skipped: ['ui'] });
    expect(existsSync(join(repo, 'api.ts'))).toBe(true);
    expect(existsSync(join(repo, 'plan.md'))).toBe(true);
  });

  it('stops at the first failure and reports it', async () => {
    const { teams, team, member } = await startCoreTeam(RUNNING);
    // The lead is mid-turn (busy) and has changes: merge-all merges api, then stops at the lead.
    writeFileSync(join(member('api').worktree, 'api.ts'), 'export const api = 1;\n');
    writeFileSync(join(member('lead').worktree, 'plan.md'), '# plan\n');
    const result = await teams.mergeAll(team.id);
    expect(result.merged).toEqual(['api']);
    expect(result.stopped).toEqual({ member: 'lead', reason: expect.stringMatching(/still working/) });
  });
});
