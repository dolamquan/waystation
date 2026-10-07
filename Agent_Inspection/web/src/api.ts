import type { Agent, AgentEvent, PendingInterception } from '../../daemon/domain/types.ts';
import type { TeamLogEntry, TeamMember, TeamTask, TeamView } from '../../daemon/teams/types.ts';
import type { UsageSummary } from '../../daemon/store/db.ts';
import type { AgentTemplate } from '../../daemon/ops/templates.ts';
import type { ScheduleView } from '../../daemon/ops/agentOps.ts';
import type { Prerequisite } from '../../daemon/ops/prerequisites.ts';
import type { LaunchLoadout, ScheduleNotify, ScheduleResource } from '../../daemon/library/types.ts';
import type { ScheduleRun } from '../../daemon/ops/schedules.ts';

export type { Agent, AgentEvent, PendingInterception, TeamLogEntry, TeamMember, TeamTask, TeamView };
export type { AgentTemplate, Prerequisite, ScheduleView, UsageSummary };

export interface NewSchedule {
  readonly label: string;
  readonly time: string;
  readonly days: readonly number[];
  readonly enabled: boolean;
  readonly launch: {
    readonly vendor: 'claude' | 'codex';
    readonly cwd: string;
    readonly prompt: string;
    readonly name?: string;
    readonly model?: string;
    readonly appendSystemPrompt?: string;
    readonly intercept?: boolean;
    readonly loadout?: LaunchLoadout;
  };
  /** Ids may be omitted for new resources; the tower assigns them. */
  readonly resources?: ReadonlyArray<Omit<ScheduleResource, 'id'> & { readonly id?: string }>;
  readonly notify?: ScheduleNotify;
  readonly stopWhenDone?: boolean;
  readonly maxMinutes?: number;
}

export interface NewTeamMember {
  readonly name: string;
  readonly role: 'lead' | 'worker';
  readonly vendor: 'claude' | 'codex';
  readonly model?: string;
}

export interface NewTeam {
  readonly name: string;
  readonly goal: string;
  readonly cwd: string;
  readonly members: readonly NewTeamMember[];
  readonly initGit: boolean;
  readonly intercept: boolean;
  readonly maxWakes: number;
  readonly maxMinutes: number;
}

export interface MemberDiff {
  readonly stat: string;
  readonly patch: string;
  readonly truncated: boolean;
}

export interface SkillSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
}

export const WS_PROTOCOL = 'agent-tower';
const TOKEN_KEY = 'agent-tower-token';

/**
 * The daemon prints a link like http://127.0.0.1:4317/#token=…  The fragment never
 * reaches the server or logs. We keep it for this tab and strip it from the address bar.
 */
function bootstrapToken(): string {
  const match = /(?:^#|&)token=([A-Fa-f0-9]+)/.exec(location.hash);
  if (match) {
    try { sessionStorage.setItem(TOKEN_KEY, match[1]); } catch { /* storage blocked */ }
    history.replaceState(null, '', location.pathname + location.search);
    return match[1];
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

const sessionToken = bootstrapToken();

// Pasting a fresh link into an already-open tab only changes the fragment: reload to pick it up.
window.addEventListener('hashchange', () => {
  if (/token=/.test(location.hash)) location.reload();
});
export const token = (): string => sessionToken;

export class ApiError extends Error {}

export async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-tower-token': token() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(data.error ?? `Request failed (${response.status})`);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  events: (id: string) => request<{ events: AgentEvent[] }>('GET', `/api/agents/${enc(id)}/events`),
  stop: (id: string) => request<{ ok: true }>('POST', `/api/agents/${enc(id)}/stop`, { confirm: true }),
  instruct: (id: string, text: string) => request<{ ok: true; message: string }>('POST', `/api/agents/${enc(id)}/instruct`, { text }),
  intercept: (id: string, on: boolean) => request<{ ok: true }>('POST', `/api/agents/${enc(id)}/intercept`, { on }),
  interrupt: (id: string) => request<{ ok: true }>('POST', `/api/agents/${enc(id)}/interrupt`),
  delegate: (id: string, prompt: string, stopOriginal: boolean) =>
    request<{ ok: true; agent: Agent; warning?: string }>('POST', `/api/agents/${enc(id)}/delegate`, { prompt, stopOriginal }),
  attachSkill: (id: string, skillId: string) =>
    request<{ ok: true; target: string }>('POST', `/api/agents/${enc(id)}/skills`, { skillId, confirm: true }),
  skills: () => request<{ skills: SkillSummary[] }>('GET', '/api/skills'),
  openTerminal: (kind: 'agent' | 'team', id: string) => request<{ ok: true; command: string }>('POST', '/api/terminal', { kind, id }),
  openCli: (id: string) => request<{ ok: true; message: string }>('POST', `/api/agents/${enc(id)}/cli`),
  openTeamOperator: (id: string) => request<{ ok: true; message: string }>('POST', `/api/teams/${enc(id)}/operator-cli`),
  returnMember: (id: string, member: string) =>
    request<{ ok: true; message: string }>('POST', `/api/teams/${enc(id)}/members/${enc(member)}/return`),
  launch: (body: { vendor: 'claude' | 'codex'; cwd: string; prompt: string; name?: string; model?: string; appendSystemPrompt?: string; intercept?: boolean; loadout?: LaunchLoadout }) =>
    request<{ ok: true; agent: Agent }>('POST', '/api/managed', body),
  decide: (id: string, decision: { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message: string } | { behavior: 'ask' }) =>
    request<{ ok: true }>('POST', `/api/interceptions/${enc(id)}`, decision),
  createTeam: (body: NewTeam) => request<{ ok: true; team: TeamView; notes: string[] }>('POST', '/api/teams', body),
  teamLog: (id: string) => request<{ entries: TeamLogEntry[] }>('GET', `/api/teams/${enc(id)}/log`),
  messageTeam: (id: string, to: string, text: string) =>
    request<{ ok: true; message: string }>('POST', `/api/teams/${enc(id)}/message`, { to, text }),
  pauseTeam: (id: string) => request<{ ok: true }>('POST', `/api/teams/${enc(id)}/pause`),
  resumeTeam: (id: string) => request<{ ok: true }>('POST', `/api/teams/${enc(id)}/resume`),
  memberDiff: (id: string, member: string) => request<{ diff: MemberDiff }>('GET', `/api/teams/${enc(id)}/members/${enc(member)}/diff`),
  mergeMember: (id: string, member: string) =>
    request<{ ok: true; message: string }>('POST', `/api/teams/${enc(id)}/members/${enc(member)}/merge`, { confirm: true }),
  disbandTeam: (id: string, removeWorktrees: boolean) =>
    request<{ ok: true; keptBranches: string[] }>('POST', `/api/teams/${enc(id)}/disband`, { confirm: true, removeWorktrees }),
  installHooks: () => request<{ ok: true; backup?: string }>('POST', '/api/hooks/install', { confirm: true }),
  uninstallHooks: () => request<{ ok: true }>('POST', '/api/hooks/uninstall'),
  // ---- usage, runaway guard, rename, restart, templates, schedules, prerequisites ----
  usage: (days = 7) => request<{ usage: UsageSummary }>('GET', `/api/usage?days=${days}`),
  rename: (id: string, name: string) => request<{ ok: true; name: string | null }>('POST', `/api/agents/${enc(id)}/name`, { name }),
  restart: (id: string, body: { model?: string; message?: string }) =>
    request<{ ok: true; agent: Agent }>('POST', `/api/agents/${enc(id)}/restart`, { ...body, confirm: true }),
  resetBreaker: (id: string) => request<{ ok: true }>('POST', `/api/agents/${enc(id)}/breaker/reset`),
  templates: () => request<{ templates: AgentTemplate[] }>('GET', '/api/templates'),
  createTemplate: (body: Omit<AgentTemplate, 'id' | 'createdAt'>) => request<{ ok: true; template: AgentTemplate }>('POST', '/api/templates', body),
  deleteTemplate: (id: string) => request<{ ok: true }>('POST', `/api/templates/${enc(id)}/delete`),
  schedules: () => request<{ schedules: ScheduleView[] }>('GET', '/api/schedules'),
  createSchedule: (body: NewSchedule) => request<{ ok: true; schedule: ScheduleView }>('POST', '/api/schedules', body),
  updateSchedule: (id: string, body: NewSchedule) => request<{ ok: true; schedule: ScheduleView }>('POST', `/api/schedules/${enc(id)}`, body),
  uploadScheduleResource: (id: string, body: { filename: string; contentBase64: string; label?: string }) =>
    request<{ ok: true; schedule: ScheduleView }>('POST', `/api/schedules/${enc(id)}/resources/upload`, body),
  scheduleRuns: (id: string) => request<{ runs: ScheduleRun[] }>('GET', `/api/schedules/${enc(id)}/runs`),
  setScheduleEnabled: (id: string, enabled: boolean) =>
    request<{ ok: true; schedule: ScheduleView }>('POST', `/api/schedules/${enc(id)}/enabled`, { enabled }),
  runSchedule: (id: string) => request<{ ok: true; agent: Agent }>('POST', `/api/schedules/${enc(id)}/run`),
  deleteSchedule: (id: string) => request<{ ok: true }>('POST', `/api/schedules/${enc(id)}/delete`, { confirm: true }),
  prerequisites: () => request<{ prerequisites: Prerequisite[] }>('GET', '/api/prerequisites'),
};
