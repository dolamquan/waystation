import type { ManagedVendor } from '../../shared/agentProviders.ts';
import type { Agent, AgentEvent, PendingInterception } from '../../daemon/domain/types.ts';
import type { TeamLogEntry, TeamMember, TeamTask, TeamView } from '../../daemon/teams/types.ts';
import type { UsageSummary } from '../../daemon/store/db.ts';
import type { AgentTemplate } from '../../daemon/ops/templates.ts';
import type { ScheduleView } from '../../daemon/ops/agentOps.ts';
import type { Prerequisite } from '../../daemon/ops/prerequisites.ts';
import type { LaunchLoadout, ScheduleNotify, ScheduleResource } from '../../daemon/library/types.ts';
import type { ScheduleRun } from '../../daemon/ops/schedules.ts';
import type { UsageWindowsReport } from '../../daemon/usage/windowTypes.ts';
import type { SpendCapConfig, SpendStatus } from '../../daemon/guard/spendCap.ts';
import type { FileContention } from '../../daemon/guard/contention.ts';
import type { RemoteStatus } from '../../daemon/remote/remoteAccess.ts';
import type { PairingOffer, RemoteDevice } from '../../daemon/remote/devices.ts';
import type { RemoteRole } from '../../daemon/remote/access.ts';
import type { PreviewView } from '../../daemon/preview/types.ts';
import type { ConsoleInfo, ConsoleKind, SavedConsoleSpec } from '../../daemon/pty/types.ts';

export type { Agent, AgentEvent, PendingInterception, TeamLogEntry, TeamMember, TeamTask, TeamView };
export type { ConsoleInfo, ConsoleKind };
export type SavedConsole = SavedConsoleSpec;
export type { AgentTemplate, Prerequisite, ScheduleView, UsageSummary };
export type { FileContention, SpendCapConfig, SpendStatus };
export type { PairingOffer, RemoteDevice, RemoteRole, RemoteStatus };
export interface RemoteSession { readonly paired: boolean; readonly device?: { readonly name: string; readonly role: RemoteRole } }
export interface SpendCapView { readonly config: SpendCapConfig; readonly status: SpendStatus }

export interface NewSchedule {
  readonly label: string;
  readonly time: string;
  readonly days: readonly number[];
  readonly enabled: boolean;
  readonly launch: {
    readonly vendor: ManagedVendor;
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
  readonly vendor: ManagedVendor;
  readonly model?: string;
  /** What this member is responsible for (at most 500 characters). */
  readonly focus?: string;
  readonly loadout?: LaunchLoadout;
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
  /** The lead drafts a plan and waits for approval before workers start. The daemon defaults it to true. */
  readonly requirePlanApproval: boolean;
}

export interface NewTask {
  readonly title: string;
  readonly details?: string;
  readonly assignee?: string;
}

export interface TaskPatch {
  readonly title?: string;
  readonly details?: string;
  readonly status?: TeamTask['status'];
  readonly assignee?: string;
  readonly note?: string;
}

export interface MergeAllResult {
  readonly merged: string[];
  readonly skipped: string[];
  readonly stopped?: { readonly member: string; readonly reason: string };
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

/**
 * `waystation` (npm start) opens the UI with `#token=…&autostart=1` so the welcome screen
 * is skipped. Read it before bootstrapToken strips the fragment from the address bar.
 */
const autostartRequested = /(?:^#|&)autostart=1(?:&|$)/.test(location.hash);
export const autostart = (): boolean => autostartRequested;

const sessionToken = bootstrapToken();

// Pasting a fresh link into an already-open tab only changes the fragment: reload to pick it up.
window.addEventListener('hashchange', () => {
  if (/token=/.test(location.hash)) location.reload();
});
export const token = (): string => sessionToken;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/**
 * Opened through the remote gateway (another host name, e.g. Tailscale): the paired device's
 * HttpOnly cookie authenticates it and the gateway adds the local token, so there is none here.
 */
export const isRemote = (): boolean => !LOOPBACK.has(location.hostname);

/** WebSocket subprotocols: the local token travels as a protocol; through the gateway there is none. */
export const socketProtocols = (): string[] => (token() ? [WS_PROTOCOL, token()] : [WS_PROTOCOL]);

export class ApiError extends Error {}

export async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token() ? { 'x-tower-token': token() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (response.status === 404 && data.error === 'not found') throw new ApiError('This feature is temporarily unavailable.');
  if (!response.ok) throw new ApiError(data.error ?? `Request failed (${response.status})`);
  return data as T;
}

const enc = encodeURIComponent;

/** Opens the socket for one console's terminal, authenticated the same way as the main `/ws` socket. */
export function consoleSocket(id: string): WebSocket {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return new WebSocket(`${scheme}://${location.host}/pty/${enc(id)}`, socketProtocols());
}

export const api = {
  sessions: (query = '', project = '', state = '') => request<{ sessions: import('../../daemon/sessions/types.ts').SessionView[] }>('GET', `/api/sessions?q=${encodeURIComponent(query)}&project=${encodeURIComponent(project)}&state=${encodeURIComponent(state)}`),
  resumeSession: (id: string) => request<{ ok: true; agent: Agent }>('POST', `/api/sessions/${enc(id)}/resume`),
  messageQueue: (id: string) => request<{ messages: import('../../daemon/sessions/types.ts').QueuedMessage[] }>('GET', `/api/agents/${enc(id)}/queue`),
  editQueuedMessage: (id: string, message: string, text: string) => request<{ ok: true }>('POST', `/api/agents/${enc(id)}/queue/${enc(message)}/edit`, { text }),
  cancelQueuedMessage: (id: string, message: string) => request<{ ok: true }>('POST', `/api/agents/${enc(id)}/queue/${enc(message)}/cancel`),
  sendReviewedMessage: (id: string, message: string) => request<{ ok: true }>('POST', `/api/agents/${enc(id)}/queue/${enc(message)}/send`, { confirm: true }),
  completionReview: (id: string) => request<{ review: import('../../daemon/outputs/review.ts').CompletionReview }>('GET', `/api/agents/${enc(id)}/review`),
  saveCompletionReview: (id: string, body: { fingerprint: string; decision: 'reviewed' | 'verified'; acceptance: string; unresolved: string; checksReviewed: boolean }) =>
    request<{ review: import('../../daemon/outputs/review.ts').CompletionReview }>('POST', `/api/agents/${enc(id)}/review`, body),
  events: (id: string) => request<{ events: AgentEvent[] }>('GET', `/api/agents/${enc(id)}/events`),
  stop: (id: string) => request<{ ok: true }>('POST', `/api/agents/${enc(id)}/stop`, { confirm: true }),
  instruct: (id: string, text: string, images: readonly { readonly data: string }[] = []) =>
    request<{ ok: true; message: string }>('POST', `/api/agents/${enc(id)}/instruct`, images.length ? { text, images } : { text }),
  intercept: (id: string, on: boolean) => request<{ ok: true }>('POST', `/api/agents/${enc(id)}/intercept`, { on }),
  interrupt: (id: string) => request<{ ok: true }>('POST', `/api/agents/${enc(id)}/interrupt`),
  moveToWorktree: (id: string) =>
    request<{ ok: true; agent: Agent; worktree: { path: string; branch?: string }; warning?: string }>('POST', `/api/agents/${enc(id)}/move-to-worktree`, {}),
  notifyContention: (path: string) =>
    request<{ ok: true; sent: string[]; skipped: string[] }>('POST', '/api/contention/notify', { path }),
  spendCap: () => request<SpendCapView>('GET', '/api/spend-cap'),
  // Remote access: managed on the desktop only (the gateway refuses these).
  remoteStatus: () => request<{ remote: RemoteStatus }>('GET', '/api/remote'),
  remoteConfigure: (config: { enabled: boolean; port: number; hostnames: readonly string[] }) => request<{ remote: RemoteStatus }>('POST', '/api/remote/config', config),
  remotePair: (role: RemoteRole) => request<{ pairing: PairingOffer }>('POST', '/api/remote/pair', { role }),
  remoteCancelPair: () => request<{ ok: true }>('POST', '/api/remote/pair/cancel', {}),
  remoteRevoke: (id: string) => request<{ ok: true }>('POST', `/api/remote/devices/${enc(id)}/revoke`, {}),
  remoteSetRole: (id: string, role: RemoteRole) => request<{ device: RemoteDevice }>('POST', `/api/remote/devices/${enc(id)}/role`, { role }),
  // A remote device's own session with the gateway.
  remoteSession: () => request<RemoteSession>('GET', '/remote/session'),
  remoteJoin: (code: string, name: string) => request<RemoteSession>('POST', '/remote/pair', { code, name }),
  remoteForget: () => request<RemoteSession>('POST', '/remote/forget', {}),
  saveSpendCap: (config: unknown) => request<SpendCapView>('POST', '/api/spend-cap', config),
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
  launch: (body: { vendor: ManagedVendor; cwd: string; prompt: string; name?: string; model?: string; appendSystemPrompt?: string; intercept?: boolean; loadout?: LaunchLoadout }) =>
    request<{ ok: true; agent: Agent }>('POST', '/api/managed', body),
  decide: (id: string, decision: { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message: string } | { behavior: 'ask' }) =>
    request<{ ok: true }>('POST', `/api/interceptions/${enc(id)}`, decision),
  createTeam: (body: NewTeam) => request<{ ok: true; team: TeamView; notes: string[] }>('POST', '/api/teams', body),
  teamOutput: (id: string, output: string) => request<{ data: string; mime: string; kind: 'text' | 'image' | 'binary' }>('GET', `/api/teams/${enc(id)}/outputs/${enc(output)}`),
  revealTeamOutput: (id: string, output: string) => request<{ ok: true }>('POST', `/api/teams/${enc(id)}/outputs/${enc(output)}/reveal`),
  teamLog: (id: string) => request<{ entries: TeamLogEntry[] }>('GET', `/api/teams/${enc(id)}/log`),
  messageTeam: (id: string, to: string, text: string) =>
    request<{ ok: true; message: string }>('POST', `/api/teams/${enc(id)}/message`, { to, text }),
  addTeamMember: (id: string, member: NewTeamMember) =>
    request<{ ok: true; member: TeamMember; message: string }>('POST', `/api/teams/${enc(id)}/members`, member),
  pauseTeam: (id: string) => request<{ ok: true }>('POST', `/api/teams/${enc(id)}/pause`),
  resumeTeam: (id: string) => request<{ ok: true }>('POST', `/api/teams/${enc(id)}/resume`),
  memberDiff: (id: string, member: string) => request<{ diff: MemberDiff }>('GET', `/api/teams/${enc(id)}/members/${enc(member)}/diff`),
  mergeMember: (id: string, member: string) =>
    request<{ ok: true; message: string }>('POST', `/api/teams/${enc(id)}/members/${enc(member)}/merge`, { confirm: true }),
  disbandTeam: (id: string, removeWorktrees: boolean) =>
    request<{ ok: true; keptBranches: string[] }>('POST', `/api/teams/${enc(id)}/disband`, { confirm: true, removeWorktrees }),
  approvePlan: (id: string) => request<{ ok: true; message: string }>('POST', `/api/teams/${enc(id)}/plan/approve`),
  createTask: (id: string, body: NewTask) => request<{ ok: true; task: TeamTask }>('POST', `/api/teams/${enc(id)}/tasks`, body),
  updateTask: (id: string, task: string, body: TaskPatch) =>
    request<{ ok: true; task: TeamTask }>('POST', `/api/teams/${enc(id)}/tasks/${enc(task)}`, body),
  removeTask: (id: string, task: string) => request<{ ok: true }>('POST', `/api/teams/${enc(id)}/tasks/${enc(task)}/remove`),
  mergeAll: (id: string) => request<{ ok: true } & MergeAllResult>('POST', `/api/teams/${enc(id)}/merge-all`, { confirm: true }),
  removeTeam: (id: string) => request<{ ok: true }>('POST', `/api/teams/${enc(id)}/remove`, { confirm: true }),
  installHooks: () => request<{ ok: true; backup?: string }>('POST', '/api/hooks/install', { confirm: true }),
  uninstallHooks: () => request<{ ok: true }>('POST', '/api/hooks/uninstall'),
  // ---- console board: real terminals ----
  // Older running daemons omit agents; current daemons return a matched board snapshot.
  consoles: () => request<{ consoles: ConsoleInfo[]; agents?: Agent[] }>('GET', '/api/consoles'),
  openConsole: (body: { kind: ConsoleKind; cwd: string; name?: string }) => request<{ ok: true; console: ConsoleInfo }>('POST', '/api/consoles', body),
  killConsole: (id: string) => request<{ ok: true }>('POST', `/api/consoles/${enc(id)}/kill`, { confirm: true }),
  /** Team controls: pause = Esc (interrupts the turn), resume = "continue". Shell consoles are left alone. */
  consoleKeys: (id: string, action: 'pause' | 'resume') => request<{ ok: true; sent: boolean }>('POST', `/api/consoles/${enc(id)}/keys`, { action }),
  handoffConsole: (id: string, to: string, task: string) => request<{ ok: true; message: string }>('POST', `/api/consoles/${enc(id)}/handoff`, { to, task }),
  dismissConsole: (id: string) => request<{ ok: true }>('POST', `/api/consoles/${enc(id)}/dismiss`, { confirm: true }),
  /** Continue an agent's session (a Waystation agent, or a copy of an observed one) in a real terminal on the board. */
  openAgentInConsole: (id: string) => request<{ ok: true; message: string; consoleId?: string }>('POST', `/api/agents/${enc(id)}/console`),
  savedConsoles: () => request<{ saved: SavedConsole[] }>('GET', '/api/consoles/saved'),
  restoreConsole: (id: string) => request<{ ok: true; console: ConsoleInfo }>('POST', `/api/consoles/saved/${enc(id)}/restore`, {}),
  discardSavedConsole: (id: string) => request<{ ok: true }>('POST', `/api/consoles/saved/${enc(id)}/discard`, { confirm: true }),
  // ---- usage, runaway guard, rename, restart, templates, schedules, prerequisites ----
  usage: (days = 7) => request<{ usage: UsageSummary }>('GET', `/api/usage?days=${days}`),
  usageWindows: () => request<{ windows: UsageWindowsReport }>('GET', '/api/usage/windows'),
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
  command: (id: string, name: string, arg: string) =>
    request<{ result: import('../../shared/claudeCommands.ts').CommandResult }>('POST', `/api/agents/${enc(id)}/command`, { name, arg }),
  outputs: (id: string) => request<{ outputs: import('../../daemon/outputs/types.ts').AgentOutputs }>('GET', `/api/agents/${enc(id)}/outputs`),
  outputDiff: (id: string, path: string) =>
    request<{ diff: import('../../daemon/outputs/types.ts').FileDiff }>('GET', `/api/agents/${enc(id)}/outputs/diff?path=${encodeURIComponent(path)}`),
  preview: (id: string) => request<{ preview: PreviewView }>('GET', `/api/agents/${enc(id)}/preview`),
  startPreview: (id: string) => request<{ preview: PreviewView }>('POST', `/api/agents/${enc(id)}/preview/start`),
  stopPreview: (id: string) => request<{ preview: PreviewView }>('POST', `/api/agents/${enc(id)}/preview/stop`),
  openPreview: (id: string) => request<{ ok: true }>('POST', `/api/agents/${enc(id)}/preview/open`),
};
