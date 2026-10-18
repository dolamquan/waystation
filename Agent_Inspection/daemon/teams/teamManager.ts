import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { Agent, AgentEvent } from '../domain/types.ts';
import type { StdioMcpServer } from '../managed/types.ts';
import { BoardError, RESUME_GRANT, lead, memberById, memberByName, planPhase, replaceMember } from './board.ts';
import { Delivery } from './delivery.ts';
import { MemberRuntime } from './memberRuntime.ts';
import { OperatorActions, PLAN_REVIEW_REASON, type MergeAllResult } from './operatorApi.ts';
import { OPERATOR_TOOLS, callOperatorTool } from './operatorTools.ts';
import { TERMINAL_NOTE, briefing, operatorBriefing } from './prompts.ts';
import { ReplyTracker } from './replies.ts';
import {
  TeamAuthError, TeamContext, TeamError, isPlanStatus, resumePhaseOf, withResumePhase,
  type Membership, type TeamHost, type TeamManagerOptions, type TeamStore,
} from './teamContext.ts';
import { parseTeamInput, slug } from './teamInput.ts';
import { advertisedTools, callTool, type ToolDefinition } from './tools.ts';
import { EVERYONE, OPERATOR, SYSTEM, type TeamLogEntry, type TeamMember, type TeamState, type TeamTask, type TeamView } from './types.ts';
import {
  WorkspaceError, createWorktree, deleteBranch, diffWorktree, mergeMember, prepareRepo, removeWorktree, type MemberDiff,
} from './workspace.ts';

export { TEAM_MCP_SCRIPT, TOKEN_ENV, TeamAuthError, TeamError } from './teamContext.ts';
export type { TeamHost, TeamManagerOptions, TeamStore } from './teamContext.ts';
export type { MergeAllResult } from './operatorApi.ts';

const ACTIVITY_KINDS = new Set<AgentEvent['kind']>(['tool_call', 'assistant', 'error', 'stop']);
const ARCHIVED_REASON = 'Disbanded. The log stays readable until you remove the team.';

/** Everything needed to continue a member's own session in the operator's terminal. */
export interface MemberHandoff {
  readonly vendor: TeamMember['vendor'];
  readonly model?: string;
  readonly sessionId: string;
  readonly cwd: string;
  /** Fresh member token for the terminal session's team tools. */
  readonly token: string;
  readonly briefing: string;
  readonly mcpServers: Readonly<Record<string, StdioMcpServer>>;
}

/** Scoped access for the operator's own Claude Code session on a team. */
export interface OperatorAccess {
  readonly token: string;
  readonly briefing: string;
  readonly mcpServers: Readonly<Record<string, StdioMcpServer>>;
  readonly cwd: string;
}

/**
 * A team loaded after a restart has no live agents: members relaunch (on their saved sessions) when it is resumed.
 * A member that was open in the operator's CLI lost its team access with the restart; it rejoins (same session) on resume.
 * A team waiting for plan approval stays in review: nothing was running.
 */
export function restored(saved: TeamState, now: number): TeamState {
  const wasActive = saved.status === 'running' || saved.status === 'paused' || saved.status === 'planning';
  const inCli = saved.members.filter((member) => member.terminal);
  const cliNote = inCli.length
    ? ` ${inCli.map((m) => m.name).join(', ')} rejoin${inCli.length === 1 ? 's' : ''} the team on resume: close any CLI tab still open for ${inCli.length === 1 ? 'it' : 'them'} first.`
    : '';
  const stop = saved.status !== 'disbanded' && (wasActive || inCli.length > 0);
  const next: TeamState = {
    ...saved,
    status: stop ? 'stopped' : saved.status,
    statusReason: stop ? `The tower restarted. Resume to continue.${cliNote}` : saved.statusReason,
    // A crash mid-disband still leaves an archive.
    archivedAt: saved.status === 'disbanded' ? saved.archivedAt ?? now : saved.archivedAt,
    requirePlanApproval: saved.requirePlanApproval ?? false,
    members: saved.members.map((member) => ({
      ...member,
      agentId: undefined,
      terminal: undefined,
      resumeSessionId: member.terminal?.sessionId ?? member.resumeSessionId,
    })),
  };
  return withResumePhase(saved, next);
}

/**
 * Runs agent teams: git-worktree sandboxes, a shared channel + task board reached through MCP,
 * automatic wake-ups when a member has mail, an optional plan-review gate, and budgets that pause
 * the team instead of looping. This class is the façade; the work lives in the helper modules.
 */
export class TeamManager extends EventEmitter<{ teams: [TeamView[]]; log: [TeamLogEntry] }> {
  private readonly ctx: TeamContext;
  private readonly runtime: MemberRuntime;
  private readonly replies = new ReplyTracker();
  private readonly delivery: Delivery;
  private readonly operator: OperatorActions;

  constructor(host: TeamHost, store: TeamStore, opts: TeamManagerOptions) {
    super();
    this.ctx = new TeamContext(host, store, opts, {
      teams: (views) => this.emit('teams', views),
      log: (entry) => this.emit('log', entry),
    });
    this.runtime = new MemberRuntime(this.ctx);
    this.delivery = new Delivery(this.ctx, this.runtime, this.replies);
    this.operator = new OperatorActions(this.ctx, this.delivery, this.runtime, this);
    for (const saved of store.loadTeams()) {
      const team = restored(saved, this.ctx.now());
      this.ctx.teams.set(team.id, team);
      store.saveTeam(team);
    }
  }

  /** Base URL of the daemon, handed to each member's MCP bridge. */
  setEndpoint(url: string): void {
    this.ctx.endpoint = url;
  }

  list(): TeamView[] {
    return this.ctx.list();
  }

  log(teamId: string): TeamLogEntry[] {
    this.ctx.require(teamId);
    return this.ctx.store.teamLog(teamId);
  }

  async create(raw: unknown): Promise<{ team: TeamView; notes: readonly string[] }> {
    const input = parseTeamInput(raw);
    if (!this.ctx.endpoint) throw new TeamError('The team channel is not ready yet. Try again in a moment.');
    if (input.members.some((m) => m.vendor === 'codex') && !this.ctx.host.codexAvailable()) {
      throw new TeamError('Codex CLI not found (expected an npm global install of @openai/codex).');
    }
    const repo = await prepareRepo(input.cwd, { initGit: input.initGit });
    const id = randomBytes(3).toString('hex');
    const branchBase = `team/${slug(input.name)}-${id}`;
    const members: TeamMember[] = input.members.map((m) => ({
      ...m,
      id: m.name,
      worktree: join(this.ctx.opts.teamsDir, id, m.name),
      branch: `${branchBase}/${m.name}`,
      merged: false,
    }));
    await this.createWorktrees(repo.root, repo.head, members);
    const now = this.ctx.now();
    const requirePlanApproval = input.requirePlanApproval !== false;
    this.ctx.commit({
      id,
      name: input.name,
      goal: input.goal,
      repoRoot: repo.root,
      baseBranch: repo.branch,
      baseCommit: repo.head,
      status: requirePlanApproval ? 'planning' : 'running',
      createdAt: now,
      members,
      tasks: [],
      messages: [],
      readUpTo: {},
      budget: { maxWakes: input.maxWakes, wakesUsed: 0, deadline: now + input.maxMinutes * 60_000 },
      idleNudged: false,
      intercept: input.intercept,
      requirePlanApproval,
    });
    this.ctx.host.audit('team_create', repo.root, { team: id, goal: input.goal, members: input.members, requirePlanApproval });
    const roster = members.map((m) => `${m.name} (${m.role}, ${m.vendor}${m.model ? ` ${m.model}` : ''})`).join(', ');
    this.ctx.append(id, 'system', SYSTEM, `Team created from ${repo.branch} @ ${repo.head.slice(0, 7)}: ${roster}`);
    for (const note of repo.notes) this.ctx.append(id, 'system', SYSTEM, note);
    const leader = members.find((m) => m.role === 'lead')!;
    const kickoff = requirePlanApproval
      ? 'Plan the work: create the tasks (assign each one), then call submit_plan and end your turn. The operator reviews your plan before anyone starts.'
      : 'Plan the work and delegate it to your teammates now.';
    this.delivery.post(id, OPERATOR, leader.id, `Team goal: ${input.goal}\n\n${kickoff}`);
    return { team: this.ctx.list().find((view) => view.id === id)!, notes: repo.notes };
  }

  // ---- agent-facing (MCP bridge) ------------------------------------------------------------

  authenticate(token: string | undefined): Membership | undefined {
    return this.ctx.authenticate(token);
  }

  toolsForToken(token: string | undefined): readonly ToolDefinition[] {
    if (this.isOperatorToken(token)) return OPERATOR_TOOLS;
    const { team, member } = this.caller(token);
    return advertisedTools(memberById(team, member)!);
  }

  isOperatorToken(token: string | undefined): boolean {
    const membership = this.ctx.authenticate(token);
    const status = membership?.operator ? this.ctx.teams.get(membership.teamId)?.status : undefined;
    return status !== undefined && status !== 'disbanded';
  }

  /** Tool calls from the operator's own CLI session. Bad input comes back as a tool error, as for members. */
  async callOperatorForToken(token: string | undefined, name: unknown, args: unknown): Promise<{ text: string; isError: boolean }> {
    const membership = this.ctx.authenticate(token);
    if (!membership || !this.isOperatorToken(token)) throw new TeamAuthError('not a team operator');
    try {
      return { text: await callOperatorTool(this.operator.toolApi(membership.teamId), String(name ?? ''), toolArgs(args)), isError: false };
    } catch (error) {
      const expected = error instanceof BoardError || error instanceof TeamError || error instanceof WorkspaceError;
      if (expected) return { text: (error as Error).message, isError: true };
      throw error;
    }
  }

  callForToken(token: string | undefined, name: unknown, args: unknown): { text: string; isError: boolean } {
    const { team, member } = this.caller(token);
    try {
      const outcome = callTool(team, member, String(name ?? ''), toolArgs(args));
      const changed = outcome.state !== team;
      const finished = outcome.finished !== undefined;
      const submitted = outcome.submittedPlan === true;
      if (changed || finished || submitted) this.ctx.commit(this.afterTool(outcome.state, finished, submitted));
      for (const entry of outcome.log) this.ctx.append(team.id, entry.kind, member, entry.summary, { to: entry.to, messageId: entry.messageId });
      if (submitted) this.ctx.append(team.id, 'system', SYSTEM, PLAN_REVIEW_REASON);
      if (changed && !finished) this.delivery.deliverAll(team.id);
      return { text: outcome.text, isError: false };
    } catch (error) {
      if (error instanceof BoardError) return { text: error.message, isError: true };
      throw error;
    }
  }

  private afterTool(state: TeamState, finished: boolean, submitted: boolean): TeamState {
    if (finished) return { ...state, idleNudged: false, status: 'done', statusReason: 'The lead finished. Review each branch and merge.' };
    // Submitted while paused mid-plan: the team stays paused and resumes into review (resumePhase).
    if (submitted && state.status === 'plan_review') return { ...state, idleNudged: false, statusReason: PLAN_REVIEW_REASON };
    return { ...state, idleNudged: false };
  }

  // ---- tower hooks --------------------------------------------------------------------------

  /** Every managed agent snapshot passes through here: sessions are saved, turn ends logged, idle members get their mail. */
  onAgent(agent: Agent): void {
    const membership = this.ctx.byAgent.get(agent.id);
    if (!membership) return;
    this.runtime.recordSession(membership, agent);
    if (agent.status === 'stopped') {
      this.endTurn(membership, agent);
      if (this.runtime.release(membership, agent.id)) {
        this.delivery.deliverAll(membership.teamId);
        this.delivery.checkIdle(membership.teamId);
      }
      return;
    }
    if (agent.status !== 'idle') return;
    this.endTurn(membership, agent);
    this.delivery.deliver(membership.teamId, membership.memberId);
    this.delivery.checkIdle(membership.teamId);
  }

  /** The turn is over: log the member's final text once, as a reply to whoever woke it, and fold its cost in. */
  private endTurn(membership: Membership, agent: Agent): void {
    this.runtime.recordCost(membership, agent);
    const reply = this.replies.endTurn(agent.id, membership.teamId, membership.memberId);
    if (reply && this.ctx.teams.has(membership.teamId)) {
      this.ctx.append(membership.teamId, 'reply', membership.memberId, reply.text, { to: reply.to });
    }
  }

  /** Member activity in the shared timeline. Assistant text is held until the turn ends (see endTurn). */
  onAgentEvent(event: AgentEvent): void {
    const membership = this.ctx.byAgent.get(event.agentId);
    if (!membership || !ACTIVITY_KINDS.has(event.kind) || !this.ctx.teams.has(membership.teamId)) return;
    if (event.kind === 'assistant') {
      this.replies.onAssistant(event.agentId, event.summary);
      return;
    }
    const kind = event.kind === 'error' ? 'system' : 'activity';
    this.ctx.append(membership.teamId, kind, membership.memberId, event.kind === 'tool_call' ? `⚙ ${event.summary}` : event.summary);
  }

  /** Graceful daemon stop: running (or planning) teams become resumable instead of silently dead. */
  shutdown(): void {
    for (const team of this.ctx.teams.values()) {
      if (team.status === 'running' || team.status === 'paused' || team.status === 'planning') {
        this.ctx.commit({ ...team, status: 'stopped', statusReason: 'The tower stopped. Resume to continue.' });
      }
    }
  }

  // ---- the operator's terminal --------------------------------------------------------------

  memberForAgent(agentId: string): { readonly teamId: string; readonly memberId: string } | undefined {
    return this.ctx.byAgent.get(agentId);
  }

  /**
   * Stop the tower's copy of an idle member so the operator can continue the same session in the real CLI.
   * Until returnMember, the member is never woken or relaunched: its mail waits.
   */
  async handOffMember(teamId: string, memberId: string): Promise<MemberHandoff> {
    this.ctx.requireActive(teamId);
    const { team, member } = this.ctx.requireMember(teamId, memberId);
    if (member.terminal) throw new TeamError(`${member.name} is already open in your terminal.`);
    const agentId = member.agentId;
    const runner = agentId ? this.ctx.host.runner(agentId) : undefined;
    if (!agentId || !runner) throw new TeamError(`${member.name} has no session yet. It starts when it gets its first message.`);
    const status = this.ctx.host.agent(agentId)?.status;
    if (status === 'busy' || status === 'waiting') {
      throw new TeamError(`${member.name} is mid-turn. Wait for its turn to end (or interrupt it), then open it.`);
    }
    const sessionId = runner.sessionId;
    if (!sessionId) throw new TeamError(`${member.name} has no session id yet.`);
    this.ctx.host.audit('team_member_terminal', teamId, { member: member.name, sessionId });
    this.ctx.commit(replaceMember(team, member.id, { terminal: { sessionId, since: this.ctx.now() }, sessionId }));
    try {
      await runner.stop();
    } catch (error) {
      // The managed copy may still be running: undo, so the team keeps using it.
      this.ctx.commit(replaceMember(this.ctx.require(teamId), member.id, { terminal: undefined }));
      throw new TeamError(`Could not stop ${member.name} to hand it over: ${(error as Error).message}`);
    }
    this.runtime.release({ teamId, memberId: member.id }, agentId);
    const token = this.ctx.issueToken({ teamId, memberId: member.id });
    this.ctx.append(teamId, 'system', SYSTEM, `${member.name} is open in the operator's terminal. The team won't wake it until that session closes.`);
    return {
      vendor: member.vendor,
      model: member.model,
      sessionId,
      cwd: member.worktree,
      token,
      briefing: `${briefing(this.ctx.require(teamId), member)}\n\n${TERMINAL_NOTE}`,
      mcpServers: this.ctx.mcpServers(),
    };
  }

  /** The operator's terminal session ended: the member rejoins the team and continues the same session when next woken. */
  returnMember(teamId: string, memberId: string): void {
    const team = this.ctx.teams.get(teamId);
    const member = team ? memberById(team, memberId) : undefined;
    if (!team || !member?.terminal || team.status === 'disbanded') return;
    this.ctx.revokeMember(teamId, member.id);
    this.ctx.commit(replaceMember(team, member.id, { terminal: undefined, resumeSessionId: member.terminal.sessionId }));
    this.ctx.append(teamId, 'system', SYSTEM, `${member.name} is back with the team and continues the same session.`);
    this.delivery.deliverAll(teamId);
    // No mail woke it: bring it back idle now, so it stays a live member that only Waystation can stop.
    const after = this.ctx.teams.get(teamId);
    const back = after ? memberById(after, member.id) : undefined;
    if (after && back && !back.agentId && after.status !== 'disbanded') this.runtime.startIdle(after, back);
    this.delivery.checkIdle(teamId);
  }

  /** A scoped token and briefing for the operator's own Claude Code session on this team. */
  operatorAccess(teamId: string): OperatorAccess {
    const team = this.ctx.requireActive(teamId);
    const token = this.ctx.issueToken({ teamId, memberId: OPERATOR, operator: true });
    this.ctx.host.audit('team_operator_session', teamId, {});
    this.ctx.append(teamId, 'system', OPERATOR, 'The operator opened a Claude Code session for this team.');
    return { token, briefing: operatorBriefing(team), mcpServers: this.ctx.mcpServers(), cwd: team.repoRoot };
  }

  revokeToken(token: string): void {
    this.ctx.revokeToken(token);
  }

  // ---- operator actions ---------------------------------------------------------------------

  /**
   * Post as the operator. During plan review a message to the lead is feedback: the team goes back to
   * planning and the lead is woken. Other mail queues until the phase lets it through.
   */
  message(teamId: string, to: unknown, text: unknown): string {
    const team = this.ctx.requireActive(teamId);
    const recipient = typeof to === 'string' && to.trim() ? to : EVERYONE;
    if (typeof text !== 'string' || !text.trim()) throw new TeamError('Message text is required.');
    this.ctx.host.audit('team_message', teamId, { to: recipient, text });
    const toLead = memberByName(team, recipient)?.id === lead(team).id;
    const feedback = toLead && planPhase(team) === 'plan_review';
    if (feedback) this.backToPlanning(team);
    this.delivery.post(teamId, OPERATOR, recipient, text);
    if (feedback && team.status === 'plan_review') return 'Sent to the lead as feedback on its plan.';
    if (feedback) return 'Queued as feedback on the plan. Resume the team to deliver it to the lead.';
    if (team.status === 'running' || (team.status === 'planning' && toLead)) return 'Sent.';
    if (isPlanStatus(team.status)) return 'Queued until the plan is approved.';
    return 'Queued. Resume the team to deliver it.';
  }

  /** Feedback on a plan in review: back to planning, or (when paused mid-review) resume into planning. */
  private backToPlanning(team: TeamState): void {
    const paused = team.status !== 'plan_review';
    this.ctx.commit(paused
      ? { ...team, resumePhase: 'planning' }
      : { ...team, status: 'planning', statusReason: 'The operator sent feedback on the plan. The lead is revising it.' });
    this.ctx.append(team.id, 'system', OPERATOR, `The operator sent feedback on the plan; back to planning${paused ? ' on resume' : ''}.`);
  }

  pause(teamId: string): void {
    this.ctx.requireActive(teamId);
    this.ctx.host.audit('team_pause', teamId, {});
    this.ctx.setStatus(teamId, 'paused', 'Paused by the operator. Agents finish their current turn.');
  }

  /** Back to the phase the team was stopped in (planning, plan review, or running), with extra budget and time. */
  resume(teamId: string): void {
    const team = this.ctx.requireActive(teamId);
    if (team.status === 'running' || isPlanStatus(team.status)) return;
    this.ctx.host.audit('team_resume', teamId, {});
    const now = this.ctx.now();
    const phase = resumePhaseOf(team) ?? 'running';
    const members = team.members.map((member) => {
      const live = member.agentId && this.ctx.host.runner(member.agentId) && this.ctx.agentStatus(member) !== 'stopped';
      return live ? member : { ...member, agentId: undefined };
    });
    this.ctx.commit({
      ...team,
      members,
      status: phase,
      statusReason: phase === 'plan_review' ? PLAN_REVIEW_REASON : undefined,
      idleNudged: false,
      budget: {
        ...team.budget,
        maxWakes: Math.max(team.budget.maxWakes, team.budget.wakesUsed + RESUME_GRANT.wakes),
        deadline: Math.max(team.budget.deadline, now + RESUME_GRANT.minutes * 60_000),
      },
    });
    this.ctx.append(teamId, 'system', SYSTEM, 'Resumed by the operator.');
    // In plan review nobody is woken: the plan waits for the operator.
    if (phase !== 'plan_review') {
      this.delivery.post(teamId, SYSTEM, lead(team).id, 'The operator resumed the team. Check read_messages and list_tasks, then continue.');
    }
  }

  approvePlan(teamId: string): void {
    this.operator.approvePlan(teamId);
  }

  createTask(teamId: string, raw: unknown): TeamTask {
    return this.operator.createTask(teamId, raw);
  }

  updateTask(teamId: string, taskId: string, raw: unknown): TeamTask {
    return this.operator.updateTask(teamId, taskId, raw);
  }

  removeTask(teamId: string, taskId: string): void {
    this.operator.removeTask(teamId, taskId);
  }

  async diff(teamId: string, memberId: string): Promise<MemberDiff> {
    const { team, member } = this.ctx.requireMember(teamId, memberId);
    return diffWorktree(member.worktree, team.baseCommit);
  }

  async merge(teamId: string, memberId: string): Promise<string> {
    this.ctx.requireActive(teamId);
    const { team, member } = this.ctx.requireMember(teamId, memberId);
    if (member.terminal) throw new TeamError(`${member.name} is open in your CLI. Close it (or use Take back) before merging.`);
    const status = this.ctx.agentStatus(member);
    if (status === 'busy' || status === 'waiting') {
      throw new TeamError(`${member.name} is still working. Pause the team or wait for its turn to end, then merge.`);
    }
    const { commits } = await mergeMember({
      root: team.repoRoot, baseBranch: team.baseBranch, branch: member.branch, worktree: member.worktree, memberName: member.name,
    });
    this.ctx.commit(replaceMember(this.ctx.require(teamId), member.id, { merged: true }));
    this.ctx.host.audit('team_merge', teamId, { member: member.name, branch: member.branch, commits });
    this.ctx.append(teamId, 'merge', OPERATOR, `Merged ${member.branch} into ${team.baseBranch} (${commits} commit${commits === 1 ? '' : 's'})`);
    return `Merged ${member.name}'s work into ${team.baseBranch}.`;
  }

  mergeAll(teamId: string): Promise<MergeAllResult> {
    return this.operator.mergeAll(teamId);
  }

  /** Stop every member, revoke all access, and keep the team as a read-only archive until remove(). */
  async disband(teamId: string, opts: { removeWorktrees: boolean }): Promise<{ keptBranches: string[] }> {
    const team = this.ctx.require(teamId);
    if (team.status === 'disbanded') throw new TeamError('This team is already disbanded.');
    this.ctx.host.audit('team_disband', teamId, opts);
    this.ctx.commit({ ...team, status: 'disbanded', statusReason: 'Disbanding…' });
    await Promise.allSettled(team.members.flatMap((m) => {
      const runner = m.agentId ? this.ctx.host.runner(m.agentId) : undefined;
      return runner ? [runner.stop()] : [];
    }));
    if (opts.removeWorktrees) {
      for (const member of team.members) {
        await removeWorktree(team.repoRoot, member.worktree).catch((error: Error) =>
          this.ctx.append(teamId, 'system', SYSTEM, `Could not remove ${member.worktree}: ${error.message}`));
      }
    }
    for (const member of team.members) if (member.agentId) this.replies.forgetAgent(member.agentId);
    this.ctx.revokeTeam(teamId);
    const current = this.ctx.require(teamId);
    this.ctx.commit({
      ...current,
      statusReason: ARCHIVED_REASON,
      archivedAt: this.ctx.now(),
      members: current.members.map((m) => ({ ...m, agentId: undefined, terminal: undefined })),
    });
    this.ctx.append(teamId, 'system', OPERATOR, `Team disbanded${opts.removeWorktrees ? ' and worktrees removed' : ''}.`);
    return { keptBranches: team.members.filter((m) => !m.merged).map((m) => m.branch) };
  }

  /** Delete a disbanded team's archive (state and list entry). */
  remove(teamId: string): void {
    const team = this.ctx.require(teamId);
    if (team.status !== 'disbanded' || team.archivedAt === undefined) throw new TeamError('Only a disbanded team can be removed. Disband it first.');
    this.ctx.host.audit('team_remove', teamId, {});
    this.ctx.forget(teamId);
  }

  // ---- internals ----------------------------------------------------------------------------

  private async createWorktrees(root: string, head: string, members: readonly TeamMember[]): Promise<void> {
    const created: TeamMember[] = [];
    try {
      for (const member of members) {
        await createWorktree(root, member.worktree, member.branch, head);
        created.push(member);
      }
    } catch (error) {
      for (const member of created) {
        await removeWorktree(root, member.worktree).catch(() => undefined);
        await deleteBranch(root, member.branch);
      }
      throw error;
    }
  }

  private caller(token: string | undefined): { team: TeamState; member: string } {
    const membership = this.ctx.authenticate(token);
    const team = membership ? this.ctx.teams.get(membership.teamId) : undefined;
    if (!membership || membership.operator || !team || team.status === 'disbanded') throw new TeamAuthError('not a team member');
    return { team, member: membership.memberId };
  }
}

const toolArgs = (args: unknown): Record<string, unknown> =>
  args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
