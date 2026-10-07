import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentStatus } from '../daemon/domain/types.ts';
import type { ManagedLaunch, ManagedRunner } from '../daemon/managed/types.ts';
import { TowerStore } from '../daemon/store/db.ts';
import { TeamAuthError, TeamManager, type TeamHost } from '../daemon/teams/teamManager.ts';
import { makeAgent, makeRepo, tempDir } from './helpers.ts';

/** A managed agent with a real-looking session id, so it can be handed to a terminal. */
class SessionRunner implements ManagedRunner {
  readonly sent: string[] = [];
  status: AgentStatus = 'busy';
  constructor(readonly id: string, readonly launch: ManagedLaunch, readonly sessionId: string) {}
  snapshot(): Agent {
    return makeAgent({ id: this.id, tier: 'A', vendor: this.launch.vendor, status: this.status, sessionId: this.sessionId });
  }
  async send(text: string) { this.sent.push(text); this.status = 'busy'; }
  async interrupt() {}
  setIntercepting() {}
  async stop() { this.status = 'stopped'; }
  get token(): string { return this.launch.env!.AGENT_TOWER_TEAM_TOKEN; }
}

const MEMBERS = [
  { name: 'lead', role: 'lead', vendor: 'claude', model: 'claude-opus-5-5' },
  { name: 'ui', role: 'worker', vendor: 'claude' },
];

const managers: TeamManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const team of manager.list()) await manager.disband(team.id, { removeWorktrees: true }).catch(() => undefined);
  }
});

async function startTeam(store: TowerStore = new TowerStore(':memory:')) {
  const runners: SessionRunner[] = [];
  const host: TeamHost = {
    launch: (launch) => {
      const runner = new SessionRunner(`managed:${runners.length + 1}`, launch, `sess-${runners.length + 1}`);
      runners.push(runner);
      return runner.snapshot();
    },
    runner: (id) => runners.find((r) => r.id === id),
    agent: (id) => runners.find((r) => r.id === id)?.snapshot(),
    audit: vi.fn(),
    codexAvailable: () => true,
  };
  const teams = new TeamManager(host, store, { teamsDir: tempDir('teams-'), mcpScript: 'team-mcp.mjs', nodePath: 'node' });
  teams.setEndpoint('http://127.0.0.1:1');
  managers.push(teams);
  const { team } = await teams.create({ name: 'Auth work', goal: 'Add login', cwd: makeRepo(), members: MEMBERS });
  const idle = (runner: SessionRunner) => {
    runner.status = 'idle';
    teams.onAgent(runner.snapshot());
  };
  const member = (name: string) => teams.list()[0].members.find((m) => m.name === name)!;
  return { teams, runners, team, idle, member, host, store };
}

describe('safety around a member in the CLI', () => {
  it('after a tower restart, a member left in the CLI rejoins on resume instead of waiting forever', async () => {
    const { teams, runners, team, host, store } = await startTeam();
    runners[0].status = 'idle';
    await teams.handOffMember(team.id, 'lead');

    const restarted = new TeamManager(host, store, { teamsDir: tempDir('teams-'), mcpScript: 'team-mcp.mjs', nodePath: 'node' });
    const view = restarted.list()[0];
    expect(view.status).toBe('stopped');
    expect(view.statusReason).toContain('lead rejoins the team on resume');
    expect(view.members[0]).toMatchObject({ terminal: undefined, resumeSessionId: 'sess-1' });
  });

  it('refuses to merge a member that is open in the CLI', async () => {
    const { teams, runners, team } = await startTeam();
    runners[0].status = 'idle';
    await teams.handOffMember(team.id, 'lead');
    await expect(teams.merge(team.id, 'lead')).rejects.toThrow(/open in your CLI/);
  });

  it('stops honouring the operator token once the team is being disbanded', async () => {
    const { teams, team } = await startTeam();
    const access = teams.operatorAccess(team.id);
    await teams.disband(team.id, { removeWorktrees: true });
    expect(teams.isOperatorToken(access.token)).toBe(false);
    await expect(teams.callOperatorForToken(access.token, 'resume_team', {})).rejects.toThrow(TeamAuthError);
  });
});

describe('handing a member to the operator\'s terminal', () => {
  it('stops the managed copy and hands over the session with fresh team access', async () => {
    const { teams, runners, team, member } = await startTeam();
    const [lead] = runners;
    lead.status = 'idle';

    const handoff = await teams.handOffMember(team.id, 'lead');

    expect(lead.status).toBe('stopped');
    expect(handoff).toMatchObject({ sessionId: 'sess-1', vendor: 'claude', model: 'claude-opus-5-5', cwd: member('lead').worktree });
    expect(handoff.token).toMatch(/^[0-9a-f]{48}$/);
    expect(handoff.token).not.toBe(lead.token);
    expect(handoff.briefing).toContain('opened your session in their terminal');
    expect(handoff.mcpServers.team.inheritEnv).toEqual(['AGENT_TOWER_TEAM_TOKEN']);
    expect(member('lead')).toMatchObject({ agentId: undefined, terminal: { sessionId: 'sess-1' } });
    // The terminal session keeps working team tools, and the old managed token is gone.
    expect(teams.callForToken(handoff.token, 'list_tasks', {}).isError).toBe(false);
    expect(() => teams.callForToken(lead.token, 'list_tasks', {})).toThrow(TeamAuthError);
  });

  it('refuses while the member is mid-turn', async () => {
    const { teams, team } = await startTeam();
    await expect(teams.handOffMember(team.id, 'lead')).rejects.toThrow(/mid-turn/);
  });

  it('holds the member\'s mail and never starts a second copy while it is in the terminal', async () => {
    const { teams, runners, team, idle } = await startTeam();
    runners[0].status = 'idle';
    await teams.handOffMember(team.id, 'lead');

    teams.message(team.id, 'ui', 'build the form');
    const ui = runners[1];
    teams.message(team.id, 'lead', 'status?');
    idle(ui);

    expect(runners).toHaveLength(2);
    expect(teams.list()[0].status).toBe('running');
  });

  it('brings the member back on the same session when the terminal closes', async () => {
    const { teams, runners, team, member } = await startTeam();
    runners[0].status = 'idle';
    const handoff = await teams.handOffMember(team.id, 'lead');
    teams.message(team.id, 'lead', 'welcome back');

    teams.returnMember(team.id, 'lead');

    const back = runners[1];
    expect(back.launch).toMatchObject({ resumeSessionId: 'sess-1', fork: false, cwd: member('lead').worktree });
    expect(back.launch.prompt).toContain('operator → lead: "welcome back"');
    expect(member('lead').terminal).toBeUndefined();
    expect(member('lead').agentId).toBe(back.id);
    expect(() => teams.callForToken(handoff.token, 'list_tasks', {})).toThrow(TeamAuthError);
    teams.returnMember(team.id, 'lead');
    expect(runners).toHaveLength(2);
  });

  it('with no mail waiting, brings the member back idle at once, without spending budget', async () => {
    const { teams, runners, team, member } = await startTeam();
    runners[0].status = 'idle';
    await teams.handOffMember(team.id, 'lead');
    const wakesBefore = teams.list()[0].budget.wakesUsed;

    teams.returnMember(team.id, 'lead');

    const back = runners[1];
    expect(back.launch).toMatchObject({ prompt: '', resumeSessionId: 'sess-1', fork: false });
    expect(member('lead').agentId).toBe(back.id);
    expect(teams.list()[0].budget.wakesUsed).toBe(wakesBefore);
  });
});

describe('operator session tools', () => {
  it('lets the operator\'s Claude session read and steer the team, and nothing else', async () => {
    const { teams, runners, team, member } = await startTeam();
    const access = teams.operatorAccess(team.id);

    const names = teams.toolsForToken(access.token).map((tool) => tool.name);
    expect(names).toEqual(['team_status', 'read_channel', 'send_message', 'pause_team', 'resume_team', 'member_changes']);
    expect(access.briefing).toContain('Messages you send are posted as the operator');
    expect(access.mcpServers.team.inheritEnv).toEqual(['AGENT_TOWER_TEAM_TOKEN']);
    expect(() => teams.callForToken(access.token, 'list_tasks', {})).toThrow(TeamAuthError);

    const status = await teams.callOperatorForToken(access.token, 'team_status', {});
    expect(status.text).toContain('Add login');
    expect(status.text).toMatch(/lead .*claude-opus-5-5/);

    expect((await teams.callOperatorForToken(access.token, 'read_channel', {})).text).toContain('Team goal: Add login');

    await teams.callOperatorForToken(access.token, 'send_message', { to: 'ui', text: 'start on the form' });
    expect(runners[1].launch.prompt).toContain('operator → ui: "start on the form"');

    writeFileSync(join(member('ui').worktree, 'form.ts'), 'export const form = 1;\n');
    expect((await teams.callOperatorForToken(access.token, 'member_changes', { member: 'ui' })).text).toContain('form.ts');

    await teams.callOperatorForToken(access.token, 'pause_team', {});
    expect(teams.list()[0].status).toBe('paused');
    expect((await teams.callOperatorForToken(access.token, 'send_message', { to: 'ghost', text: 'x' })).isError).toBe(true);

    teams.revokeToken(access.token);
    expect(() => teams.toolsForToken(access.token)).toThrow(TeamAuthError);
  });
});
