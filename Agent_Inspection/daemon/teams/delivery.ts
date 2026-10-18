import { lead, markRead, memberById, postMessage, replaceMember, unreadFor, type BoardNotice } from './board.ts';
import { addSpend, type MemberRuntime } from './memberRuntime.ts';
import { idleNudge, wakeText } from './prompts.ts';
import { wakerOf, type ReplyTracker } from './replies.ts';
import type { TeamContext } from './teamContext.ts';
import { SYSTEM, type Actor, type TeamMember, type TeamState } from './types.ts';

/**
 * The mailbox: posting to the channel and waking members with their unread mail, within the team's
 * phase rules and budget. While planning only the lead is woken; during plan review nobody is.
 */

export const PLANNING_IDLE_REASON = 'The lead ended its turn without submitting a plan. Send it feedback, or resume to let it keep planning.';
export const PLANNING_EXIT_REASON = 'The lead stopped before submitting a plan. Resume or message it to continue.';

/** Who may be woken in the team's current phase. */
function wakeable(team: TeamState, member: TeamMember): boolean {
  if (member.terminal) return false;
  if (team.status === 'running') return true;
  return team.status === 'planning' && member.role === 'lead';
}

export class Delivery {
  constructor(
    private readonly ctx: TeamContext,
    private readonly runtime: MemberRuntime,
    private readonly replies: ReplyTracker,
  ) {}

  /** Post one message, log it (body only), then deliver whatever is now deliverable. */
  post(teamId: string, from: Actor, to: string, text: string): void {
    const team = this.ctx.require(teamId);
    const next = postMessage(team, from, to, text, this.ctx.now());
    this.ctx.commit({ ...next, idleNudged: from === SYSTEM ? team.idleNudged : false });
    this.logLast(teamId, next, from);
    this.deliverAll(teamId);
  }

  /** Post tower notices (task assignment, plan approval) to members, then deliver. */
  postNotices(teamId: string, notices: readonly BoardNotice[]): void {
    if (notices.length === 0) return;
    for (const notice of notices) {
      const next = postMessage(this.ctx.require(teamId), SYSTEM, notice.to, notice.text, this.ctx.now());
      this.ctx.commit(next);
      this.logLast(teamId, next, SYSTEM);
    }
    this.deliverAll(teamId);
  }

  private logLast(teamId: string, state: TeamState, from: Actor): void {
    const sent = state.messages[state.messages.length - 1];
    this.ctx.append(teamId, 'message', from, sent.text, { to: sent.to, messageId: sent.id });
  }

  deliverAll(teamId: string): void {
    for (const member of this.ctx.teams.get(teamId)?.members ?? []) this.deliver(teamId, member.id);
  }

  /** Wake one member with its unread mail, if its phase allows it, it is idle (or not started) and budget remains. */
  deliver(teamId: string, memberId: string): void {
    const team = this.ctx.teams.get(teamId);
    const member = team ? memberById(team, memberId) : undefined;
    if (!team || !member || !wakeable(team, member)) return;
    const unread = unreadFor(team, memberId);
    if (unread.length === 0) return;
    const runner = member.agentId ? this.ctx.host.runner(member.agentId) : undefined;
    if (member.agentId && (!runner || this.ctx.host.agent(member.agentId)?.status !== 'idle')) return;
    const charged = this.charge(team, member);
    if (!charged) return;
    const text = wakeText(charged, member, unread);
    this.replies.wokeBy(teamId, memberId, wakerOf(unread));
    if (!runner) {
      const started = this.runtime.start(charged, member, text);
      if (!started.ok) {
        this.replies.wokeBy(teamId, memberId, undefined);
        this.ctx.setStatus(teamId, 'paused', `Could not start ${member.name}: ${started.error}`);
      }
      return;
    }
    // Commit before sending: send() re-enters onAgent synchronously and must see the mail as read.
    this.ctx.commit(markRead(charged, memberId));
    runner.send(text).catch((error: Error) => this.undoDelivery(teamId, member, unread[0].id, error));
  }

  /**
   * The wake never reached the agent: make its mail unread again (by message id, indexes may have shifted), refund the wake,
   * and pause with the error so the operator sees it; Resume retries the delivery.
   */
  private undoDelivery(teamId: string, member: TeamMember, firstMessageId: string, error: Error): void {
    const current = this.ctx.teams.get(teamId);
    const now = current ? memberById(current, member.id) : undefined;
    if (!current || !now) return;
    const index = current.messages.findIndex((m) => m.id === firstMessageId);
    const upTo = current.readUpTo[member.id] ?? 0;
    const refunded = replaceMember(current, member.id, { spend: addSpend(now, 0, now.spend?.turns ? -1 : 0) });
    this.ctx.commit({
      ...refunded,
      readUpTo: { ...current.readUpTo, [member.id]: index >= 0 ? Math.min(upTo, index) : upTo },
      budget: { ...current.budget, wakesUsed: Math.max(0, current.budget.wakesUsed - 1) },
    });
    this.replies.wokeBy(teamId, member.id, undefined);
    if (current.status === 'disbanded') return;
    this.ctx.setStatus(teamId, 'paused', `Could not deliver to ${member.name}: ${error.message}. Resume to retry.`);
  }

  /** Charge one wake-up (and one turn to the member), or pause the team when the budget or time limit is spent. */
  private charge(team: TeamState, member: TeamMember): TeamState | undefined {
    if (this.ctx.now() > team.budget.deadline) {
      this.ctx.setStatus(team.id, 'paused', 'Time limit reached. Resume to give the team more time.');
      return undefined;
    }
    if (team.budget.wakesUsed >= team.budget.maxWakes) {
      this.ctx.setStatus(team.id, 'paused', 'Wake-up budget used up. Resume to continue.');
      return undefined;
    }
    const counted = replaceMember(team, member.id, { spend: addSpend(member, 0, 1) });
    return { ...counted, budget: { ...team.budget, wakesUsed: team.budget.wakesUsed + 1 } };
  }

  /**
   * Running: when nobody is working and nothing is queued, prompt the lead once; if that changes nothing, pause.
   * Planning: remind the lead once to submit its plan before pausing.
   */
  checkIdle(teamId: string): void {
    const team = this.ctx.teams.get(teamId);
    if (!team) return;
    if (team.status === 'planning') {
      this.checkPlanningIdle(team);
      return;
    }
    // A member open in the operator's terminal counts as busy: the human is working with it.
    if (team.status !== 'running' || team.members.some((m) => m.terminal)) return;
    const working = team.members.some((m) => {
      const status = this.ctx.agentStatus(m);
      return status === 'busy' || status === 'waiting';
    });
    if (working) return;
    const deliverable = team.members.some((m) => this.ctx.agentStatus(m) === 'idle' && unreadFor(team, m.id).length > 0);
    if (deliverable) return;
    if (team.idleNudged) {
      this.ctx.setStatus(teamId, 'paused', 'Everyone went idle. Send the team a message or resume to continue.');
      return;
    }
    const leader = lead(team);
    this.ctx.commit({ ...postMessage(team, SYSTEM, leader.id, idleNudge(team), this.ctx.now()), idleNudged: true });
    this.ctx.append(teamId, 'system', SYSTEM, `Everyone is idle; prompted ${leader.name} to wrap up or reassign.`);
    this.deliver(teamId, leader.id);
  }

  /** In planning only the lead works: once it is idle or gone with nothing to read, nothing else will move the team. */
  private checkPlanningIdle(team: TeamState): void {
    const leader = lead(team);
    if (leader.terminal || unreadFor(team, leader.id).length > 0) return;
    const status = this.ctx.agentStatus(leader);
    if (status === 'idle') {
      if (team.idleNudged) {
        this.ctx.setStatus(team.id, 'paused', PLANNING_IDLE_REASON);
        return;
      }
      const reminder = 'Your planning turn ended without submitting a plan. Create or revise the tasks with create_task/update_task, assign each task, then call submit_plan now so the operator can approve it. A text reply alone does not submit the plan. If you need information from the operator, ask a specific question and end your turn.';
      this.ctx.commit({ ...postMessage(team, SYSTEM, leader.id, reminder, this.ctx.now()), idleNudged: true });
      this.ctx.append(team.id, 'system', SYSTEM, `Reminded ${leader.name} to submit the plan before pausing.`);
      this.deliver(team.id, leader.id);
    }
    else if (status === undefined || status === 'stopped') this.ctx.setStatus(team.id, 'paused', PLANNING_EXIT_REASON);
  }
}
