import { describe, expect, it } from 'vitest';
import {
  BoardError, MAX_TASK_TITLE_CHARS, RESUME_GRANT, approvePlanNotices, createTask, markRead, operatorCreateTask, operatorUpdateTask,
  postMessage, removeTask, toView, unreadFor,
} from '../daemon/teams/board.ts';
import { advertisedTools, callTool, toolsFor } from '../daemon/teams/tools.ts';
import { EVERYONE, OPERATOR } from '../daemon/teams/types.ts';
import { makeTeam, member } from './teamSetupFixtures.ts';

const names = (tools: readonly { name: string }[]) => tools.map((t) => t.name);

describe('toView', () => {
  it('reports pending mail per member, resume grant, spend and plan fields', () => {
    let team = makeTeam({
      members: [
        member('lead', 'lead', { spend: { costUsd: 0.5, turns: 2 } }),
        member('api', 'worker', { spend: { costUsd: 0.25, turns: 1 } }),
        member('ui'),
      ],
      requirePlanApproval: true,
      archivedAt: 42,
    });
    team = postMessage(team, OPERATOR, 'api', 'one');
    team = postMessage(team, 'lead', EVERYONE, 'two');
    team = markRead(team, 'ui');
    const view = toView(team);
    expect(view.pending).toEqual({ lead: 0, api: 2, ui: 0 });
    expect(view.pendingIds.api).toEqual(team.messages.map((m) => m.id));
    expect(view.pendingIds.lead).toEqual([]);
    expect(view.resumeGrant).toEqual({ wakes: 20, minutes: 30 });
    expect(RESUME_GRANT).toEqual({ wakes: 20, minutes: 30 });
    expect(view.spend).toEqual({ costUsd: 0.75, turns: 3 });
    expect(view).toMatchObject({ requirePlanApproval: true, archivedAt: 42 });
    expect(view).not.toHaveProperty('messages');
    expect(view).not.toHaveProperty('readUpTo');
  });
});

describe('task ids', () => {
  it('keeps other ids and never reuses a live id after a removal', () => {
    let team = makeTeam();
    for (const title of ['a', 'b', 'c']) team = createTask(team, 'lead', { title }).state;
    team = removeTask(team, 't2');
    expect(team.tasks.map((t) => t.id)).toEqual(['t1', 't3']);
    const next = createTask(team, 'lead', { title: 'd' });
    expect(next.task.id).toBe('t4');
    expect(operatorCreateTask(next.state, { title: 'e' }).task.id).toBe('t5');
  });

  it('removeTask rejects unknown ids', () => {
    expect(() => removeTask(makeTeam(), 't1')).toThrow(BoardError);
  });
});

describe('operator task board', () => {
  it('creates an assigned task as the operator and notifies the assignee', () => {
    const out = operatorCreateTask(makeTeam(), { title: ' Add login ', details: 'use the session API', assignee: '@API' }, 7);
    expect(out.task).toMatchObject({
      id: 't1', title: 'Add login', details: 'use the session API', status: 'in_progress', assignee: 'api', createdBy: OPERATOR, updatedAt: 7,
    });
    expect(out.state.tasks).toEqual([out.task]);
    expect(out.notices).toEqual([{ to: 'api', text: 'The operator assigned you t1: Add login\nuse the session API' }]);
    expect(out.summary).toBe('created t1 → api: Add login');
  });

  it('creates an unassigned task without notices', () => {
    const out = operatorCreateTask(makeTeam(), { title: 'Docs' });
    expect(out.task).toMatchObject({ status: 'open', assignee: undefined, details: '' });
    expect(out.notices).toEqual([]);
  });

  it('validates operator input', () => {
    const team = makeTeam();
    expect(() => operatorCreateTask(team, { title: '' })).toThrow(/title is required/);
    expect(() => operatorCreateTask(team, { title: 'x'.repeat(MAX_TASK_TITLE_CHARS + 1) })).toThrow(/at most 160/);
    expect(() => operatorCreateTask(team, { title: 'x', details: 5 })).toThrow(/details must be text/);
    expect(() => operatorCreateTask(team, { title: 'x', assignee: 'ghost' })).toThrow(/unknown teammate/);
    expect(() => operatorCreateTask(team, null)).toThrow(BoardError);
    const withTask = operatorCreateTask(team, { title: 'x' }).state;
    expect(() => operatorUpdateTask(withTask, 't1', { status: 'finished' })).toThrow(/status must be/);
    expect(() => operatorUpdateTask(withTask, 't9', { note: 'x' })).toThrow(/unknown task/);
    expect(() => operatorUpdateTask(withTask, 't1', { title: '  ' })).toThrow(/cannot be empty/);
  });

  it('redacts secrets in operator text', () => {
    const out = operatorCreateTask(makeTeam(), { title: 'rotate sk-abcdefghijklmnopqrstuvwxyz' });
    expect(out.task.title).toContain('[REDACTED]');
  });

  it('reassigns any task, telling the new and the previous owner', () => {
    const team = createTask(makeTeam(), 'lead', { title: 'Form', assignee: 'ui' }).state;
    const out = operatorUpdateTask(team, 't1', { assignee: 'api' }, 9);
    expect(out.task).toMatchObject({ assignee: 'api', status: 'in_progress', updatedAt: 9, createdBy: 'lead' });
    expect(out.notices).toEqual([
      { to: 'api', text: 'The operator assigned you t1: Form' },
      { to: 'ui', text: 'The operator moved t1 to api. Stop working on it.' },
    ]);
    expect(out.summary).toBe('updated t1 (→ api): Form');
  });

  it('edits fields, unassigns, and only notifies on owner changes', () => {
    const team = operatorCreateTask(makeTeam(), { title: 'Form', assignee: 'ui' }).state;
    const edited = operatorUpdateTask(team, 't1', { title: 'Form v2', details: 'd', note: 'n', status: 'blocked' });
    expect(edited.task).toMatchObject({ title: 'Form v2', details: 'd', note: 'n', status: 'blocked', assignee: 'ui' });
    expect(edited.notices).toEqual([]);
    expect(edited.summary).toBe('updated t1 (title, details, note, blocked): Form v2');
    const started = operatorUpdateTask(team, 't1', { assignee: null });
    expect(started.task).toMatchObject({ assignee: undefined, status: 'open' });
    expect(started.notices).toEqual([{ to: 'ui', text: 'The operator moved t1 off your list. Stop working on it.' }]);
    expect(operatorUpdateTask(team, 't1', { assignee: 'ui' }).notices).toEqual([]);
  });

  it('does not mutate the input state', () => {
    const team = makeTeam();
    operatorCreateTask(team, { title: 'x' });
    expect(team.tasks).toEqual([]);
  });

  it('sends no notices while the plan is drafted or reviewed', () => {
    for (const status of ['planning', 'plan_review'] as const) {
      const team = makeTeam({ status });
      const created = operatorCreateTask(team, { title: 'x', assignee: 'api' });
      expect(created.notices).toEqual([]);
      expect(operatorUpdateTask(created.state, 't1', { assignee: 'ui' }).notices).toEqual([]);
    }
  });
});

describe('plan review tools', () => {
  const planning = () => makeTeam({ status: 'planning', requirePlanApproval: true });

  it('offers submit_plan only to the lead while planning, and finish_team only after approval', () => {
    const [lead, worker] = planning().members;
    expect(names(toolsFor(lead, 'planning'))).toContain('submit_plan');
    expect(names(toolsFor(lead, 'planning'))).not.toContain('finish_team');
    expect(names(toolsFor(lead, 'plan_review'))).not.toContain('submit_plan');
    expect(names(toolsFor(lead, 'plan_review'))).not.toContain('finish_team');
    expect(names(toolsFor(lead, 'running'))).toContain('finish_team');
    expect(names(toolsFor(lead, 'running'))).not.toContain('submit_plan');
    expect(names(toolsFor(worker, 'planning'))).not.toContain('submit_plan');
  });

  // Agents fetch the tool list once per session (the bridge cannot announce changes), so it must not depend on the phase.
  it('advertises every role tool regardless of phase and gates the phase-bound ones at call time', () => {
    const [lead, worker] = planning().members;
    expect(names(advertisedTools(lead))).toEqual(expect.arrayContaining(['submit_plan', 'finish_team']));
    expect(names(advertisedTools(worker))).not.toContain('finish_team');
    expect(() => callTool(planning(), 'lead', 'finish_team', { summary: 'done' })).toThrow(/not available until the operator approves/);
    expect(() => callTool(makeTeam({ status: 'running' }), 'lead', 'submit_plan', { rationale: 'x' })).toThrow(/no plan to submit/);
  });

  it('drafts assigned tasks without notifying anyone while planning', () => {
    const out = callTool(planning(), 'lead', 'create_task', { title: 'Endpoint', assignee: 'api' });
    expect(unreadFor(out.state, 'api')).toEqual([]);
    expect(out.state.tasks[0]).toMatchObject({ assignee: 'api' });
    expect(out.text).toContain('told once the plan is approved');
  });

  it('submit_plan needs a task, moves to plan_review and logs a system entry', () => {
    expect(() => callTool(planning(), 'lead', 'submit_plan', { rationale: 'x' })).toThrow(/board is empty/);
    const drafted = callTool(planning(), 'lead', 'create_task', { title: 'Endpoint', assignee: 'api' }).state;
    expect(() => callTool(drafted, 'lead', 'submit_plan', {})).toThrow(/"rationale" is required/);
    const out = callTool(drafted, 'lead', 'submit_plan', { rationale: 'api owns the server' });
    expect(out.submittedPlan).toBe(true);
    expect(out.state.status).toBe('plan_review');
    expect(out.log).toEqual([{ kind: 'system', summary: 'submitted the plan (1 task): api owns the server' }]);
    expect(out.state.messages).toEqual([]);
  });

  it('explains why submit_plan or finish_team is unavailable', () => {
    const review = makeTeam({ status: 'plan_review', requirePlanApproval: true });
    expect(() => callTool(review, 'lead', 'submit_plan', { rationale: 'x' })).toThrow(/already with the operator/);
    expect(() => callTool(planning(), 'lead', 'finish_team', { summary: 'x' })).toThrow(/until the operator approves/);
    expect(() => callTool(makeTeam(), 'lead', 'submit_plan', { rationale: 'x' })).toThrow(/no plan to submit/);
    expect(() => callTool(planning(), 'api', 'submit_plan', { rationale: 'x' })).toThrow(/unknown tool/);
  });

  it('approvePlanNotices gives each assignee one notice with its open tasks, and one to the lead', () => {
    let team = planning();
    team = createTask(team, 'lead', { title: 'Endpoint', details: 'GET /x', assignee: 'api' }).state;
    team = createTask(team, 'lead', { title: 'Schema', assignee: 'api' }).state;
    team = createTask(team, 'lead', { title: 'Review', assignee: 'lead' }).state;
    team = createTask(team, 'lead', { title: 'Docs' }).state;
    const notices = approvePlanNotices(team);
    expect(notices.map((n) => n.to)).toEqual(['lead', 'api']);
    const api = notices[1].text;
    expect(api).toContain('approved the plan');
    expect(api).toContain('- t1: Endpoint\n  GET /x');
    expect(api).toContain('- t2: Schema');
    expect(api).not.toContain('Review');
    const lead = notices[0].text;
    expect(lead).toContain('approved your plan');
    expect(lead).toContain('Unassigned: t4.');
    expect(lead).toContain('- t3: Review');
  });
});

describe('tool log items', () => {
  it('post_message logs the body only, with recipient and message id', () => {
    const out = callTool(makeTeam(), 'api', 'post_message', { to: 'UI', text: 'schema is ready' });
    const sent = out.state.messages.at(-1)!;
    expect(out.log).toEqual([{ kind: 'message', summary: 'schema is ready', to: 'ui', messageId: sent.id }]);
    const all = callTool(makeTeam(), 'api', 'post_message', { to: 'all', text: 'hi team' });
    expect(all.log[0]).toMatchObject({ summary: 'hi team', to: EVERYONE });
  });

  it('logs redacted message bodies', () => {
    const out = callTool(makeTeam(), 'api', 'post_message', { to: 'ui', text: 'key sk-abcdefghijklmnopqrstuvwxyz' });
    expect(out.log[0].summary).toContain('[REDACTED]');
  });

  it('handoff logs the task change and the message', () => {
    const team = createTask(makeTeam(), 'lead', { title: 'Form', assignee: 'ui' }).state;
    const out = callTool(team, 'ui', 'handoff', { to: 'api', taskId: 't1', summary: 'needs a field' });
    expect(out.log[0]).toEqual({ kind: 'task', summary: 'handed t1 to api' });
    expect(out.log[1]).toMatchObject({ kind: 'message', summary: 'Handoff of t1: needs a field', to: 'api' });
  });

  it('roster lines carry each member\'s focus as quoted data', () => {
    const team = makeTeam({ members: [member('lead', 'lead'), member('api', 'worker', { focus: 'server "APIs"\nand tests' }), member('ui')] });
    const text = callTool(team, 'ui', 'team_roster', {}).text;
    expect(text).toContain('api: worker, claude, branch team/x/api, focus "server \\"APIs\\"\\nand tests"');
    expect(text.split('\n')).toHaveLength(4);
  });
});
