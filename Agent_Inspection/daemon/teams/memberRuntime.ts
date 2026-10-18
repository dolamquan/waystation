import { join } from 'node:path';
import type { Agent } from '../domain/types.ts';
import { markRead, memberById, replaceMember } from './board.ts';
import { briefing } from './prompts.ts';
import { TOKEN_ENV, type Membership, type TeamContext } from './teamContext.ts';
import { SYSTEM, type MemberSpend, type TeamMember, type TeamState } from './types.ts';

/** Member agents: launching (always on the member's own session), exits, and per-member session + spend bookkeeping. */

const NO_SPEND: MemberSpend = { costUsd: 0, turns: 0 };

export function addSpend(member: TeamMember, costUsd: number, turns: number): MemberSpend {
  const spend = member.spend ?? NO_SPEND;
  return { costUsd: spend.costUsd + costUsd, turns: spend.turns + turns };
}

export class MemberRuntime {
  /** Per agent id: the launch's cumulative cost already folded into the member's spend. */
  private costSeen = new Map<string, number>();

  constructor(private readonly ctx: TeamContext) {}

  /** Launch a member's agent. Any relaunch (restart, crash, Stop, back from the terminal) continues its last session. */
  launch(team: TeamState, member: TeamMember, firstPrompt: string): string {
    const mcpServers = this.ctx.mcpServers();
    const token = this.ctx.issueToken({ teamId: team.id, memberId: member.id });
    const resumeSessionId = member.resumeSessionId ?? member.sessionId;
    const { opts } = this.ctx;
    const agent = this.ctx.host.launch({
      vendor: member.vendor,
      cwd: member.worktree,
      prompt: firstPrompt,
      appendSystemPrompt: briefing(team, member),
      name: `${team.name} · ${member.name}`.slice(0, 80),
      model: member.model,
      intercept: team.intercept && member.vendor === 'claude',
      writeRoot: member.worktree,
      readGuard: opts.privateRoot ? { deny: opts.privateRoot, allow: join(opts.teamsDir, team.id) } : undefined,
      // The token lives only in the agent's environment; the bridge inherits it (never on a command line).
      env: { [TOKEN_ENV]: token },
      mcpServers,
      ...(resumeSessionId ? { resumeSessionId, fork: false } : {}),
    }, member.loadout);
    this.ctx.bindAgent(agent.id, { teamId: team.id, memberId: member.id });
    this.costSeen = new Map([...this.costSeen, [agent.id, agent.usage?.costUsd ?? 0]]);
    return agent.id;
  }

  /**
   * Launch a member with its first mail on an already-charged state. Nothing is marked read or charged
   * unless the launch succeeds. On failure the caller pauses the team with the returned error.
   */
  start(charged: TeamState, member: TeamMember, firstPrompt: string): { ok: true } | { ok: false; error: string } {
    try {
      const agentId = this.launch(charged, member, firstPrompt);
      this.ctx.commit(replaceMember(markRead(charged, member.id), member.id, { agentId, resumeSessionId: undefined }));
      this.ctx.append(charged.id, 'system', SYSTEM, `${member.name} started (${member.vendor}${member.model ? ` ${member.model}` : ''}) in ${member.worktree}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  /** Relaunch a member on its saved session without a turn (and without spending budget). */
  startIdle(team: TeamState, member: TeamMember): void {
    try {
      const agentId = this.launch(team, member, '');
      this.ctx.commit(replaceMember(this.ctx.require(team.id), member.id, { agentId, resumeSessionId: undefined }));
    } catch (error) {
      this.ctx.append(team.id, 'system', SYSTEM, `Could not bring ${member.name} back yet: ${(error as Error).message}. It restarts with its next message.`);
    }
  }

  /** Save the session id whenever the agent reports a new one, so the next launch continues it. */
  recordSession(membership: Membership, agent: Agent): void {
    const team = this.ctx.teams.get(membership.teamId);
    const member = team ? memberById(team, membership.memberId) : undefined;
    if (!team || !member || !agent.sessionId || member.sessionId === agent.sessionId || member.agentId !== agent.id) return;
    this.ctx.commit(replaceMember(team, member.id, { sessionId: agent.sessionId }));
  }

  /** A turn ended: fold the launch's new cost into the member's spend (persisted here, not on every snapshot). */
  recordCost(membership: Membership, agent: Agent): void {
    const cost = agent.usage?.costUsd;
    const seen = this.costSeen.get(agent.id) ?? 0;
    if (cost === undefined || cost <= seen) return;
    this.costSeen = new Map([...this.costSeen, [agent.id, cost]]);
    const team = this.ctx.teams.get(membership.teamId);
    const member = team ? memberById(team, membership.memberId) : undefined;
    if (!team || !member) return;
    this.ctx.commit(replaceMember(team, member.id, { spend: addSpend(member, cost - seen, 0) }));
  }

  /**
   * A member's agent exited (crash, Stop from the drawer, or disband). Revoke its token and forget the
   * agent so the member restarts, with its unread mail, the next time it is woken.
   * Returns true when the caller should redeliver mail and re-check idleness.
   */
  release(membership: Membership, agentId: string): boolean {
    this.ctx.unbindAgent(agentId);
    this.costSeen = new Map([...this.costSeen].filter(([id]) => id !== agentId));
    this.ctx.revokeMember(membership.teamId, membership.memberId);
    const team = this.ctx.teams.get(membership.teamId);
    const member = team ? memberById(team, membership.memberId) : undefined;
    if (!team || !member || member.agentId !== agentId || team.status === 'disbanded') return false;
    this.ctx.commit(replaceMember(team, member.id, { agentId: undefined }));
    // Handed to the operator's terminal on purpose: nothing to restart.
    if (member.terminal || team.status === 'paused' || team.status === 'stopped' || team.status === 'done') return false;
    this.ctx.append(team.id, 'system', SYSTEM, `${member.name}'s agent exited. It restarts when it next has a message.`);
    return true;
  }

  /** Live state of a member, for the operator's status tool. */
  describe(member: TeamMember): string {
    if (member.terminal) return 'open in the operator\'s terminal';
    if (member.merged) return 'merged';
    if (!member.agentId) return 'not started';
    return this.ctx.agentStatus(member) ?? 'exited';
  }
}
