import type { Agent, TeamMember, TeamTask, TeamView } from '../../api.ts';
import { STATUS_LABEL } from '../../format.ts';

export const TEAM_STATUS_LABEL: Readonly<Record<TeamView['status'], string>> = {
  planning: 'Planning',
  plan_review: 'Plan ready for review',
  running: 'Running',
  paused: 'Paused',
  done: 'Ready to merge',
  stopped: 'Stopped',
  disbanded: 'Disbanded',
};

export const TASK_STATUS_LABEL: Readonly<Record<TeamTask['status'], string>> = {
  open: 'Open', in_progress: 'In progress', blocked: 'Blocked', done: 'Done',
};

export const TASK_STATUSES: readonly TeamTask['status'][] = ['open', 'in_progress', 'blocked', 'done'];

/** Disbanded teams stay listed as read-only archives until the operator removes them. */
export const isArchived = (team: TeamView): boolean => team.status === 'disbanded' || team.archivedAt !== undefined;
export const canResume = (team: TeamView): boolean => team.status === 'paused' || team.status === 'stopped' || team.status === 'done';
export const canPause = (team: TeamView): boolean => team.status === 'running' || team.status === 'planning' || team.status === 'plan_review';

/** Tasks and messages may name a member by id or by handle. */
export const findMember = (team: TeamView, ref: string | undefined): TeamMember | undefined =>
  ref === undefined ? undefined : team.members.find((m) => m.id === ref || m.name === ref);

export const leadOf = (team: TeamView): TeamMember | undefined => team.members.find((m) => m.role === 'lead');

export const agentFor = (member: TeamMember, agents: readonly Agent[]): Agent | undefined =>
  member.agentId ? agents.find((a) => a.id === member.agentId) : undefined;

/** Display name for whoever wrote or received something on the team channel. */
export function actorName(team: TeamView, actor: string | undefined): string {
  if (actor === 'operator') return 'You';
  if (actor === 'tower') return 'Waystation';
  if (actor === 'all') return 'Everyone';
  return findMember(team, actor)?.name ?? actor ?? 'Someone';
}

export function memberStatus(member: TeamMember, agents: readonly Agent[]): { label: string; pill: string } {
  if (member.terminal) return { label: 'In your CLI', pill: 'pill-waiting' };
  if (!member.agentId) return { label: 'Not started', pill: 'pill-stopped' };
  const agent = agentFor(member, agents);
  if (!agent) return { label: 'Exited', pill: 'pill-stopped' };
  return { label: STATUS_LABEL[agent.status], pill: `pill-${agent.status}` };
}

export const resumeGrantText = (team: TeamView): string =>
  `+${team.resumeGrant.wakes} turns, +${team.resumeGrant.minutes} min`;

export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** One pending confirmation in the team view. */
export interface PendingConfirm {
  readonly title: string;
  readonly body: string;
  readonly label: string;
  readonly danger?: boolean;
  /** Shows the "also delete worktree folders" option (disband only). */
  readonly withWorktreeOption?: boolean;
  /** Shown when the action succeeds. */
  readonly ok?: string;
  readonly action: () => Promise<void>;
}

/** Runs one team action at a time and reports its outcome. */
export type RunAction = (key: string, fn: () => Promise<unknown>, ok?: string) => Promise<void>;
