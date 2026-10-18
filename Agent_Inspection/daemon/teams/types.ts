export type TeamRole = 'lead' | 'worker';
export type TeamVendor = 'claude' | 'codex';
import type { LaunchLoadout } from '../library/types.ts';

/**
 * planning: only the lead is woken, drafting tasks; nobody else is notified.
 * plan_review: the lead submitted its plan; nobody is woken until the operator approves it (or sends feedback).
 */
export type TeamStatus = 'planning' | 'plan_review' | 'running' | 'paused' | 'done' | 'stopped' | 'disbanded';
export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done';

/** Who wrote something on the team channel: a member id, the operator, or the tower itself. */
export type Actor = string;
export const OPERATOR = 'operator';
export const SYSTEM = 'tower';
export const EVERYONE = 'all';

export interface TeamMember {
  readonly id: string;
  /** Unique, lowercase handle that agents use to address each other. */
  readonly name: string;
  readonly role: TeamRole;
  readonly vendor: TeamVendor;
  readonly model?: string;
  /** Managed agent id once launched (members start lazily, on their first message). */
  readonly agentId?: string;
  readonly worktree: string;
  readonly branch: string;
  readonly merged: boolean;
  /** Set while the operator drives this member's session in their own terminal: the tower neither wakes nor relaunches it. */
  readonly terminal?: { readonly sessionId: string; readonly since: number };
  /** Session to continue on the member's next launch (set when it comes back from the operator's terminal). */
  readonly resumeSessionId?: string;
  /** What this member is responsible for, in the operator's words. Part of its briefing and of every roster. */
  readonly focus?: string;
  /** Last session id the member's agent reported. Any relaunch (restart, crash, Stop) continues it. */
  readonly sessionId?: string;
  /** Skills, docs, MCP servers, plugins and notify channels applied at every launch, as for single agents. */
  readonly loadout?: LaunchLoadout;
  /** Spend across all of this member's launches (agent usage resets per launch). */
  readonly spend?: MemberSpend;
}

export interface MemberSpend {
  readonly costUsd: number;
  readonly turns: number;
}

export interface TeamTask {
  readonly id: string;
  readonly title: string;
  readonly details: string;
  readonly status: TaskStatus;
  readonly assignee?: string;
  readonly createdBy: Actor;
  readonly note?: string;
  readonly updatedAt: number;
}

export interface TeamMessage {
  readonly id: string;
  readonly ts: number;
  readonly from: Actor;
  /** A member id, or EVERYONE. */
  readonly to: string;
  readonly text: string;
}

export interface TeamBudget {
  /** Each automatic wake-up of a member (one agent turn) costs one unit. */
  readonly maxWakes: number;
  readonly wakesUsed: number;
  readonly deadline: number;
}

export interface TeamState {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly repoRoot: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
  readonly status: TeamStatus;
  readonly statusReason?: string;
  readonly createdAt: number;
  readonly members: readonly TeamMember[];
  readonly tasks: readonly TeamTask[];
  readonly messages: readonly TeamMessage[];
  /** Per member: index into `messages` up to which it has been delivered. */
  readonly readUpTo: Readonly<Record<string, number>>;
  readonly budget: TeamBudget;
  readonly summary?: string;
  /** Set when the tower nudged the lead about an all-idle team, cleared by any agent action. */
  readonly idleNudged: boolean;
  readonly intercept: boolean;
  /** The lead's plan must be approved by the operator before workers are woken. */
  readonly requirePlanApproval: boolean;
  /** Set when the team was disbanded: it stays as a read-only archive until the operator removes it. */
  readonly archivedAt?: number;
  /**
   * Set while the team is paused or stopped in the middle of plan review: the phase resume returns to.
   * Plan-phase rules (no assignee notices, submit_plan instead of finish_team) keep applying meanwhile.
   */
  readonly resumePhase?: PlanPhase;
}

export type PlanPhase = 'planning' | 'plan_review';

/**
 * message: mail that was posted to the channel and is (or will be) delivered to `to`.
 * reply:   a member's final text for one turn. Shown to the operator only; never delivered to teammates.
 * activity: tool calls (hidden by default). task / system / merge: board and tower notices.
 */
export type TeamLogKind = 'message' | 'reply' | 'task' | 'activity' | 'system' | 'merge';

export interface TeamLogEntry {
  readonly teamId: string;
  readonly ts: number;
  readonly kind: TeamLogKind;
  readonly actor: Actor;
  /** Body text only (no "a → b:" prefix): the UI renders sender and recipient from the fields. */
  readonly summary: string;
  /** message: recipient member id or EVERYONE. reply: who woke the member for this turn (OPERATOR, SYSTEM or a member id). */
  readonly to?: string;
  /** message: the TeamMessage id, so the UI can show queued vs delivered. */
  readonly messageId?: string;
}

/** What the UI receives: the state without delivery bookkeeping or message bodies. */
export interface TeamView {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly repoRoot: string;
  readonly baseBranch: string;
  readonly status: TeamStatus;
  readonly statusReason?: string;
  readonly createdAt: number;
  readonly members: readonly TeamMember[];
  readonly tasks: readonly TeamTask[];
  readonly budget: TeamBudget;
  readonly summary?: string;
  readonly requirePlanApproval: boolean;
  readonly archivedAt?: number;
  /** Per member id: messages posted but not yet delivered to it. */
  readonly pending: Readonly<Record<string, number>>;
  /** Per member id: ids of messages still waiting for it (queued, not delivered). */
  readonly pendingIds: Readonly<Record<string, readonly string[]>>;
  /** What Resume adds, so the UI can say it before the operator clicks. */
  readonly resumeGrant: { readonly wakes: number; readonly minutes: number };
  /** Sum of members' spend. */
  readonly spend: MemberSpend;
}
