import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentStatus } from '../daemon/domain/types.ts';
import type { ManagedLaunch, ManagedRunner } from '../daemon/managed/types.ts';
import { TowerStore } from '../daemon/store/db.ts';
import { TeamAuthError, TeamManager, type TeamHost } from '../daemon/teams/teamManager.ts';
import { git, makeAgent, makeRepo, tempDir } from './helpers.ts';

/** A stand-in for a managed agent: records what it was told, status is driven by the test. */
class FakeRunner implements ManagedRunner {
  readonly sessionId = undefined;
  readonly sent: string[] = [];
  status: AgentStatus = 'busy';
  constructor(readonly id: string, readonly launch: ManagedLaunch) {}
  snapshot(): Agent {
    return makeAgent({ id: this.id, tier: 'A', vendor: this.launch.vendor, status: this.status, name: this.launch.name ?? '' });
  }
  async send(text: string) { this.sent.push(text); this.status = 'busy'; }
  async interrupt() {}
  setIntercepting() {}
  async stop() { this.status = 'stopped'; }
  get token(): string { return this.launch.env!.AGENT_TOWER_TEAM_TOKEN; }
}

function harness(opts: { now?: () => number; store?: TowerStore; codex?: boolean } = {}) {
  const runners: FakeRunner[] = [];
  const store = opts.store ?? new TowerStore(':memory:');
  const host: TeamHost = {
    launch: (launch) => {
      const runner = new FakeRunner(`managed:${runners.length + 1}`, launch);
      runners.push(runner);
      return runner.snapshot();
    },
    runner: (id) => runners.find((r) => r.id === id),
    agent: (id) => runners.find((r) => r.id === id)?.snapshot(),
    audit: vi.fn(),
    codexAvailable: () => opts.codex ?? true,
  };
  const teams = new TeamManager(host, store, { teamsDir: tempDir('teams-'), mcpScript: 'team-mcp.mjs', nodePath: 'node', now: opts.now });
  teams.setEndpoint('http://127.0.0.1:1');
  const idle = (runner: FakeRunner) => {
    runner.status = 'idle';
    teams.onAgent(runner.snapshot());
  };
  const call = (runner: FakeRunner, name: string, args: Record<string, unknown> = {}) => teams.callForToken(runner.token, name, args);
  return { teams, runners, store, host, idle, call };
}

const MEMBERS = [
  { name: 'lead', role: 'lead', vendor: 'claude', model: 'claude-opus-5-5' },
  { name: 'api', role: 'worker', vendor: 'codex', model: 'gpt-5.5-codex' },
  { name: 'ui', role: 'worker', vendor: 'claude' },
];

const created: TeamManager[] = [];
afterEach(async () => {
  for (const manager of created.splice(0)) {
    for (const team of manager.list()) await manager.disband(team.id, { removeWorktrees: true }).catch(() => undefined);
  }
});

async function startTeam(extra: Record<string, unknown> = {}, h = harness()) {
  const repo = makeRepo();
  const { team } = await h.teams.create({ name: 'Auth work', goal: 'Add login', cwd: repo, members: MEMBERS, ...extra });
  created.push(h.teams);
  return { ...h, repo, team };
}

describe('TeamManager: creating a team', () => {
  it('makes one worktree + branch per member and starts only the lead', async () => {
    const { team, runners, repo } = await startTeam();
    expect(team.members.map((m) => m.branch)).toEqual([
      `team/auth-work-${team.id}/lead`, `team/auth-work-${team.id}/api`, `team/auth-work-${team.id}/ui`,
    ]);
    for (const member of team.members) expect(existsSync(join(member.worktree, 'app.txt'))).toBe(true);
    expect(git(repo, 'branch', '--list', 'team/*').split('\n')).toHaveLength(3);
    expect(runners).toHaveLength(1);
    const lead = runners[0];
    expect(lead.launch).toMatchObject({ vendor: 'claude', model: 'claude-opus-5-5', cwd: team.members[0].worktree, writeRoot: team.members[0].worktree });
    expect(lead.launch.appendSystemPrompt).toContain('You are "lead", the lead');
    expect(lead.launch.appendSystemPrompt).toContain('api: worker, codex (gpt-5.5-codex)');
    expect(lead.launch.prompt).toContain('operator → lead: "Team goal: Add login');
    expect(lead.launch.mcpServers?.team).toMatchObject({ command: 'node', args: ['team-mcp.mjs'] });
    expect(lead.launch.mcpServers?.team.env).toEqual({ AGENT_TOWER_TEAM_URL: 'http://127.0.0.1:1' });
    expect(lead.launch.mcpServers?.team.inheritEnv).toEqual(['AGENT_TOWER_TEAM_TOKEN']);
    expect(lead.token).toMatch(/^[0-9a-f]{48}$/);
    expect(JSON.stringify(lead.launch.mcpServers)).not.toContain(lead.token);
    expect(lead.launch.readGuard).toBeUndefined();
  });

  it('refuses codex members when the Codex CLI is missing', async () => {
    await expect(startTeam({}, harness({ codex: false }))).rejects.toThrow(/Codex CLI not found/);
  });

  it('rejects a folder that is not its own repository', async () => {
    const h = harness();
    const plain = tempDir('plain-');
    await expect(h.teams.create({ goal: 'x', cwd: plain, members: MEMBERS })).rejects.toThrow(/Set up git/);
  });
});

describe('TeamManager: collaboration across models', () => {
  it('runs a full lead → workers → finish → merge cycle', async () => {
    const { teams, runners, call, idle, team, repo, store } = await startTeam();
    const [lead] = runners;

    // Lead (Claude) plans and assigns; the Codex worker is started lazily with the briefing inline.
    expect(call(lead, 'create_task', { title: 'Login endpoint', assignee: 'api' }).isError).toBe(false);
    expect(runners).toHaveLength(2);
    const api = runners[1];
    expect(api.launch.vendor).toBe('codex');
    expect(api.launch.appendSystemPrompt).toMatch(/^You are "api", the worker/);
    expect(api.launch.prompt).toContain('lead assigned you t1: Login endpoint');
    expect(api.token).not.toBe(lead.token);

    call(lead, 'create_task', { title: 'Login form', assignee: 'ui' });
    const ui = runners[2];
    idle(lead);
    expect(lead.sent).toEqual([]);

    // Workers report back; the idle lead is woken with their notes.
    writeFileSync(join(team.members[1].worktree, 'login.ts'), 'export const login = true;\n');
    call(api, 'update_task', { taskId: 't1', status: 'done', note: 'login.ts added' });
    expect(lead.sent.at(-1)).toContain('api marked t1 done: login.ts added');
    expect(lead.sent.at(-1)).toContain('[Team update for lead]');

    // Cross-model direct message: Claude worker → Codex worker.
    idle(api);
    call(ui, 'post_message', { to: 'api', text: 'what does login() return?' });
    expect(api.sent.at(-1)).toContain('ui → api: "what does login() return?"');

    call(ui, 'update_task', { taskId: 't2', status: 'done', note: 'form ok' });
    const finished = call(lead, 'finish_team', { summary: 'login shipped' });
    expect(finished.isError).toBe(false);
    expect(teams.list()[0]).toMatchObject({ status: 'done', summary: 'login shipped' });

    // Operator merges the Codex worker's branch, but not while it is mid-turn.
    await expect(teams.merge(team.id, 'api')).rejects.toThrow(/still working/);
    idle(api);
    await teams.merge(team.id, 'api');
    expect(existsSync(join(repo, 'login.ts'))).toBe(true);
    expect(teams.list()[0].members[1].merged).toBe(true);

    const log = store.teamLog(team.id).map((e) => e.summary).join('\n');
    expect(log).toContain('lead created t1 → api: Login endpoint');
    expect(log).toContain('api started (codex gpt-5.5-codex)');
    expect(log).toContain('Merged team/');
  });

  it('holds messages for a busy member until it goes idle', async () => {
    const { runners, call, idle } = await startTeam();
    const [lead] = runners;
    call(lead, 'create_task', { title: 'x', assignee: 'ui' });
    const ui = runners[1];
    call(ui, 'post_message', { to: 'lead', text: 'question' });
    expect(lead.sent).toEqual([]);
    idle(lead);
    expect(lead.sent).toHaveLength(1);
    expect(lead.sent[0]).toContain('ui → lead: "question"');
  });

  it('reports tool mistakes back to the agent instead of failing', async () => {
    const { runners, call } = await startTeam();
    expect(call(runners[0], 'post_message', { to: 'nobody', text: 'hi' })).toMatchObject({ isError: true });
    expect(call(runners[0], 'claim_task', { taskId: 't7' }).text).toMatch(/unknown task/);
  });

  it('rejects unknown or revoked tokens', async () => {
    const { teams, runners, team } = await startTeam();
    expect(() => teams.callForToken('forged', 'list_tasks', {})).toThrow(TeamAuthError);
    expect(() => teams.toolsForToken(undefined)).toThrow(TeamAuthError);
    const token = runners[0].token;
    await teams.disband(team.id, { removeWorktrees: true });
    expect(() => teams.callForToken(token, 'list_tasks', {})).toThrow(TeamAuthError);
  });

  it('lists role-specific tools for each member', async () => {
    const { teams, runners, call } = await startTeam();
    call(runners[0], 'create_task', { title: 'x', assignee: 'ui' });
    expect(teams.toolsForToken(runners[0].token).map((t) => t.name)).toContain('finish_team');
    expect(teams.toolsForToken(runners[1].token).map((t) => t.name)).not.toContain('finish_team');
  });
});

describe('TeamManager: guardrails', () => {
  it('pauses instead of waking members once the wake-up budget is spent', async () => {
    const { teams, runners, call, idle } = await startTeam({ maxWakes: 2 });
    const [lead] = runners;
    call(lead, 'create_task', { title: 'x', assignee: 'ui' });
    idle(lead);
    call(runners[1], 'post_message', { to: 'lead', text: 'ping' });
    expect(teams.list()[0]).toMatchObject({ status: 'paused', statusReason: expect.stringMatching(/budget used up/) });
    expect(lead.sent).toEqual([]);

    teams.resume(teams.list()[0].id);
    expect(teams.list()[0].status).toBe('running');
    expect(lead.sent.at(-1)).toContain('ping');
    expect(lead.sent.at(-1)).toContain('The operator resumed the team');
  });

  it('pauses when the time limit passes', async () => {
    let clock = 1_000_000;
    const { teams, runners, call, idle } = await startTeam({ maxMinutes: 1 }, harness({ now: () => clock }));
    call(runners[0], 'create_task', { title: 'x', assignee: 'ui' });
    idle(runners[0]);
    clock += 2 * 60_000;
    call(runners[1], 'post_message', { to: 'lead', text: 'late' });
    expect(teams.list()[0].statusReason).toMatch(/Time limit reached/);
  });

  it('nudges the lead once when everyone is idle, then pauses', async () => {
    const { teams, runners, idle } = await startTeam();
    const [lead] = runners;
    idle(lead);
    expect(lead.sent).toHaveLength(1);
    expect(lead.sent[0]).toContain('Every teammate is idle');
    idle(lead);
    expect(lead.sent).toHaveLength(1);
    expect(teams.list()[0]).toMatchObject({ status: 'paused', statusReason: expect.stringMatching(/Everyone went idle/) });
  });

  it('queues operator messages while paused and delivers them on resume', async () => {
    const { teams, runners, idle, team } = await startTeam();
    teams.pause(team.id);
    idle(runners[0]);
    expect(teams.message(team.id, 'lead', 'also add logout')).toMatch(/Queued/);
    expect(runners[0].sent).toEqual([]);
    teams.resume(team.id);
    expect(runners[0].sent.at(-1)).toContain('operator → lead: "also add logout"');
  });

  it('mirrors member activity into the team timeline', async () => {
    const { teams, runners, store, team } = await startTeam();
    teams.onAgentEvent({ agentId: runners[0].id, ts: 1, kind: 'tool_call', summary: 'Edit: src/a.ts' });
    teams.onAgentEvent({ agentId: runners[0].id, ts: 2, kind: 'status', summary: 'turn complete' });
    const activity = store.teamLog(team.id).filter((e) => e.kind === 'activity');
    expect(activity).toEqual([expect.objectContaining({ actor: 'lead', summary: '⚙ Edit: src/a.ts' })]);
  });
});

describe('TeamManager: review fixes', () => {
  it('restarts a member whose agent exited, with its unread mail, and revokes the old token', async () => {
    const { teams, runners, call, idle } = await startTeam();
    const [lead] = runners;
    call(lead, 'create_task', { title: 'x', assignee: 'ui' });
    const ui = runners[1];
    const oldToken = ui.token;
    ui.status = 'stopped';
    teams.onAgent(ui.snapshot());
    expect(teams.list()[0].members.find((m) => m.name === 'ui')?.agentId).toBeUndefined();
    expect(() => teams.callForToken(oldToken, 'list_tasks', {})).toThrow(TeamAuthError);

    idle(lead);
    call(lead, 'post_message', { to: 'ui', text: 'are you there?' });
    const relaunched = runners.at(-1)!;
    expect(relaunched).not.toBe(ui);
    expect(relaunched.launch.name).toContain('ui');
    expect(relaunched.launch.prompt).toContain('are you there?');
    expect(teams.list()[0].status).toBe('running');
  });

  it('keeps mail unread and charges nothing when a member fails to start', async () => {
    const h = harness();
    const realLaunch = h.host.launch;
    let failCodex = true;
    (h.host as { launch: TeamHost['launch'] }).launch = (launch) => {
      if (launch.vendor === 'codex' && failCodex) throw new Error('codex exploded');
      return realLaunch(launch);
    };
    const { teams, runners, call, team } = await startTeam({}, h);
    const before = teams.list()[0].budget.wakesUsed;
    call(runners[0], 'create_task', { title: 'Endpoint', assignee: 'api' });
    expect(teams.list()[0]).toMatchObject({ status: 'paused', statusReason: expect.stringMatching(/Could not start api: codex exploded/) });
    expect(teams.list()[0].budget.wakesUsed).toBe(before);

    failCodex = false;
    teams.resume(team.id);
    const api = runners.find((r) => r.launch.vendor === 'codex');
    expect(api?.launch.prompt).toContain('lead assigned you t1: Endpoint');
  });

  it('refuses to disband twice', async () => {
    const { teams, team } = await startTeam();
    const first = teams.disband(team.id, { removeWorktrees: true });
    await expect(teams.disband(team.id, { removeWorktrees: true })).rejects.toThrow(/already being disbanded/);
    await first;
  });

  it('gives Claude members a read guard over the tower state folder', async () => {
    const h = harness();
    const guarded = new TeamManager(h.host, new TowerStore(':memory:'), { teamsDir: join(tempDir('home-'), 'teams'), privateRoot: tempDir('home-'), nodePath: 'node' });
    guarded.setEndpoint('http://127.0.0.1:1');
    const { team } = await guarded.create({ goal: 'x', cwd: makeRepo(), members: MEMBERS });
    created.push(guarded);
    expect(h.runners[0].launch.readGuard?.allow).toContain(team.id);
  });
});

describe('TeamManager: persistence and cleanup', () => {
  it('restores teams after a restart as stopped, and relaunches members on resume', async () => {
    const dbFile = join(tempDir('team-db-'), 'tower.db');
    const first = harness({ store: new TowerStore(dbFile) });
    const { team, runners, call } = await startTeam({}, first);
    call(runners[0], 'create_task', { title: 'x', assignee: 'ui' });
    first.teams.shutdown();
    first.store.close();

    const second = harness({ store: new TowerStore(dbFile) });
    created.push(second.teams);
    const restored = second.teams.list()[0];
    expect(restored).toMatchObject({ id: team.id, status: 'stopped' });
    expect(restored.members.every((m) => m.agentId === undefined)).toBe(true);
    expect(restored.tasks).toHaveLength(1);

    second.teams.resume(team.id);
    expect(second.runners).toHaveLength(1);
    expect(second.runners[0].launch.prompt).toContain('The operator resumed the team');
  });

  it('disbands: stops agents, removes worktrees, keeps unmerged branches', async () => {
    const { teams, runners, team, repo } = await startTeam();
    const { keptBranches } = await teams.disband(team.id, { removeWorktrees: true });
    expect(runners[0].status).toBe('stopped');
    expect(team.members.some((m) => existsSync(m.worktree))).toBe(false);
    expect(keptBranches).toHaveLength(3);
    expect(git(repo, 'branch', '--list', 'team/*')).toContain('/lead');
    expect(teams.list()).toEqual([]);
  });

  it('shows a member diff against the team base', async () => {
    const { teams, team } = await startTeam();
    writeFileSync(join(team.members[2].worktree, 'form.tsx'), '<form />\n');
    const diff = await teams.diff(team.id, 'ui');
    expect(diff.stat).toContain('form.tsx');
    expect(readFileSync(join(team.members[2].worktree, 'form.tsx'), 'utf8')).toContain('<form />');
  });
});
