import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeRepo, tempDir } from './helpers.ts';

const PORT = 47_334;
const TOKEN = 'team-api-token-0123456789';
const towerHome = join(tempDir('tower-'), 'agent-tower');
mkdirSync(towerHome, { recursive: true });
process.env.AGENT_TOWER_HOME = towerHome;
process.env.CLAUDE_HOME = tempDir('claude-home-');

// Simulated Claude members stay mid-turn (busy): the tests drive the team through its tools and the operator API.
const sdkOptions: Array<Record<string, unknown>> = [];
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    sdkOptions.push(params.options);
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: `sdk-${sdkOptions.length}` };
      for await (const _msg of params.prompt) { /* keep working */ }
    }
    const gen = run() as AsyncGenerator<unknown> & { interrupt: () => Promise<void> };
    gen.interrupt = async () => undefined;
    return gen;
  },
}));

type Tower = import('../daemon/tower.ts').Tower;
let tower: Tower;
let server: Server;

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-tower-token': TOKEN, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

async function until<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const teamView = (id: string) => tower.teams.list().find((team) => team.id === id);

/** The member token from a launched agent's environment, as its MCP bridge would send it. */
const tokenOf = (launchIndex: number) => (sdkOptions[launchIndex].env as Record<string, string>).AGENT_TOWER_TEAM_TOKEN;
const memberCall = (token: string, name: string, args: Record<string, unknown> = {}) =>
  api('POST', '/team/call', { name, arguments: args }, { 'x-team-token': token });

async function createTeam(extra: Record<string, unknown> = {}, members?: unknown[]) {
  const res = await api('POST', '/api/teams', {
    name: `API team ${Math.random().toString(36).slice(2, 7)}`,
    goal: 'Write a greeting',
    cwd: makeRepo(),
    members: members ?? [{ name: 'lead', role: 'lead', vendor: 'claude' }, { name: 'writer', vendor: 'claude' }],
    ...extra,
  });
  expect(res.status).toBe(200);
  return res.json.team as { id: string; status: string };
}

beforeAll(async () => {
  const { Tower } = await import('../daemon/tower.ts');
  const { startServer } = await import('../daemon/api/server.ts');
  tower = new Tower(':memory:');
  server = await startServer({ tower, port: PORT, host: '127.0.0.1', token: TOKEN });
});

afterAll(async () => {
  for (const team of tower.teams.list()) await tower.disbandTeam(team.id, true).catch(() => undefined);
  server?.close();
  await tower?.shutdown();
});

describe('plan review over the operator API', () => {
  it('approves a submitted plan, and refuses approval outside plan review', async () => {
    const before = sdkOptions.length;
    const team = await createTeam();
    expect(team.status).toBe('planning');
    await until(() => sdkOptions.length > before);
    const lead = tokenOf(before);

    expect((await api('POST', `/api/teams/${team.id}/plan/approve`)).status).toBe(400);
    expect((await memberCall(lead, 'create_task', { title: 'Greeting', assignee: 'writer' })).json.isError).toBe(false);
    const submitted = await memberCall(lead, 'submit_plan', { rationale: 'One writer is enough.' });
    expect(submitted.json.isError).toBe(false);
    expect(teamView(team.id)?.status).toBe('plan_review');
    // Nobody but the lead was started while planning.
    expect(sdkOptions.length).toBe(before + 1);

    const approved = await api('POST', `/api/teams/${team.id}/plan/approve`);
    expect(approved.status).toBe(200);
    expect(approved.json).toMatchObject({ ok: true, message: expect.any(String) });
    expect(teamView(team.id)?.status).toBe('running');
    // The writer is woken with its assignment once the plan is approved.
    await until(() => sdkOptions.length === before + 2);

    expect((await api('POST', `/api/teams/${team.id}/plan/approve`)).status).toBe(400);
    expect((await api('POST', '/api/teams/zzzzzz/plan/approve')).status).toBe(400);
  });

  it('starts running straight away when plan approval is off', async () => {
    const team = await createTeam({ requirePlanApproval: false });
    expect(team.status).toBe('running');
  });
});

describe('operator task board over the API', () => {
  let teamId = '';

  beforeAll(async () => {
    teamId = (await createTeam({ requirePlanApproval: false })).id;
  });

  it('creates a task and rejects bad input', async () => {
    const created = await api('POST', `/api/teams/${teamId}/tasks`, { title: 'Write tests', details: 'Cover the API' });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ ok: true, task: { title: 'Write tests', details: 'Cover the API', status: 'open', createdBy: 'operator' } });
    expect(teamView(teamId)?.tasks.some((task) => task.id === created.json.task.id)).toBe(true);

    expect((await api('POST', `/api/teams/${teamId}/tasks`, {})).status).toBe(400);
    expect((await api('POST', `/api/teams/${teamId}/tasks`, { title: 'x', assignee: 'ghost' })).status).toBe(400);
    expect((await api('POST', '/api/teams/zzzzzz/tasks', { title: 'x' })).status).toBe(400);
  });

  it('updates a task (status, assignee, note) and rejects bad updates', async () => {
    const { json } = await api('POST', `/api/teams/${teamId}/tasks`, { title: 'Review' });
    const taskId = json.task.id as string;
    const updated = await api('POST', `/api/teams/${teamId}/tasks/${taskId}`, { status: 'in_progress', assignee: 'writer', note: 'please start' });
    expect(updated.status).toBe(200);
    expect(updated.json.task).toMatchObject({ id: taskId, status: 'in_progress', note: 'please start' });
    expect(updated.json.task.assignee).toBeTruthy();

    expect((await api('POST', `/api/teams/${teamId}/tasks/${taskId}`, { status: 'sideways' })).status).toBe(400);
    expect((await api('POST', `/api/teams/${teamId}/tasks/${taskId}`, { assignee: 'ghost' })).status).toBe(400);
    expect((await api('POST', `/api/teams/${teamId}/tasks/nope`, { status: 'done' })).status).toBe(400);
  });

  it('removes a task, and 400s for one that is not there', async () => {
    const { json } = await api('POST', `/api/teams/${teamId}/tasks`, { title: 'Throwaway' });
    const taskId = json.task.id as string;
    const removed = await api('POST', `/api/teams/${teamId}/tasks/${taskId}/remove`);
    expect(removed).toMatchObject({ status: 200, json: { ok: true } });
    expect(teamView(teamId)?.tasks.some((task) => task.id === taskId)).toBe(false);
    expect((await api('POST', `/api/teams/${teamId}/tasks/${taskId}/remove`)).status).toBe(400);
  });
});

describe('merge all over the API', () => {
  it('requires confirm, then merges every member with changes and skips the rest', async () => {
    const team = await createTeam({ requirePlanApproval: false });
    const writer = await until(() => teamView(team.id)?.members.find((member) => member.name === 'writer'));
    writeFileSync(join(writer.worktree, 'greeting.txt'), 'hello\n');

    expect((await api('POST', `/api/teams/${team.id}/merge-all`, {})).status).toBe(400);
    expect((await api('POST', `/api/teams/${team.id}/merge-all`, { confirm: 'yes' })).status).toBe(400);
    const res = await api('POST', `/api/teams/${team.id}/merge-all`, { confirm: true });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, merged: [expect.anything()], skipped: expect.any(Array) });
    expect(res.json.stopped).toBeUndefined();
    expect(teamView(team.id)?.members.find((member) => member.name === 'writer')?.merged).toBe(true);
    expect((await api('POST', '/api/teams/zzzzzz/merge-all', { confirm: true })).status).toBe(400);
  });
});

describe('archive and remove over the API', () => {
  it('keeps a disbanded team as a read-only archive until it is removed', async () => {
    const team = await createTeam({ requirePlanApproval: false });
    expect((await api('POST', `/api/teams/${team.id}/remove`, { confirm: true })).status).toBe(400);

    const disbanded = await api('POST', `/api/teams/${team.id}/disband`, { confirm: true, removeWorktrees: true });
    expect(disbanded.status).toBe(200);
    expect(teamView(team.id)).toMatchObject({ status: 'disbanded', archivedAt: expect.any(Number) });
    expect((await api('GET', `/api/teams/${team.id}/log`)).json.entries.length).toBeGreaterThan(0);
    expect((await api('POST', `/api/teams/${team.id}/message`, { to: 'all', text: 'hello?' })).status).toBe(400);
    expect((await api('POST', `/api/teams/${team.id}/tasks`, { title: 'late' })).status).toBe(400);

    expect((await api('POST', `/api/teams/${team.id}/remove`, {})).status).toBe(400);
    const removed = await api('POST', `/api/teams/${team.id}/remove`, { confirm: true });
    expect(removed).toMatchObject({ status: 200, json: { ok: true } });
    expect(teamView(team.id)).toBeUndefined();
    expect((await api('GET', '/api/teams')).json.teams.some((t: { id: string }) => t.id === team.id)).toBe(false);
    expect((await api('POST', `/api/teams/${team.id}/remove`, { confirm: true })).status).toBe(400);
  });

  it('ends CLI sessions still recorded for a team it removes, without rejoining it', async () => {
    const team = await createTeam({ requirePlanApproval: false });
    await api('POST', `/api/teams/${team.id}/disband`, { confirm: true });
    const ended: string[] = [];
    const spec = { command: process.execPath, args: [], cwd: tempDir(), env: {} };
    tower.cliSessions.create(spec, { label: `team:${team.id}/lead` }, () => ended.push('member'));
    tower.cliSessions.create(spec, { label: `operator:${team.id}` }, () => ended.push('operator'));

    expect((await api('POST', `/api/teams/${team.id}/remove`, { confirm: true })).status).toBe(200);
    expect(ended.sort()).toEqual(['member', 'operator']);
    expect(tower.cliSessions.has(`team:${team.id}/lead`)).toBe(false);
    expect(tower.cliSessions.has(`operator:${team.id}`)).toBe(false);
  });
});

describe('member loadouts', () => {
  it('applies a member loadout at launch and keeps the launch audit and session history', async () => {
    const doc = await api('POST', '/api/library/docs', { title: 'House style', content: 'Always greet in French.' });
    expect(doc.status).toBe(200);
    const before = sdkOptions.length;
    const team = await createTeam({ requirePlanApproval: false }, [
      { name: 'lead', role: 'lead', vendor: 'claude', loadout: { docIds: [doc.json.doc.id] } },
      { name: 'writer', vendor: 'claude' },
    ]);
    await until(() => sdkOptions.length > before);
    const options = sdkOptions[before];
    expect((options.systemPrompt as { append: string }).append).toContain('Always greet in French.');

    const agentId = await until(() => teamView(team.id)?.members.find((member) => member.name === 'lead')?.agentId);
    expect(agentId).toMatch(/^managed:/);
    expect(tower.history.get(agentId)).toBeDefined();
    const launchAudit = tower.store.auditLog().find((entry) => entry.action === 'launch' && JSON.stringify(entry).includes(doc.json.doc.id));
    expect(launchAudit).toBeDefined();
    expect(JSON.stringify(launchAudit)).toContain(' · lead');
  });

  it('rejects a bad member loadout with a 400', async () => {
    const res = await api('POST', '/api/teams', {
      name: 'Bad loadout', goal: 'x', cwd: makeRepo(),
      members: [{ name: 'lead', role: 'lead', vendor: 'claude', loadout: { docIds: 'not-a-list' } }],
    });
    expect(res.status).toBe(400);
  });
});
