import { redact } from '../domain/text.ts';
import {
  MAX_MESSAGE_CHARS, BoardError, allTasksDone, claimTask, createTask, displayName, historyFor, lead, markRead, memberById, memberByName,
  postMessage, unreadFor, updateTask,
} from './board.ts';
import { EVERYONE, SYSTEM, type TeamLogKind, type TeamMember, type TeamMessage, type TeamState, type TeamTask } from './types.ts';

/** The team MCP surface. Same tools for every model; role decides which ones are offered. */

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolOutcome {
  readonly state: TeamState;
  readonly text: string;
  readonly log: ReadonlyArray<{ kind: TeamLogKind; summary: string }>;
  /** Set by finish_team: the lead's final summary. */
  readonly finished?: string;
}

const str = (description: string) => ({ type: 'string', description });
const schema = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, required, additionalProperties: false });

const COMMON_TOOLS: readonly ToolDefinition[] = [
  { name: 'team_roster', description: 'List your teammates: name, role, model, and what they are working on.', inputSchema: schema({}) },
  {
    name: 'post_message',
    description: 'Send a message on the team channel. Use a teammate name, or "all" to broadcast. Recipients are woken up to read it, so keep messages purposeful.',
    inputSchema: schema({ to: str('Teammate name, or "all"'), text: str('Message body') }, ['to', 'text']),
  },
  { name: 'read_messages', description: 'Read new team messages addressed to you (and recent history if there are none).', inputSchema: schema({}) },
  { name: 'list_tasks', description: 'Show the shared task board.', inputSchema: schema({}) },
  {
    name: 'create_task',
    description: 'Add a task to the shared board, optionally assigning it to a teammate (who is notified).',
    inputSchema: schema({ title: str('Short task title'), details: str('What done looks like, files involved, constraints'), assignee: str('Teammate name (optional)') }, ['title']),
  },
  { name: 'claim_task', description: 'Take an open task so nobody else works on it.', inputSchema: schema({ taskId: str('Task id, e.g. t2') }, ['taskId']) },
  {
    name: 'update_task',
    description: 'Change a task status (open, in_progress, blocked, done) and leave a note. Marking done or blocked notifies the lead.',
    inputSchema: schema({ taskId: str('Task id'), status: str('open | in_progress | blocked | done'), note: str('What you did, or what blocks you') }, ['taskId']),
  },
  {
    name: 'handoff',
    description: 'Hand work to a teammate: reassigns the task (if given) and sends them your summary.',
    inputSchema: schema({ to: str('Teammate name'), summary: str('Context they need to continue'), taskId: str('Task id (optional)') }, ['to', 'summary']),
  },
];

const LEAD_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'finish_team',
    description: 'Lead only: declare the goal complete once every task is done and you have reviewed the work. The operator then reviews and merges each branch.',
    inputSchema: schema({ summary: str('What the team delivered, branch by branch, and anything left for the operator') }, ['summary']),
  },
];

export function toolsFor(member: TeamMember): readonly ToolDefinition[] {
  return member.role === 'lead' ? [...COMMON_TOOLS, ...LEAD_TOOLS] : COMMON_TOOLS;
}

const arg = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === 'string' && (args[key] as string).trim() ? (args[key] as string) : undefined;

function required(args: Record<string, unknown>, key: string): string {
  const value = arg(args, key);
  if (!value) throw new BoardError(`"${key}" is required`);
  return value;
}

/**
 * Agent-written text is JSON-quoted so it stays on one line and cannot fake a header such as
 * `operator → lead:`. Only the sender/recipient prefix outside the quotes is written by the tower.
 */
const quote = (text: string) => JSON.stringify(text);

export function formatMessages(state: TeamState, messages: readonly TeamMessage[]): string {
  return messages
    .map((m) => `[${new Date(m.ts).toISOString().slice(11, 19)}] ${displayName(state, m.from)} → ${m.to === EVERYONE ? 'all' : displayName(state, m.to)}: ${quote(m.text)}`)
    .join('\n');
}

export function formatTask(state: TeamState, task: TeamTask): string {
  const owner = task.assignee ? ` @${displayName(state, task.assignee)}` : ' (unassigned)';
  const note = task.note ? `\n    note: ${quote(task.note)}` : '';
  const details = task.details ? `\n    details: ${quote(task.details)}` : '';
  return `${task.id} [${task.status}]${owner} ${quote(task.title)}${details}${note}`;
}

function roster(state: TeamState, self: TeamMember): string {
  return state.members.map((m) => {
    const working = state.tasks.filter((t) => t.assignee === m.id && t.status === 'in_progress').map((t) => t.id);
    const you = m.id === self.id ? ' (you)' : '';
    return `${m.name}${you}: ${m.role}, ${m.vendor}${m.model ? ` ${m.model}` : ''}, branch ${m.branch}${working.length ? `, on ${working.join(', ')}` : ''}`;
  }).join('\n');
}

const notify = (state: TeamState, to: string, text: string) => postMessage(state, SYSTEM, to, text);

/** Run one tool call for `memberId`. Throws BoardError for bad input (reported back to the agent). */
export function callTool(state: TeamState, memberId: string, name: string, args: Record<string, unknown>): ToolOutcome {
  const self = memberById(state, memberId);
  if (!self) throw new BoardError('you are not on this team');
  if (!toolsFor(self).some((tool) => tool.name === name)) throw new BoardError(`unknown tool "${name}"`);
  const leader = lead(state);
  const me = self.name;

  switch (name) {
    case 'team_roster':
      return { state, text: `Goal: ${state.goal}\n${roster(state, self)}`, log: [] };

    case 'post_message': {
      const to = required(args, 'to');
      const text = required(args, 'text');
      const next = postMessage(state, self.id, to, text);
      const target = to.trim().toLowerCase() === EVERYONE ? 'all' : memberByName(state, to)!.name;
      return { state: next, text: `Sent to ${target}.`, log: [{ kind: 'message', summary: `${me} → ${target}: ${text}` }] };
    }

    case 'read_messages': {
      const unread = unreadFor(state, self.id);
      if (unread.length > 0) return { state: markRead(state, self.id), text: formatMessages(state, unread), log: [] };
      const recent = historyFor(state, self.id, 5);
      return { state, text: recent.length ? `No new messages. Recent:\n${formatMessages(state, recent)}` : 'No messages yet.', log: [] };
    }

    case 'list_tasks':
      return { state, text: state.tasks.length ? state.tasks.map((t) => formatTask(state, t)).join('\n') : 'The board is empty.', log: [] };

    case 'create_task': {
      const assignee = arg(args, 'assignee');
      const created = createTask(state, self.id, { title: required(args, 'title'), details: arg(args, 'details'), assignee });
      const { task } = created;
      const next = task.assignee && task.assignee !== self.id
        ? notify(created.state, task.assignee, `${me} assigned you ${task.id}: ${task.title}${task.details ? `\n${task.details}` : ''}`)
        : created.state;
      const owner = task.assignee ? ` → ${displayName(next, task.assignee)}` : '';
      return { state: next, text: `Created ${task.id}.`, log: [{ kind: 'task', summary: `${me} created ${task.id}${owner}: ${task.title}` }] };
    }

    case 'claim_task': {
      const { state: next, task } = claimTask(state, self.id, required(args, 'taskId'));
      return { state: next, text: `You own ${task.id}.`, log: [{ kind: 'task', summary: `${me} claimed ${task.id}` }] };
    }

    case 'update_task': {
      const status = arg(args, 'status');
      const note = arg(args, 'note');
      const { state: updated, task } = updateTask(state, self.id, required(args, 'taskId'), { status, note });
      const reportsToLead = self.id !== leader.id && (status === 'done' || status === 'blocked');
      const next = reportsToLead
        ? notify(updated, leader.id, `${me} marked ${task.id} ${status}${note ? `: ${note}` : ''}`)
        : updated;
      const hint = self.id === leader.id && allTasksDone(next) ? ' Every task is done: review, then call finish_team.' : '';
      return {
        state: next,
        text: `${task.id} is ${task.status}.${hint}`,
        log: [{ kind: 'task', summary: `${me} set ${task.id} ${task.status}${note ? `: ${note}` : ''}` }],
      };
    }

    case 'handoff': {
      const to = required(args, 'to');
      const summary = required(args, 'summary');
      const taskId = arg(args, 'taskId');
      const target = memberByName(state, to);
      if (!target) throw new BoardError(`unknown teammate "${to}"`);
      const reassigned = taskId ? updateTask(state, self.id, taskId, { assignee: to, status: 'in_progress' }).state : state;
      const next = postMessage(reassigned, self.id, target.id, `Handoff${taskId ? ` of ${taskId}` : ''}: ${summary}`);
      return {
        state: next,
        text: `Handed off to ${target.name}.`,
        log: [{ kind: 'task', summary: `${me} handed ${taskId ?? 'work'} to ${target.name}` }],
      };
    }

    case 'finish_team': {
      const summary = redact(required(args, 'summary')).slice(0, MAX_MESSAGE_CHARS);
      const open = state.tasks.filter((t) => t.status !== 'done');
      if (open.length > 0) {
        throw new BoardError(`not finished: ${open.map((t) => `${t.id} is ${t.status}`).join(', ')}. Resolve them or mark them done with a note.`);
      }
      return {
        state: { ...state, summary },
        text: 'Marked complete. The operator will review and merge each branch. You can stop here.',
        log: [{ kind: 'system', summary: `${me} finished the team goal: ${summary}` }],
        finished: summary,
      };
    }

    default:
      throw new BoardError(`unknown tool "${name}"`);
  }
}
