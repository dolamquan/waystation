import { redact } from '../domain/text.ts';
import {
  MAX_MESSAGE_CHARS, BoardError, allTasksDone, claimTask, createTask, displayName, historyFor, isPlanPhase, lead, planPhase, toolStatus, markRead, memberById,
  memberByName, postMessage, unreadFor, updateTask,
} from './board.ts';
import {
  EVERYONE, SYSTEM, type TeamLogKind, type TeamMember, type TeamMessage, type TeamState, type TeamStatus, type TeamTask,
} from './types.ts';

/** The team MCP surface. Same tools for every model; role decides which ones are offered. */

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** One log entry for the call. The actor is the calling member; `summary` is the body only (no "a → b:" prefix). */
export interface ToolLogItem {
  readonly kind: TeamLogKind;
  readonly summary: string;
  /** message: recipient member id or EVERYONE. */
  readonly to?: string;
  /** message: the TeamMessage id. */
  readonly messageId?: string;
}

export interface ToolOutcome {
  readonly state: TeamState;
  readonly text: string;
  readonly log: readonly ToolLogItem[];
  /** Set by finish_team: the lead's final summary. */
  readonly finished?: string;
  /** Set by submit_plan: the returned state is in 'plan_review'; wake nobody. */
  readonly submittedPlan?: true;
}

const str = (description: string) => ({ type: 'string', description });
const schema = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, required, additionalProperties: false });

const COMMON_TOOLS: readonly ToolDefinition[] = [
  { name: 'team_roster', description: 'List your teammates: name, role, model, focus, and what they are working on.', inputSchema: schema({}) },
  {
    name: 'post_message',
    description: 'Send a message on the team channel. Use a teammate name, or "all" to broadcast. Recipients are woken up to read it, so keep messages purposeful.',
    inputSchema: schema({ to: str('Teammate name, or "all"'), text: str('Message body') }, ['to', 'text']),
  },
  { name: 'read_messages', description: 'Read new team messages addressed to you (and recent history if there are none).', inputSchema: schema({}) },
  { name: 'list_tasks', description: 'Show the shared task board.', inputSchema: schema({}) },
  {
    name: 'create_task',
    description: 'Add a task to the shared board, optionally assigning it to a teammate (who is notified, once the plan is approved if one is required).',
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

const FINISH_TEAM: ToolDefinition = {
  name: 'finish_team',
  description: 'Lead only: declare the goal complete once every task is done and you have reviewed the work. Not available while a plan awaits approval. The operator then reviews and merges each branch.',
  inputSchema: schema({ summary: str('What the team delivered, branch by branch, and anything left for the operator') }, ['summary']),
};

const SUBMIT_PLAN: ToolDefinition = {
  name: 'submit_plan',
  description: 'Lead only, while planning: send the drafted task board to the operator for approval, then end your turn. Nobody is woken until the operator approves or replies.',
  inputSchema: schema({ rationale: str('One or two sentences: why this split and assignment') }, ['rationale']),
};

/**
 * Every tool a member's role can use, for the MCP tool list. Agents fetch that list once per session and the
 * bridge cannot announce changes, so it must not depend on the phase: callTool gates phase-bound tools instead.
 */
export function advertisedTools(member: TeamMember): readonly ToolDefinition[] {
  return member.role === 'lead' ? [...COMMON_TOOLS, SUBMIT_PLAN, FINISH_TEAM] : COMMON_TOOLS;
}

/** Tools `member` may call while the team is in `status`. */
export function toolsFor(member: TeamMember, status: TeamStatus): readonly ToolDefinition[] {
  if (member.role !== 'lead') return COMMON_TOOLS;
  if (status === 'planning') return [...COMMON_TOOLS, SUBMIT_PLAN];
  if (status === 'plan_review') return COMMON_TOOLS;
  return [...COMMON_TOOLS, FINISH_TEAM];
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
    const focus = m.focus ? `, focus ${quote(m.focus)}` : '';
    return `${m.name}${you}: ${m.role}, ${m.vendor}${m.model ? ` ${m.model}` : ''}, branch ${m.branch}${focus}${working.length ? `, on ${working.join(', ')}` : ''}`;
  }).join('\n');
}

const notify = (state: TeamState, to: string, text: string) => postMessage(state, SYSTEM, to, text);

/** Log item for the message a postMessage call just appended (always the last one, even after trimming). */
function messageLog(state: TeamState): ToolLogItem {
  const sent = state.messages[state.messages.length - 1];
  return { kind: 'message', summary: sent.text, to: sent.to, messageId: sent.id };
}

function unavailable(state: TeamState, self: TeamMember, name: string): string {
  if (self.role !== 'lead') return `unknown tool "${name}"`;
  if (name === 'finish_team' && isPlanPhase(state)) return 'finish_team is not available until the operator approves the plan';
  if (name === 'submit_plan') return planPhase(state) === 'plan_review' ? 'the plan is already with the operator' : 'there is no plan to submit now';
  return `unknown tool "${name}"`;
}

/** Run one tool call for `memberId`. Throws BoardError for bad input (reported back to the agent). */
export function callTool(state: TeamState, memberId: string, name: string, args: Record<string, unknown>): ToolOutcome {
  const self = memberById(state, memberId);
  if (!self) throw new BoardError('you are not on this team');
  if (!toolsFor(self, toolStatus(state)).some((tool) => tool.name === name)) throw new BoardError(unavailable(state, self, name));
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
      return { state: next, text: `Sent to ${target}.`, log: [messageLog(next)] };
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
      const forOther = !!task.assignee && task.assignee !== self.id;
      const drafting = isPlanPhase(state);
      const next = forOther && !drafting
        ? notify(created.state, task.assignee!, `${me} assigned you ${task.id}: ${task.title}${task.details ? `\n${task.details}` : ''}`)
        : created.state;
      const owner = task.assignee ? ` → ${displayName(next, task.assignee)}` : '';
      const later = forOther && drafting ? ' The assignee is told once the plan is approved.' : '';
      return { state: next, text: `Created ${task.id}.${later}`, log: [{ kind: 'task', summary: `created ${task.id}${owner}: ${task.title}` }] };
    }

    case 'claim_task': {
      const { state: next, task } = claimTask(state, self.id, required(args, 'taskId'));
      return { state: next, text: `You own ${task.id}.`, log: [{ kind: 'task', summary: `claimed ${task.id}: ${task.title}` }] };
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
        log: [{ kind: 'task', summary: `set ${task.id} ${task.status}${note ? `: ${note}` : ''}` }],
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
        log: [{ kind: 'task', summary: `handed ${taskId ?? 'work'} to ${target.name}` }, messageLog(next)],
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
        log: [{ kind: 'system', summary: `finished the team goal: ${summary}` }],
        finished: summary,
      };
    }

    case 'submit_plan': {
      const rationale = redact(required(args, 'rationale')).slice(0, MAX_MESSAGE_CHARS);
      const count = state.tasks.length;
      if (count === 0) throw new BoardError('the board is empty: draft the tasks with create_task first');
      // Submitted while the team is paused mid-plan: it stays paused and resumes into review.
      const submitted: TeamState = state.status === 'planning' ? { ...state, status: 'plan_review' } : { ...state, resumePhase: 'plan_review' };
      return {
        state: submitted,
        text: 'Plan submitted. End your turn now; you are woken when the operator approves it or sends feedback.',
        log: [{ kind: 'system', summary: `submitted the plan (${count} task${count === 1 ? '' : 's'}): ${rationale}` }],
        submittedPlan: true,
      };
    }

    default:
      throw new BoardError(`unknown tool "${name}"`);
  }
}
