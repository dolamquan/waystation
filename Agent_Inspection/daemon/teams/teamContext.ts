import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { redact } from '../domain/text.ts';
import type { Agent } from '../domain/types.ts';
import type { LaunchLoadout } from '../library/types.ts';
import type { ManagedLaunch, ManagedRunner, StdioMcpServer } from '../managed/types.ts';
import { memberById, toView } from './board.ts';
import { SYSTEM, type Actor, type PlanPhase, type TeamLogEntry, type TeamLogKind, type TeamMember, type TeamState, type TeamStatus, type TeamView } from './types.ts';

/** Shared state and primitives of the team runtime. The TeamManager façade and its helper modules all work through one of these. */

export class TeamError extends Error {}
export class TeamAuthError extends Error {}

export const TEAM_MCP_SCRIPT = fileURLToPath(new URL('./team-mcp.mjs', import.meta.url));
export const TOKEN_ENV = 'AGENT_TOWER_TEAM_TOKEN';
const MAX_LOG_SUMMARY_CHARS = 2000;

export interface TeamHost {
  /** The tower applies `loadout` (skills, docs, MCP servers, plugins, notify) the way it does for single agents. */
  readonly launch: (launch: ManagedLaunch, loadout?: LaunchLoadout) => Agent;
  readonly runner: (agentId: string) => ManagedRunner | undefined;
  readonly agent: (agentId: string) => Agent | undefined;
  readonly audit: (action: string, target: string, detail: unknown) => void;
  readonly codexAvailable: () => boolean;
}

export interface TeamStore {
  saveTeam(team: TeamState): void;
  deleteTeam(teamId: string): void;
  loadTeams(): TeamState[];
  appendTeamLog(entry: TeamLogEntry): void;
  teamLog(teamId: string, limit?: number): TeamLogEntry[];
}

export interface TeamManagerOptions {
  readonly teamsDir: string;
  /** The tower's state folder (holds its access token): Claude members' file tools may not read it. */
  readonly privateRoot?: string;
  readonly mcpScript?: string;
  readonly nodePath?: string;
  readonly now?: () => number;
}

/** Who a token speaks for: one member, or (operator) the human's own CLI session on the team. */
export interface Membership { readonly teamId: string; readonly memberId: string; readonly operator?: boolean }

export type { PlanPhase } from './types.ts';
export const isPlanStatus = (status: TeamStatus): status is PlanPhase => status === 'planning' || status === 'plan_review';

export const resumePhaseOf = (state: TeamState): PlanPhase | undefined => state.resumePhase;

/** Remember the planning phase when a team stops mid-plan; forget it once the team runs (or plans) again. */
export function withResumePhase(prev: TeamState | undefined, next: TeamState): TeamState {
  if (next.status === 'paused' || next.status === 'stopped') {
    const phase = prev && isPlanStatus(prev.status) ? prev.status : next.resumePhase;
    return { ...next, resumePhase: phase };
  }
  if (next.status === 'disbanded' || next.resumePhase === undefined) return next;
  return { ...next, resumePhase: undefined };
}

export interface TeamEvents {
  readonly teams: (views: TeamView[]) => void;
  readonly log: (entry: TeamLogEntry) => void;
}

export interface LogExtra { readonly to?: string; readonly messageId?: string }

export class TeamContext {
  teams = new Map<string, TeamState>();
  tokens = new Map<string, Membership>();
  byAgent = new Map<string, Membership>();
  endpoint: string | undefined;
  readonly now: () => number;

  constructor(
    readonly host: TeamHost,
    readonly store: TeamStore,
    readonly opts: TeamManagerOptions,
    private readonly events: TeamEvents,
  ) {
    this.now = opts.now ?? Date.now;
  }

  list(): TeamView[] {
    return [...this.teams.values()].sort((a, b) => b.createdAt - a.createdAt).map(toView);
  }

  require(teamId: string): TeamState {
    const team = this.teams.get(teamId);
    if (!team) throw new TeamError('Team not found.');
    return team;
  }

  /** Operator actions are refused on a disbanded (archived) team: only its log stays readable. */
  requireActive(teamId: string): TeamState {
    const team = this.require(teamId);
    if (team.status === 'disbanded') throw new TeamError('This team is disbanded. Its log stays readable; remove it when you are done.');
    return team;
  }

  requireMember(teamId: string, memberId: string): { team: TeamState; member: TeamMember } {
    const team = this.require(teamId);
    const member = memberById(team, memberId);
    if (!member) throw new TeamError('Member not found.');
    return { team, member };
  }

  commit(next: TeamState): void {
    const saved = withResumePhase(this.teams.get(next.id), next);
    this.teams = new Map([...this.teams.entries(), [saved.id, saved]]);
    this.store.saveTeam(saved);
    this.events.teams(this.list());
  }

  forget(teamId: string): void {
    this.teams = new Map([...this.teams].filter(([id]) => id !== teamId));
    this.store.deleteTeam(teamId);
    this.events.teams(this.list());
  }

  append(teamId: string, kind: TeamLogKind, actor: Actor, summary: string, extra: LogExtra = {}): void {
    // Redact + clip before both storage and broadcast: summaries can carry agent-written text.
    const entry: TeamLogEntry = {
      teamId, ts: this.now(), kind, actor, summary: redact(summary).slice(0, MAX_LOG_SUMMARY_CHARS),
      ...(extra.to ? { to: extra.to } : {}),
      ...(extra.messageId ? { messageId: extra.messageId } : {}),
    };
    this.store.appendTeamLog(entry);
    this.events.log(entry);
  }

  setStatus(teamId: string, status: TeamStatus, reason: string): void {
    const team = this.require(teamId);
    if (team.status === status && team.statusReason === reason) return;
    this.commit({ ...team, status, statusReason: reason });
    this.append(teamId, 'system', SYSTEM, reason);
  }

  authenticate(token: string | undefined): Membership | undefined {
    return token ? this.tokens.get(token) : undefined;
  }

  /** A member has one live token at a time; operator sessions each get their own. */
  issueToken(membership: Membership): string {
    const token = randomBytes(24).toString('hex');
    if (!membership.operator) this.revokeMember(membership.teamId, membership.memberId);
    this.tokens = new Map([...this.tokens, [token, membership]]);
    return token;
  }

  revokeToken(token: string): void {
    this.tokens = new Map([...this.tokens].filter(([key]) => key !== token));
  }

  revokeMember(teamId: string, memberId: string): void {
    this.tokens = new Map([...this.tokens].filter(([, m]) => m.operator || !(m.teamId === teamId && m.memberId === memberId)));
  }

  /** Drop every token and agent binding of a team (disband). */
  revokeTeam(teamId: string): void {
    this.tokens = new Map([...this.tokens].filter(([, m]) => m.teamId !== teamId));
    this.byAgent = new Map([...this.byAgent].filter(([, m]) => m.teamId !== teamId));
  }

  bindAgent(agentId: string, membership: Membership): void {
    this.byAgent = new Map([...this.byAgent, [agentId, membership]]);
  }

  unbindAgent(agentId: string): void {
    this.byAgent = new Map([...this.byAgent].filter(([id]) => id !== agentId));
  }

  agentStatus(member: TeamMember): Agent['status'] | undefined {
    return member.agentId ? this.host.agent(member.agentId)?.status : undefined;
  }

  mcpServers(): Record<string, StdioMcpServer> {
    if (!this.endpoint) throw new TeamError('team channel endpoint is not set');
    return {
      team: {
        command: this.opts.nodePath ?? process.execPath,
        args: [this.opts.mcpScript ?? TEAM_MCP_SCRIPT],
        env: { AGENT_TOWER_TEAM_URL: this.endpoint },
        inheritEnv: [TOKEN_ENV],
      },
    };
  }
}
