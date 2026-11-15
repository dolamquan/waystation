import type { TeamView } from '../../api.ts';
import { TEAM_STATUS_LABEL, isArchived } from '../team/teamUi.ts';

/** A Waystation-run team as the canvas draws it: a frame around the tiles of its started members. */
export interface ManagedTeamFrame {
  readonly id: string;
  readonly name: string;
  readonly status: TeamView['status'];
  readonly statusLabel: string;
  /** Board item keys (`agent:<id>`) of members that are on this canvas. */
  readonly memberKeys: readonly string[];
  readonly tasksDone: number;
  readonly taskCount: number;
  /** Something is waiting on the operator: a plan to review or a blocked task. */
  readonly needsYou: boolean;
}

/** Active teams with at least one member tile among `itemKeys`, oldest first so frames stack in a stable order. */
export function managedTeamFrames(teams: readonly TeamView[], itemKeys: readonly string[]): readonly ManagedTeamFrame[] {
  const present = new Set(itemKeys);
  return [...teams]
    .filter((team) => !isArchived(team))
    .sort((a, b) => a.createdAt - b.createdAt)
    .flatMap((team): ManagedTeamFrame[] => {
      const memberKeys = team.members.flatMap((member) => {
        const key = member.agentId ? `agent:${member.agentId}` : undefined;
        return key && present.has(key) ? [key] : [];
      });
      if (memberKeys.length === 0) return [];
      return [{
        id: team.id,
        name: team.name,
        status: team.status,
        statusLabel: TEAM_STATUS_LABEL[team.status],
        memberKeys,
        tasksDone: team.tasks.filter((task) => task.status === 'done').length,
        taskCount: team.tasks.length,
        needsYou: team.status === 'plan_review' || team.tasks.some((task) => task.status === 'blocked'),
      }];
    });
}

/** Teams that are not archived: what the board's Teams button counts. */
export const activeTeamCount = (teams: readonly TeamView[]): number => teams.filter((team) => !isArchived(team)).length;
