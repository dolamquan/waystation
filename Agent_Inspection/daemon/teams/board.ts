import { randomUUID } from 'node:crypto';
import { redact } from '../domain/text.ts';
import {
  EVERYONE, OPERATOR, type Actor, type MemberSpend, type PlanPhase, type TeamStatus, type TaskStatus, type TeamMember, type TeamMessage, type TeamState, type TeamTask,
  type TeamView,
} from './types.ts';

/** Pure, immutable operations on a team's shared board. Every function returns a new state. */

export const MAX_MESSAGE_CHARS = 4000;
export const MAX_TASK_TITLE_CHARS = 160;
export const MAX_TASK_DETAILS_CHARS = 4000;
const MAX_MESSAGES = 500;
const MAX_TASKS = 100;
const TASK_STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'blocked', 'done'];

/** What Resume adds to the budget and the deadline. */
export const RESUME_GRANT = { wakes: 20, minutes: 30 } as const;

export class BoardError extends Error {}

/** A tower notice the caller posts as SYSTEM to member `to` (a member id). */
export interface BoardNotice {
  readonly to: string;
  readonly text: string;
}

const shortId = () => randomUUID().slice(0, 8);

export function memberByName(state: TeamState, name: string): TeamMember | undefined {
  const wanted = name.trim().toLowerCase().replace(/^@/, '');
  return state.members.find((member) => member.name === wanted || member.id === wanted);
}

export function memberById(state: TeamState, id: string): TeamMember | undefined {
  return state.members.find((member) => member.id === id);
}

export function lead(state: TeamState): TeamMember {
  const found = state.members.find((member) => member.role === 'lead');
  if (!found) throw new BoardError('team has no lead');
  return found;
}

export function displayName(state: TeamState, actor: Actor): string {
  return memberById(state, actor)?.name ?? actor;
}

export function postMessage(state: TeamState, from: Actor, to: string, text: string, now = Date.now()): TeamState {
  const body = redact(text.trim()).slice(0, MAX_MESSAGE_CHARS);
  if (!body) throw new BoardError('message text is required');
  const recipient = to.trim().toLowerCase() === EVERYONE ? EVERYONE : memberByName(state, to)?.id;
  if (!recipient) throw new BoardError(`unknown teammate "${to}". Use team_roster to see names.`);
  if (recipient === from) throw new BoardError('you cannot message yourself');
  const message: TeamMessage = { id: shortId(), ts: now, from, to: recipient, text: body };
  const messages = [...state.messages, message];
  const dropped = Math.max(0, messages.length - MAX_MESSAGES);
  return {
    ...state,
    messages: messages.slice(dropped),
    readUpTo: Object.fromEntries(Object.entries(state.readUpTo).map(([id, upTo]) => [id, Math.max(0, upTo - dropped)])),
  };
}

const isFor = (memberId: string) => (message: TeamMessage) =>
  message.from !== memberId && (message.to === EVERYONE || message.to === memberId);

export function unreadFor(state: TeamState, memberId: string): TeamMessage[] {
  return state.messages.slice(state.readUpTo[memberId] ?? 0).filter(isFor(memberId));
}

export function markRead(state: TeamState, memberId: string): TeamState {
  return { ...state, readUpTo: { ...state.readUpTo, [memberId]: state.messages.length } };
}

/** The last `limit` messages a member can see, read or not. */
export function historyFor(state: TeamState, memberId: string, limit = 20): TeamMessage[] {
  return state.messages.filter((m) => m.from === memberId || isFor(memberId)(m)).slice(-limit);
}

/** One above the highest existing number, so removing a task never renumbers or duplicates others. */
function nextTaskId(state: TeamState): string {
  const highest = state.tasks.reduce((max, task) => Math.max(max, Number(/^t(\d+)$/.exec(task.id)?.[1] ?? 0)), 0);
  return `t${highest + 1}`;
}

export function createTask(
  state: TeamState,
  by: Actor,
  input: { title: string; details?: string; assignee?: string },
  now = Date.now(),
): { state: TeamState; task: TeamTask } {
  const title = redact(input.title.trim()).slice(0, MAX_TASK_TITLE_CHARS);
  if (!title) throw new BoardError('task title is required');
  if (state.tasks.length >= MAX_TASKS) throw new BoardError('the board is full');
  const assignee = input.assignee ? memberByName(state, input.assignee)?.id : undefined;
  if (input.assignee && !assignee) throw new BoardError(`unknown teammate "${input.assignee}"`);
  const task: TeamTask = {
    id: nextTaskId(state),
    title,
    details: redact((input.details ?? '').trim()).slice(0, MAX_TASK_DETAILS_CHARS),
    status: assignee ? 'in_progress' : 'open',
    assignee,
    createdBy: by,
    updatedAt: now,
  };
  return { state: { ...state, tasks: [...state.tasks, task] }, task };
}

function replaceTask(state: TeamState, taskId: string, patch: (task: TeamTask) => TeamTask): { state: TeamState; task: TeamTask } {
  const current = state.tasks.find((task) => task.id === taskId.trim());
  if (!current) throw new BoardError(`unknown task "${taskId}". Use list_tasks to see ids.`);
  const task = patch(current);
  return { state: { ...state, tasks: state.tasks.map((t) => (t.id === task.id ? task : t)) }, task };
}

export function claimTask(state: TeamState, memberId: string, taskId: string, now = Date.now()) {
  return replaceTask(state, taskId, (task) => {
    if (task.status === 'done') throw new BoardError(`${task.id} is already done`);
    if (task.assignee && task.assignee !== memberId) {
      throw new BoardError(`${task.id} is assigned to ${displayName(state, task.assignee)}`);
    }
    return { ...task, assignee: memberId, status: 'in_progress', updatedAt: now };
  });
}

export function updateTask(
  state: TeamState,
  by: Actor,
  taskId: string,
  input: { status?: string; note?: string; assignee?: string },
  now = Date.now(),
) {
  if (input.status !== undefined && !TASK_STATUSES.includes(input.status as TaskStatus)) {
    throw new BoardError(`status must be one of ${TASK_STATUSES.join(', ')}`);
  }
  const reassignTo = input.assignee ? memberByName(state, input.assignee)?.id : undefined;
  if (input.assignee && !reassignTo) throw new BoardError(`unknown teammate "${input.assignee}"`);
  const isLead = memberById(state, by)?.role === 'lead';
  return replaceTask(state, taskId, (task) => {
    if (!isLead && task.assignee && task.assignee !== by) {
      throw new BoardError(`${task.id} belongs to ${displayName(state, task.assignee)}; only they or the lead can update it`);
    }
    return {
      ...task,
      status: (input.status as TaskStatus | undefined) ?? task.status,
      assignee: reassignTo ?? task.assignee,
      note: input.note !== undefined ? redact(input.note.trim()).slice(0, MAX_TASK_DETAILS_CHARS) : task.note,
      updatedAt: now,
    };
  });
}

export function allTasksDone(state: TeamState): boolean {
  return state.tasks.length > 0 && state.tasks.every((task) => task.status === 'done');
}

export function replaceMember(state: TeamState, memberId: string, patch: Partial<TeamMember>): TeamState {
  return { ...state, members: state.members.map((m) => (m.id === memberId ? { ...m, ...patch } : m)) };
}

const NO_SPEND: MemberSpend = { costUsd: 0, turns: 0 };

function totalSpend(members: readonly TeamMember[]): MemberSpend {
  return members.reduce<MemberSpend>((sum, m) => ({
    costUsd: sum.costUsd + (m.spend?.costUsd ?? 0),
    turns: sum.turns + (m.spend?.turns ?? 0),
  }), NO_SPEND);
}

export function toView(state: TeamState): TeamView {
  const {
    id, name, goal, repoRoot, baseBranch, status, statusReason, createdAt, members, tasks, budget, summary, archivedAt,
  } = state;
  const queued = members.map((m) => [m.id, unreadFor(state, m.id).map((message) => message.id)] as const);
  return {
    id, name, goal, repoRoot, baseBranch, status, statusReason, createdAt, members, tasks, budget, summary, archivedAt,
    requirePlanApproval: state.requirePlanApproval ?? false,
    pending: Object.fromEntries(queued.map(([memberId, ids]) => [memberId, ids.length])),
    pendingIds: Object.fromEntries(queued),
    resumeGrant: { ...RESUME_GRANT },
    spend: totalSpend(members),
  };
}

/* ---------- Operator task board ---------- */

export interface OperatorTaskResult {
  readonly state: TeamState;
  readonly task: TeamTask;
  /** Tower notices to post (SYSTEM → member). Empty while the plan is being drafted or reviewed. */
  readonly notices: readonly BoardNotice[];
  /** Body for the 'task' log entry (actor: operator). */
  readonly summary: string;
}

/** The plan phase the team is in, counting a pause or stop in the middle of one (resumePhase). */
export function planPhase(state: TeamState): PlanPhase | undefined {
  if (state.status === 'planning' || state.status === 'plan_review') return state.status;
  return state.status === 'paused' || state.status === 'stopped' ? state.resumePhase : undefined;
}

export const isPlanPhase = (state: TeamState): boolean => planPhase(state) !== undefined;

/** The status that decides which tools are offered: a team paused mid-plan keeps its plan-phase tools. */
export const toolStatus = (state: TeamState): TeamStatus => planPhase(state) ?? state.status;

function optionalText(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BoardError(`${key} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new BoardError(`${key} must be at most ${max} characters`);
  return redact(trimmed);
}

function bodyOf(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BoardError('task input must be an object');
  return raw as Record<string, unknown>;
}

/** undefined: not given. null: unassign. string: member id. */
function parseAssignee(state: TeamState, value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === 'string' && !value.trim())) return null;
  if (typeof value !== 'string') throw new BoardError('assignee must be a teammate name');
  const found = memberByName(state, value);
  if (!found) throw new BoardError(`unknown teammate "${value}"`);
  return found.id;
}

function parseStatus(value: unknown): TaskStatus | undefined {
  if (value === undefined) return undefined;
  if (!TASK_STATUSES.includes(value as TaskStatus)) throw new BoardError(`status must be one of ${TASK_STATUSES.join(', ')}`);
  return value as TaskStatus;
}

function assignedNotice(task: TeamTask): string {
  return `The operator assigned you ${task.id}: ${task.title}${task.details ? `\n${task.details}` : ''}`;
}

/** Notices for a change of owner: the new owner gets the task, the previous one is told to stop. */
function ownerNotices(state: TeamState, before: string | undefined, task: TeamTask): BoardNotice[] {
  if (isPlanPhase(state) || before === task.assignee) return [];
  const gained = task.assignee ? [{ to: task.assignee, text: assignedNotice(task) }] : [];
  const where = task.assignee ? `to ${displayName(state, task.assignee)}` : 'off your list';
  const lost = before ? [{ to: before, text: `The operator moved ${task.id} ${where}. Stop working on it.` }] : [];
  return [...gained, ...lost];
}

/** Operator adds a task: { title, details?, assignee? }. */
export function operatorCreateTask(state: TeamState, raw: unknown, now = Date.now()): OperatorTaskResult {
  const body = bodyOf(raw);
  const title = optionalText(body, 'title', MAX_TASK_TITLE_CHARS);
  if (!title) throw new BoardError('task title is required');
  const details = optionalText(body, 'details', MAX_TASK_DETAILS_CHARS) ?? '';
  const assignee = parseAssignee(state, body.assignee) ?? undefined;
  if (state.tasks.length >= MAX_TASKS) throw new BoardError('the board is full');
  const task: TeamTask = {
    id: nextTaskId(state), title, details, status: assignee ? 'in_progress' : 'open', assignee, createdBy: OPERATOR, updatedAt: now,
  };
  const owner = assignee ? ` → ${displayName(state, assignee)}` : '';
  return {
    state: { ...state, tasks: [...state.tasks, task] },
    task,
    notices: ownerNotices(state, undefined, task),
    summary: `created ${task.id}${owner}: ${title}`,
  };
}

/** Assigning an open task starts it; unassigning a started one reopens it; an explicit status always wins. */
function nextStatus(task: TeamTask, assignee: string | undefined, explicit: TaskStatus | undefined): TaskStatus {
  if (explicit) return explicit;
  if (assignee && !task.assignee && task.status === 'open') return 'in_progress';
  if (!assignee && task.assignee && task.status === 'in_progress') return 'open';
  return task.status;
}

function changeList(state: TeamState, before: TeamTask, after: TeamTask): string {
  const parts = [
    after.title !== before.title && 'title',
    after.details !== before.details && 'details',
    after.note !== before.note && 'note',
    after.status !== before.status && after.status,
    after.assignee !== before.assignee && (after.assignee ? `→ ${displayName(state, after.assignee)}` : 'unassigned'),
  ].filter((part): part is string => typeof part === 'string');
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** Operator edits any task: { title?, details?, status?, assignee? (null or "" unassigns), note? }. */
export function operatorUpdateTask(state: TeamState, taskId: string, raw: unknown, now = Date.now()): OperatorTaskResult {
  const body = bodyOf(raw);
  const title = optionalText(body, 'title', MAX_TASK_TITLE_CHARS);
  if (title === '') throw new BoardError('task title cannot be empty');
  const details = optionalText(body, 'details', MAX_TASK_DETAILS_CHARS);
  const note = optionalText(body, 'note', MAX_TASK_DETAILS_CHARS);
  const status = parseStatus(body.status);
  const assigneeInput = parseAssignee(state, body.assignee);
  const current = state.tasks.find((task) => task.id === String(taskId).trim());
  if (!current) throw new BoardError(`unknown task "${taskId}"`);
  const assignee = assigneeInput === undefined ? current.assignee : assigneeInput ?? undefined;
  const task: TeamTask = {
    ...current,
    title: title ?? current.title,
    details: details ?? current.details,
    note: note === undefined ? current.note : note || undefined,
    assignee,
    status: nextStatus(current, assignee, status),
    updatedAt: now,
  };
  return {
    state: { ...state, tasks: state.tasks.map((t) => (t.id === task.id ? task : t)) },
    task,
    notices: ownerNotices(state, current.assignee, task),
    summary: `updated ${task.id}${changeList(state, current, task)}: ${task.title}`,
  };
}

/** Deletes a task. Other ids stay as they are; new ids keep counting up from the highest one left. */
export function removeTask(state: TeamState, taskId: string): TeamState {
  const id = String(taskId).trim();
  if (!state.tasks.some((task) => task.id === id)) throw new BoardError(`unknown task "${taskId}"`);
  return { ...state, tasks: state.tasks.filter((task) => task.id !== id) };
}

/* ---------- Plan approval ---------- */

const taskLine = (task: TeamTask) => `- ${task.id}: ${task.title}${task.details ? `\n  ${task.details.replace(/\n/g, '\n  ')}` : ''}`;
const openTasksOf = (state: TeamState, memberId: string) => state.tasks.filter((t) => t.assignee === memberId && t.status !== 'done');

/** The single notice a member gets when the operator approves the lead's plan; undefined when it has nothing to hear. */
export function planApprovedNotice(state: TeamState, member: TeamMember): string | undefined {
  const mine = openTasksOf(state, member.id);
  const list = mine.length ? `\nYour tasks:\n${mine.map(taskLine).join('\n')}` : '';
  if (member.role !== 'lead') {
    if (!mine.length) return undefined;
    return `The operator approved the plan. Start now.${list}\nWhen a task is finished, call update_task with status "done" and a note.`;
  }
  const unassigned = state.tasks.filter((t) => !t.assignee && t.status !== 'done').map((t) => t.id);
  const loose = unassigned.length ? ` Unassigned: ${unassigned.join(', ')}.` : '';
  return `The operator approved your plan. Each assignee has been told its tasks.${loose}${list}\nWork on your own tasks if any, then end your turn; you are woken when teammates report.`;
}

/** One notice per worker that has open tasks, plus one for the lead. */
export function approvePlanNotices(state: TeamState): BoardNotice[] {
  return state.members.flatMap((member) => {
    const text = planApprovedNotice(state, member);
    return text ? [{ to: member.id, text }] : [];
  });
}
