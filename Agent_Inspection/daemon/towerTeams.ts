import { randomUUID } from 'node:crypto';
import { paths } from './config.ts';
import type { AgentRegistry } from './domain/registry.ts';
import type { Agent } from './domain/types.ts';
import type { TowerStore } from './store/db.ts';
import type { ManagedAgents } from './managed/managedAgents.ts';
import { resolveCodexEntry } from './managed/codexRunner.ts';
import type { ManagedLaunch } from './managed/types.ts';
import { TeamError, TeamManager } from './teams/teamManager.ts';
import { TeamInputError } from './teams/teamInput.ts';
import { BoardError } from './teams/board.ts';
import { WorkspaceError } from './teams/workspace.ts';
import type { CliHandoffs } from './actions/cliHandoffs.ts';
import type { Library } from './library/index.ts';
import { applyLoadout, isEmptyLoadout } from './library/loadout.ts';
import { LibraryInputError, type LaunchLoadout } from './library/types.ts';
import type { SessionHistory } from './sessions/history.ts';
import { CLI_NAME, requireCli, type CliVendor, type TowerCli } from './towerCli.ts';
import { UserError } from './userError.ts';

const MAX_MESSAGE_CHARS = 8000;

/** Expected failures from the teams layer become 400s with their message; anything else stays a 500. */
export async function asUserError<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const expected = error instanceof TeamError || error instanceof TeamInputError
      || error instanceof WorkspaceError || error instanceof BoardError || error instanceof LibraryInputError;
    if (expected) throw new UserError((error as Error).message);
    throw error;
  }
}

export interface TowerTeamsDeps {
  readonly store: TowerStore;
  readonly registry: AgentRegistry;
  readonly managed: ManagedAgents;
  readonly history: SessionHistory;
  readonly library: Library;
  readonly cliSessions: CliHandoffs;
  readonly cli: TowerCli;
}

/** The operator's team actions (audited, expected errors as UserError) and the host the TeamManager launches through. */
export class TowerTeams {
  readonly manager: TeamManager;

  constructor(private readonly deps: TowerTeamsDeps) {
    this.manager = new TeamManager({
      launch: (launch: ManagedLaunch, loadout?: LaunchLoadout) => this.launchMember(launch, loadout),
      runner: (agentId) => deps.managed.get(agentId),
      agent: (agentId) => deps.registry.get(agentId),
      audit: (action, target, detail) => deps.store.audit(action, target, detail),
      codexAvailable: () => resolveCodexEntry() !== undefined,
    }, deps.store, { teamsDir: paths.teamsDir, privateRoot: paths.towerHome });
  }

  /** Launches a member's agent with its loadout, exactly as a single agent's launch applies one. */
  private launchMember(raw: ManagedLaunch, loadout?: LaunchLoadout): Agent {
    const { store, managed, history, library, registry } = this.deps;
    let launch = raw;
    let notes: readonly string[] = [];
    if (!isEmptyLoadout(loadout)) {
      // Providers key per-agent state (notify tokens, generated plugin folders) on the agent id.
      ({ launch, notes } = applyLoadout({ ...launch, agentId: launch.agentId ?? `managed:${randomUUID()}` }, loadout, library.providers));
    }
    store.audit('launch', launch.cwd, { vendor: launch.vendor, team: launch.name, model: launch.model, loadout });
    let agent: Agent;
    try {
      agent = managed.launch(launch).snapshot();
      history.remember(agent);
      history.rememberLaunch(agent.id, launch, loadout);
    } catch (error) {
      if (launch.agentId) library.notifier.revoke(launch.agentId);
      throw error;
    }
    for (const note of notes) registry.pushEvent({ agentId: agent.id, ts: Date.now(), kind: 'system', summary: note });
    return agent;
  }

  create(raw: unknown) { return asUserError(() => this.manager.create(raw)); }

  log(teamId: string) { return asUserError(() => this.manager.log(teamId)); }

  message(teamId: string, body: Record<string, unknown>) {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length > MAX_MESSAGE_CHARS) throw new UserError('Message is too long.');
    return asUserError(() => this.manager.message(teamId, body.to, text));
  }

  pause(teamId: string) { return asUserError(() => this.manager.pause(teamId)); }

  resume(teamId: string) { return asUserError(() => this.manager.resume(teamId)); }

  diff(teamId: string, memberId: string) { return asUserError(() => this.manager.diff(teamId, memberId)); }

  merge(teamId: string, memberId: string) { return asUserError(() => this.manager.merge(teamId, memberId)); }

  mergeAll(teamId: string) { return asUserError(() => this.manager.mergeAll(teamId)); }

  approvePlan(teamId: string) { return asUserError(() => this.manager.approvePlan(teamId)); }

  createTask(teamId: string, raw: unknown) { return asUserError(() => this.manager.createTask(teamId, raw)); }

  updateTask(teamId: string, taskId: string, raw: unknown) { return asUserError(() => this.manager.updateTask(teamId, taskId, raw)); }

  removeTask(teamId: string, taskId: string) { return asUserError(() => this.manager.removeTask(teamId, taskId)); }

  async disband(teamId: string, removeWorktrees: boolean) {
    const result = await asUserError(() => this.manager.disband(teamId, { removeWorktrees }));
    // Members' CLI sessions and the operator session lose their team; forget them (it is archived, so nothing relaunches).
    this.endCliSessions(teamId);
    return result;
  }

  /** Deletes an archived team, then ends any CLI session still recorded for it (there is no team left to rejoin). */
  async remove(teamId: string): Promise<void> {
    await asUserError(() => this.manager.remove(teamId));
    this.endCliSessions(teamId);
  }

  private endCliSessions(teamId: string): void {
    this.deps.cliSessions.endWhere((label) => label.startsWith(`team:${teamId}/`) || label === `operator:${teamId}`);
  }

  /** Calls from a member's MCP bridge, authenticated by that member's own token. */
  tools(token: string | undefined) { return this.manager.toolsForToken(token); }

  call(token: string | undefined, body: Record<string, unknown>) {
    return this.manager.isOperatorToken(token)
      ? this.manager.callOperatorForToken(token, body.name, body.arguments)
      : this.manager.callForToken(token, body.name, body.arguments);
  }

  private team(teamId: string) { return this.manager.list().find((candidate) => candidate.id === teamId); }

  /** The operator's own Claude Code session on a team, with scoped tools to read and steer it. */
  async openOperator(teamId: string): Promise<{ message: string }> {
    requireCli('claude');
    const access = await asUserError(() => this.manager.operatorAccess(teamId));
    const revoke = () => this.manager.revokeToken(access.token);
    try {
      await this.deps.cli.openTab(
        { vendor: 'claude', cwd: access.cwd, mcpServers: access.mcpServers, appendSystemPrompt: access.briefing, teamToken: access.token },
        `operator:${teamId}`, `Claude Code · ${this.team(teamId)?.name ?? 'team'} operator`, revoke,
      );
    } catch (error) {
      revoke();
      throw error;
    }
    return { message: 'Opened a Claude Code session for this team.' };
  }

  /** Take back: return a member from the operator's terminal even if its tab is still open. */
  returnMember(teamId: string, memberId: string): { message: string } {
    const member = this.team(teamId)?.members.find((m) => m.id === memberId);
    if (!member) throw new UserError('Member not found.');
    if (!member.terminal) throw new UserError(`${member.name} is not open in your CLI.`);
    this.deps.store.audit('team_member_return', teamId, { member: memberId });
    this.deps.cliSessions.endLabel(`team:${teamId}/${memberId}`);
    this.manager.returnMember(teamId, memberId);
    return { message: `${member.name} is back with the team. Close its old CLI tab: that session no longer has team access.` };
  }

  /** Opens a team member's session in the CLI; undefined when the agent is not a team member. */
  openMember(agentId: string, vendor: CliVendor): Promise<{ message: string }> | undefined {
    const membership = this.manager.memberForAgent(agentId);
    return membership ? this.openMemberCli(membership.teamId, membership.memberId, agentId, vendor) : undefined;
  }

  private async openMemberCli(teamId: string, memberId: string, agentId: string, vendor: CliVendor): Promise<{ message: string }> {
    const handoff = await asUserError(() => this.manager.handOffMember(teamId, memberId));
    this.deps.cli.handOver(agentId);
    // An archived team keeps its record: a session closing after disband must not rejoin it.
    const back = () => { if (this.team(teamId)?.status !== 'disbanded') this.manager.returnMember(teamId, memberId); };
    // From here on, any failure must hand the member back to the team rather than leave it waiting for a CLI.
    try {
      await this.deps.cli.openTab({
        vendor,
        cwd: handoff.cwd,
        sessionId: handoff.sessionId,
        model: handoff.model,
        mcpServers: handoff.mcpServers,
        // Codex has no system-prompt option; its thread already carries the team briefing.
        appendSystemPrompt: vendor === 'claude' ? handoff.briefing : undefined,
        teamToken: handoff.token,
        sandbox: true,
      }, `team:${teamId}/${memberId}`, `${CLI_NAME[vendor]} · ${this.team(teamId)?.name ?? 'team'} · ${memberId}`, back);
    } catch (error) {
      back();
      throw error;
    }
    return { message: `Opened ${memberId} in ${CLI_NAME[vendor]}. It rejoins the team when you close that session.` };
  }
}
