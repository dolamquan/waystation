import { randomUUID } from 'node:crypto';
import { redact } from '../domain/text.ts';
import {
  EVERYONE, type Actor, type TaskStatus, type TeamMember, type TeamMessage, type TeamState, type TeamTask, type TeamView,
} from './types.ts';

/** Pure, immutable operations on a team's shared board. Every function returns a new state. */

export const MAX_MESSAGE_CHARS = 4000;
export const MAX_TASK_TITLE_CHARS = 160;
export const MAX_TASK_DETAILS_CHARS = 4000;
const MAX_MESSAGES = 500;
const MAX_TASKS = 100;
const TASK_STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'blocked', 'done'];

export class BoardError extends Error {}

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
    id: `t${state.tasks.length + 1}`,
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

export function toView(state: TeamState): TeamView {
  const {
    id, name, goal, repoRoot, baseBranch, status, statusReason, createdAt, members, tasks, budget, summary,
  } = state;
  return { id, name, goal, repoRoot, baseBranch, status, statusReason, createdAt, members, tasks, budget, summary };
}
