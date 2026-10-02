export type TeamRole = 'lead' | 'worker';
export type TeamVendor = 'claude' | 'codex';
export type TeamStatus = 'running' | 'paused' | 'done' | 'stopped' | 'disbanded';
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
}

export type TeamLogKind = 'message' | 'task' | 'activity' | 'system' | 'merge';

export interface TeamLogEntry {
  readonly teamId: string;
  readonly ts: number;
  readonly kind: TeamLogKind;
  readonly actor: Actor;
  readonly summary: string;
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
}
