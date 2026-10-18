import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TowerStore } from '../daemon/store/db.ts';
import { cleanup, coreHarness, startCoreTeam } from './teamCoreHarness.ts';
import { tempDir } from './helpers.ts';

afterEach(cleanup);

/** Lead drafts two assigned tasks and submits; returns the lead runner. */
async function submittedTeam(extra: Record<string, unknown> = {}, h = coreHarness()) {
  const t = await startCoreTeam(extra, h);
  const [lead] = t.runners;
  t.call(lead, 'create_task', { title: 'Endpoint', assignee: 'api' });
  t.call(lead, 'create_task', { title: 'Form', assignee: 'ui' });
  expect(t.call(lead, 'submit_plan', { rationale: 'split by layer' }).isError).toBe(false);
  t.idle(lead);
  return { ...t, lead };
}

describe('plan review: planning phase', () => {
  it('starts in planning by default and wakes only the lead, with a planning kickoff', async () => {
    const { view, runners } = await startCoreTeam();
    expect(view()).toMatchObject({ status: 'planning', requirePlanApproval: true });
    expect(runners).toHaveLength(1);
    expect(runners[0].launch.prompt).toContain('submit_plan');
  });

  it('starts running at once when requirePlanApproval is false', async () => {
    const { view } = await startCoreTeam({ requirePlanApproval: false });
    expect(view()).toMatchObject({ status: 'running', requirePlanApproval: false });
  });

  it('does not wake assignees or other mail while planning; the lead may submit_plan but not finish_team', async () => {
    const { teams, runners, call, view } = await startCoreTeam();
    const [lead] = runners;
    call(lead, 'create_task', { title: 'Endpoint', assignee: 'api' });
    call(lead, 'post_message', { to: 'ui', text: 'heads up' });
    expect(runners).toHaveLength(1);
    expect(view().pending.ui).toBe(1);
    // The listing is phase-independent (agents cache it for the session); finish_team is refused at call time.
    expect(teams.toolsForToken(lead.token).map((t) => t.name)).toEqual(expect.arrayContaining(['submit_plan', 'finish_team']));
    expect(call(lead, 'finish_team', { summary: 'skip review' }).isError).toBe(true);
  });

  it('lets the lead call finish_team after approval with the tool list it fetched while planning', async () => {
    const { teams, team, call, view, runners } = await startCoreTeam();
    const [lead] = runners;
    const listedWhilePlanning = teams.toolsForToken(lead.token).map((t) => t.name);
    call(lead, 'create_task', { title: 'Endpoint' });
    expect(call(lead, 'submit_plan', { rationale: 'one task' }).isError).toBe(false);
    teams.approvePlan(team.id);
    call(lead, 'update_task', { taskId: 't1', status: 'done' });
    expect(listedWhilePlanning).toContain('finish_team');
    expect(call(lead, 'finish_team', { summary: 'done' }).isError).toBe(false);
    expect(view().status).toBe('done');
  });

  it('reminds the lead once before pausing when it ends planning without submitting', async () => {
    const { runners, idle, view } = await startCoreTeam();
    idle(runners[0]);
    expect(view().status).toBe('planning');
    expect(runners[0].sent).toHaveLength(1);
    expect(runners[0].sent[0]).toContain('call submit_plan now');
    idle(runners[0]);
    expect(view()).toMatchObject({ status: 'paused', statusReason: expect.stringMatching(/without submitting a plan/) });
    expect(runners[0].sent).toHaveLength(1);
  });

  it('recovers a missing submission without waking workers before approval', async () => {
    const { teams, team, runners, idle, call, view } = await startCoreTeam();
    idle(runners[0]);
    call(runners[0], 'create_task', { title: 'Endpoint', assignee: 'api' });
    expect(call(runners[0], 'submit_plan', { rationale: 'Endpoint first' }).isError).toBe(false);
    idle(runners[0]);
    expect(view().status).toBe('plan_review');
    expect(runners).toHaveLength(1);
    teams.approvePlan(team.id);
    expect(view().status).toBe('running');
    expect(runners).toHaveLength(2);
  });

  it('respects the wake budget when sending the planning reminder', async () => {
    const { runners, idle, view } = await startCoreTeam({ maxWakes: 1 });
    idle(runners[0]);
    expect(view().status).toBe('paused');
    expect(view().statusReason).toMatch(/budget used up/);
    expect(runners[0].sent).toHaveLength(0);
  });

  it('applies the wake budget while planning', async () => {
    const { teams, runners, idle, view, team } = await startCoreTeam({ maxWakes: 1 });
    teams.message(team.id, 'lead', 'more detail please');
    idle(runners[0]);
    expect(view().statusReason).toMatch(/budget used up/);
  });
});

describe('plan review: submit, feedback, approve', () => {
  it('submit_plan moves to plan_review and wakes nobody', async () => {
    const { view, runners, lead } = await submittedTeam();
    expect(view()).toMatchObject({ status: 'plan_review', statusReason: expect.stringMatching(/Approve it/) });
    expect(runners).toHaveLength(1);
    expect(lead.sent).toEqual([]);
  });

  it('refuses submit_plan with an empty board', async () => {
    const { runners, call, view } = await startCoreTeam();
    expect(call(runners[0], 'submit_plan', { rationale: 'x' }).isError).toBe(true);
    expect(view().status).toBe('planning');
  });

  it('an operator message to the lead during review is feedback: back to planning and the lead is woken', async () => {
    const { teams, team, view, lead } = await submittedTeam();
    expect(teams.message(team.id, 'lead', 'merge the two tasks')).toMatch(/feedback/);
    expect(view().status).toBe('planning');
    expect(lead.sent.at(-1)).toContain('merge the two tasks');
  });

  it('messages to others during review queue', async () => {
    const { teams, team, runners } = await submittedTeam();
    expect(teams.message(team.id, 'ui', 'hello')).toMatch(/Queued until the plan is approved/);
    expect(runners).toHaveLength(1);
  });

  it('approvePlan wakes each assignee once with its tasks and tells the lead', async () => {
    const { teams, team, view, runnerFor, lead, idle } = await submittedTeam();
    teams.approvePlan(team.id);
    expect(view().status).toBe('running');
    const api = runnerFor('api')!;
    const ui = runnerFor('ui')!;
    expect(api.launch.prompt).toContain('t1: Endpoint');
    expect(api.launch.prompt).not.toContain('Form');
    expect(ui.launch.prompt).toContain('t2: Form');
    idle(lead);
    expect(lead.sent.at(-1)).toContain('approved your plan');
  });

  it('approvePlan is refused outside plan review', async () => {
    const { teams, team } = await startCoreTeam();
    expect(() => teams.approvePlan(team.id)).toThrow(/no plan waiting/);
  });

  it('the operator CLI session can approve the plan', async () => {
    const { teams, team, view } = await submittedTeam();
    const access = teams.operatorAccess(team.id);
    expect((await teams.callOperatorForToken(access.token, 'team_status', {})).text).toContain('waiting for approval');
    expect(await teams.callOperatorForToken(access.token, 'approve_plan', {})).toMatchObject({ isError: false });
    expect(view().status).toBe('running');
    expect((await teams.callOperatorForToken(access.token, 'approve_plan', {})).isError).toBe(true);
  });
});

describe('plan review: pause and resume keep the phase', () => {
  it('resume after a planning pause returns to planning and wakes the lead', async () => {
    const { teams, team, runners, idle, view } = await startCoreTeam();
    idle(runners[0]);
    idle(runners[0]);
    expect(view().status).toBe('paused');
    teams.resume(team.id);
    expect(view().status).toBe('planning');
    expect(runners[0].sent.at(-1)).toContain('The operator resumed the team');
  });

  it('resume after pausing in plan_review returns to plan_review without waking anyone', async () => {
    const { teams, team, view, lead } = await submittedTeam();
    teams.pause(team.id);
    expect(view().status).toBe('paused');
    teams.resume(team.id);
    expect(view().status).toBe('plan_review');
    expect(lead.sent).toEqual([]);
    teams.approvePlan(team.id);
    expect(view().status).toBe('running');
  });

  it('a restart keeps a team in plan review, and a planning team resumes into planning', async () => {
    const dbFile = join(tempDir('core-db-'), 'tower.db');
    const first = coreHarness({ store: new TowerStore(dbFile) });
    const reviewed = await submittedTeam({}, first);
    const planning = await startCoreTeam({ name: 'Second' }, first);
    first.teams.shutdown();
    first.store.close();

    const second = coreHarness({ store: new TowerStore(dbFile) });
    const byId = (id: string) => second.teams.list().find((t) => t.id === id)!;
    expect(byId(reviewed.team.id).status).toBe('plan_review');
    expect(byId(planning.team.id).status).toBe('stopped');
    second.teams.resume(planning.team.id);
    expect(byId(planning.team.id).status).toBe('planning');
    second.teams.approvePlan(reviewed.team.id);
    expect(byId(reviewed.team.id).status).toBe('running');
  });
});

describe('plan review: a team paused mid-plan stays in its plan phase', () => {
  /** Lead ignores the planning reminder: the team pauses from planning. */
  async function pausedFromPlanning() {
    const t = await startCoreTeam();
    t.idle(t.runners[0]);
    t.idle(t.runners[0]);
    expect(t.view().status).toBe('paused');
    return { ...t, lead: t.runners[0] };
  }

  it('does not notify assignees of operator or lead tasks while paused from planning', async () => {
    const { teams, team, call, lead, view, runners } = await pausedFromPlanning();
    teams.createTask(team.id, { title: 'Docs', assignee: 'ui' });
    call(lead, 'create_task', { title: 'Endpoint', assignee: 'api' });
    expect(view().pending.ui).toBe(0);
    expect(view().pending.api).toBe(0);
    teams.resume(team.id);
    expect(runners).toHaveLength(1);
  });

  it('keeps a lead paused from planning on submit_plan, refusing finish_team', async () => {
    const { teams, team, call, lead, view } = await pausedFromPlanning();
    call(lead, 'create_task', { title: 'Endpoint' });
    call(lead, 'update_task', { taskId: 't1', status: 'done' });
    expect(call(lead, 'finish_team', { summary: 'skip review' }).isError).toBe(true);
    expect(call(lead, 'submit_plan', { rationale: 'one task' }).isError).toBe(false);
    expect(view().status).toBe('paused');
    teams.resume(team.id);
    expect(view().status).toBe('plan_review');
  });

  it('treats a message to the lead while paused from plan review as feedback, delivered on resume', async () => {
    const { teams, team, view, lead } = await submittedTeam();
    teams.pause(team.id);
    expect(teams.message(team.id, 'lead', 'split t1')).toMatch(/feedback/);
    teams.resume(team.id);
    expect(view().status).toBe('planning');
    expect(lead.sent.at(-1)).toContain('split t1');
  });

  it('pauses with a clear reason when the lead exits before submitting a plan', async () => {
    const { teams, runners, view } = await startCoreTeam();
    runners[0].status = 'stopped';
    teams.onAgent(runners[0].snapshot());
    expect(view()).toMatchObject({ status: 'paused', statusReason: expect.stringMatching(/lead stopped before submitting a plan/) });
  });
});
