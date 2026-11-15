import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TowerStore } from '../daemon/store/db.ts';
import { OPERATOR, SYSTEM } from '../daemon/teams/types.ts';
import { cleanup, coreHarness, startCoreTeam } from './teamCoreHarness.ts';
import { tempDir } from './helpers.ts';

afterEach(cleanup);

const RUNNING = { requirePlanApproval: false };

describe('finishing while the team is still talking', () => {
  it('refuses finish_team while a teammate is mid-turn or the lead has unread mail', async () => {
    const { runners, call, idle, view } = await startCoreTeam(RUNNING);
    const [lead] = runners;
    call(lead, 'create_task', { title: 'Greeting', assignee: 'api' });
    const api = runners[1];
    call(api, 'update_task', { taskId: 't1', status: 'done', note: 'greet.txt added' });
    idle(api);
    call(lead, 'read_messages');

    // The lead asks a question, which wakes api; finishing now would drop its answer.
    call(lead, 'post_message', { to: 'api', text: 'what is in greet.txt?' });
    expect(api.status).toBe('busy');
    const early = call(lead, 'finish_team', { summary: 'done' });
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/api is still working/);
    expect(view().status).toBe('running');

    // The answer arrives while the lead is still in its turn: it must read it first.
    call(api, 'post_message', { to: 'lead', text: 'hello from worker' });
    idle(api);
    const unread = call(lead, 'finish_team', { summary: 'done' });
    expect(unread.isError).toBe(true);
    expect(unread.text).toMatch(/unread/);

    expect(call(lead, 'read_messages').text).toContain('hello from worker');
    expect(call(lead, 'finish_team', { summary: 'done' }).isError).toBe(false);
    expect(view().status).toBe('done');
  });
});

describe('adding a member to an existing team', () => {
  it('creates its worktree, tells the lead, and lets teammates reach it', async () => {
    const { teams, team, runners, call, idle, view, runnerFor } = await startCoreTeam(RUNNING);
    const [lead] = runners;

    // Added while the lead is mid-turn: the notice waits in its mailbox.
    const { member, message } = await teams.addMember(team.id, { name: 'docs', vendor: 'codex', model: 'gpt-5.5-codex', focus: 'README' });
    expect(member).toMatchObject({ name: 'docs', role: 'worker', vendor: 'codex', merged: false });
    expect(member.branch).toBe(view().members[0].branch.replace(/\/lead$/, '/docs'));
    expect(existsSync(join(member.worktree, '.git'))).toBe(true);
    expect(message).toMatch(/docs joined/);
    expect(view().members.map((m) => m.name)).toEqual(['lead', 'api', 'ui', 'docs']);

    // Its turn ends: it is woken with the news, and the roster it can query is live.
    expect(lead.sent).toEqual([]);
    idle(lead);
    expect(lead.sent.at(-1)).toMatch(/docs \(worker, codex gpt-5\.5-codex\) joined the team/);
    expect(call(lead, 'team_roster').text).toContain('docs: worker, codex');

    // The newcomer launches with its first message, on its own worktree and token.
    call(lead, 'create_task', { title: 'Write README', assignee: 'docs' });
    const docs = runnerFor('docs')!;
    expect(docs.launch).toMatchObject({ vendor: 'codex', cwd: member.worktree, model: 'gpt-5.5-codex' });
    expect(docs.launch.prompt).toContain('lead assigned you t1: Write README');
    call(docs, 'update_task', { taskId: 't1', status: 'done', note: 'README written' });
    expect(view().tasks[0]).toMatchObject({ assignee: 'docs', status: 'done' });
  });

  it('rejects a second lead, a duplicate name, a full team and a disbanded team', async () => {
    const { teams, team } = await startCoreTeam(RUNNING);
    await expect(teams.addMember(team.id, { name: 'boss', role: 'lead', vendor: 'claude' })).rejects.toThrow(/one lead/);
    await expect(teams.addMember(team.id, { name: 'api', vendor: 'claude' })).rejects.toThrow(/already/);
    await teams.addMember(team.id, { name: 'w4', vendor: 'claude' });
    await teams.addMember(team.id, { name: 'w5', vendor: 'claude' });
    await teams.addMember(team.id, { name: 'w6', vendor: 'claude' });
    await expect(teams.addMember(team.id, { name: 'w7', vendor: 'claude' })).rejects.toThrow(/at most 6/);
    await teams.disband(team.id, { removeWorktrees: true });
    await expect(teams.addMember(team.id, { name: 'late', vendor: 'claude' })).rejects.toThrow(/disbanded/);
  });
});

describe('session continuity', () => {
  it('saves the session id a member reports and continues it after a crash', async () => {
    const { teams, runners, team, idle, member, runnerFor } = await startCoreTeam(RUNNING);
    const [lead] = runners;
    lead.sessionId = 'sess-lead';
    teams.onAgent(lead.snapshot());
    expect(member('lead').sessionId).toBe('sess-lead');

    lead.status = 'stopped';
    teams.onAgent(lead.snapshot());
    teams.message(team.id, 'lead', 'are you back?');
    const relaunched = runnerFor('lead')!;
    expect(relaunched).not.toBe(lead);
    expect(relaunched.launch).toMatchObject({ resumeSessionId: 'sess-lead', fork: false });
    idle(relaunched);
  });

  it('continues every member session after a daemon restart', async () => {
    const dbFile = join(tempDir('core-db-'), 'tower.db');
    const first = coreHarness({ store: new TowerStore(dbFile) });
    const { team, runners } = await startCoreTeam(RUNNING, first);
    runners[0].sessionId = 'sess-before-restart';
    first.teams.onAgent(runners[0].snapshot());
    first.teams.shutdown();
    first.store.close();

    const second = coreHarness({ store: new TowerStore(dbFile) });
    second.teams.resume(team.id);
    expect(second.runners[0].launch).toMatchObject({ resumeSessionId: 'sess-before-restart', fork: false });
  });

  it('launches with no resume when the member never had a session', async () => {
    const { runners } = await startCoreTeam(RUNNING);
    expect(runners[0].launch.resumeSessionId).toBeUndefined();
  });
});

describe('replies', () => {
  it('logs one reply per turn, addressed to the operator when the operator woke the member', async () => {
    const { teams, runners, events, idle } = await startCoreTeam(RUNNING);
    const [lead] = runners;
    teams.onAgentEvent({ agentId: lead.id, ts: 1, kind: 'assistant', summary: 'thinking out loud' });
    teams.onAgentEvent({ agentId: lead.id, ts: 2, kind: 'tool_call', summary: 'Read: a.ts' });
    teams.onAgentEvent({ agentId: lead.id, ts: 3, kind: 'assistant', summary: 'Hello operator' });
    idle(lead);
    idle(lead);
    const replies = events.filter((e) => e.kind === 'reply');
    expect(replies).toEqual([expect.objectContaining({ actor: 'lead', summary: 'Hello operator', to: OPERATOR })]);
    expect(events.some((e) => e.summary === 'thinking out loud')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'activity', summary: '⚙ Read: a.ts' }));
  });

  it('addresses the reply to the teammate whose message woke the member', async () => {
    const { teams, runners, events, idle, call, runnerFor } = await startCoreTeam(RUNNING);
    const [lead] = runners;
    call(lead, 'create_task', { title: 'Endpoint', assignee: 'api' });
    const api = runnerFor('api')!;
    idle(api);
    call(lead, 'post_message', { to: 'api', text: 'status?' });
    expect(api.sent.at(-1)).toContain('status?');
    teams.onAgentEvent({ agentId: api.id, ts: 1, kind: 'assistant', summary: 'almost done' });
    idle(api);
    expect(events.filter((e) => e.kind === 'reply')).toEqual([expect.objectContaining({ actor: 'api', summary: 'almost done', to: 'lead' })]);
    expect(lead.sent.join(' | ')).not.toContain('almost done');
  });

  it('logs a reply when the agent stops mid-turn, and posts no mail for it', async () => {
    const { teams, runners, events, view } = await startCoreTeam(RUNNING);
    const [lead] = runners;
    teams.onAgentEvent({ agentId: lead.id, ts: 1, kind: 'assistant', summary: 'last words' });
    lead.status = 'stopped';
    teams.onAgent(lead.snapshot());
    expect(events.filter((e) => e.kind === 'reply')).toEqual([expect.objectContaining({ summary: 'last words' })]);
    expect(Object.values(view().pending).every((n) => n === 0)).toBe(true);
  });
});

describe('message log entries', () => {
  it('carry the body only, the recipient and the message id', async () => {
    const { teams, team, events, runners, call } = await startCoreTeam(RUNNING);
    teams.message(team.id, 'all', 'standup');
    call(runners[0], 'post_message', { to: 'ui', text: 'take the form' });
    const messages = events.filter((e) => e.kind === 'message');
    expect(messages).toContainEqual(expect.objectContaining({ actor: OPERATOR, summary: 'standup', to: 'all', messageId: expect.any(String) }));
    expect(messages).toContainEqual(expect.objectContaining({ actor: 'lead', summary: 'take the form', to: 'ui', messageId: expect.any(String) }));
    expect(messages.every((e) => !e.summary.includes('→'))).toBe(true);
  });

  it('shows undelivered mail per member as pending', async () => {
    const { teams, team, view } = await startCoreTeam(RUNNING);
    teams.pause(team.id);
    teams.message(team.id, 'ui', 'one');
    teams.message(team.id, 'ui', 'two');
    expect(view().pending.ui).toBe(2);
    expect(view().pendingIds.ui).toHaveLength(2);
  });
});

describe('spend, loadout and focus', () => {
  it('accumulates cost deltas and turns per member, across launches', async () => {
    const { teams, runners, team, idle, member, view, runnerFor } = await startCoreTeam(RUNNING);
    const [lead] = runners;
    expect(member('lead').spend).toEqual({ costUsd: 0, turns: 1 });
    lead.costUsd = 0.5;
    idle(lead); // nudged: second turn
    lead.costUsd = 0.75;
    lead.status = 'stopped';
    teams.onAgent(lead.snapshot());
    expect(member('lead').spend?.costUsd).toBeCloseTo(0.75);
    expect(member('lead').spend?.turns).toBe(2);

    teams.resume(team.id);
    const again = runnerFor('lead')!;
    again.costUsd = 0.25; // a new launch starts counting from zero
    idle(again);
    expect(member('lead').spend?.costUsd).toBeCloseTo(1);
    expect(view().spend.costUsd).toBeCloseTo(1);
  });

  it('passes each member its loadout on every launch and puts its focus in the briefing', async () => {
    const loadout = { skills: ['review'] };
    const members = [
      { name: 'lead', role: 'lead', vendor: 'claude', focus: 'Owns the plan', loadout },
      { name: 'api', role: 'worker', vendor: 'claude' },
    ];
    const { runners, member } = await startCoreTeam({ ...RUNNING, members });
    expect(member('lead').focus).toBe('Owns the plan');
    expect(runners[0].loadout).toEqual(member('lead').loadout);
    expect(runners[0].launch.appendSystemPrompt).toContain('Owns the plan');
  });
});

describe('tower notices', () => {
  it('logs plan approval notices as tower messages', async () => {
    const { teams, team, runners, call, idle, events } = await startCoreTeam();
    call(runners[0], 'create_task', { title: 'Endpoint', assignee: 'api' });
    call(runners[0], 'submit_plan', { rationale: 'one task' });
    idle(runners[0]);
    teams.approvePlan(team.id);
    expect(events.filter((e) => e.kind === 'message' && e.actor === SYSTEM).map((e) => e.to).sort()).toEqual(['api', 'lead']);
  });
});

describe('failed wakes', () => {
  it('pauses with the error, refunds the wake and keeps the mail unread when a send fails', async () => {
    const { teams, team, runners, idle, view, events } = await startCoreTeam(RUNNING);
    const [lead] = runners;
    lead.failSend = new Error('pipe closed');
    idle(lead); // the idle nudge cannot be sent
    await new Promise((resolve) => setImmediate(resolve));
    expect(view()).toMatchObject({ status: 'paused', statusReason: expect.stringMatching(/Could not deliver to lead: pipe closed/) });
    expect(view().budget.wakesUsed).toBe(1);
    expect(view().pending.lead).toBe(1);

    lead.failSend = undefined;
    teams.resume(team.id);
    expect(lead.sent.at(-1)).toContain('Every teammate is idle');
    teams.onAgentEvent({ agentId: lead.id, ts: 1, kind: 'assistant', summary: 'ok' });
    idle(lead);
    expect(events.filter((e) => e.kind === 'reply').at(-1)).toMatchObject({ to: 'tower' });
  });
});
