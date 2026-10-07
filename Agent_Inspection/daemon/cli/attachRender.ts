import { describeToolInput } from '../domain/text.ts';
import type { Agent, AgentEvent, AgentStatus, EventKind, PendingInterception } from '../domain/types.ts';
import type { TaskStatus, TeamLogEntry, TeamLogKind, TeamTask, TeamView } from '../teams/types.ts';

/** Pure formatting for the attach console. Colour is applied later, by tone. */

export type Tone = 'plain' | 'dim' | 'info' | 'ok' | 'warn' | 'error' | 'you';

export interface Line {
  readonly text: string;
  readonly tone: Tone;
}

const line = (text: string, tone: Tone = 'plain'): Line => ({ text, tone });

/**
 * Agent-written text must never drive the terminal: drop C0/C1 control characters
 * (ESC, BEL, CSI…) so escape sequences arrive as harmless printable leftovers, and flatten
 * line breaks so an agent cannot forge a console line such as an approval notice.
 */
export function sanitize(text: string): string {
  return text.replace(/[\t\n\r]/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

export function clockTime(ts: number): string {
  const date = new Date(ts);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

const EVENT_STYLE: Record<EventKind, { readonly glyph: string; readonly tone: Tone }> = {
  prompt: { glyph: 'you ›', tone: 'you' },
  assistant: { glyph: '✎', tone: 'plain' },
  tool_call: { glyph: '⚙', tone: 'dim' },
  tool_result: { glyph: '↳', tone: 'dim' },
  status: { glyph: '─', tone: 'dim' },
  stop: { glyph: '■', tone: 'warn' },
  system: { glyph: '◇', tone: 'info' },
  error: { glyph: '✖', tone: 'error' },
};

export function renderEvent(event: AgentEvent): Line {
  const style = EVENT_STYLE[event.kind];
  return line(`${clockTime(event.ts)}  ${style.glyph} ${sanitize(event.summary)}`, style.tone);
}

export const eventKey = (event: AgentEvent): string => `${event.ts}|${event.kind}|${event.summary}`;

const LOG_STYLE: Record<TeamLogKind, { readonly glyph: string; readonly tone: Tone }> = {
  message: { glyph: '✉', tone: 'plain' },
  task: { glyph: '▣', tone: 'info' },
  activity: { glyph: '·', tone: 'dim' },
  system: { glyph: '◇', tone: 'dim' },
  merge: { glyph: '⇲', tone: 'ok' },
};

export function renderLogEntry(entry: TeamLogEntry): Line {
  const style = LOG_STYLE[entry.kind];
  const text = entry.kind === 'activity' ? `${entry.actor} ${entry.summary}` : entry.summary;
  return line(`${clockTime(entry.ts)}  ${style.glyph} ${sanitize(text)}`, style.tone);
}

export const logKey = (entry: TeamLogEntry): string => `${entry.ts}|${entry.actor}|${entry.summary}`;

/** Member tool activity is noisy: shown only with /filter everything, like the UI's "Everything" view. */
export const isVisibleLogEntry = (entry: TeamLogEntry, everything: boolean): boolean => everything || entry.kind !== 'activity';

export function renderPending(pending: PendingInterception, who: string): Line[] {
  return [
    line(`⏸ ${sanitize(who)} wants to run ${sanitize(describeToolInput(pending.toolName, pending.input))}`, 'warn'),
    line('   /approve to run it, /deny [reason] to skip it, /ask to use Claude Code\'s own prompt', 'dim'),
  ];
}

export const STATUS_WORD: Record<AgentStatus, string> = {
  busy: 'working', idle: 'idle', waiting: 'waiting for you', stopped: 'stopped', unknown: 'unknown',
};

export const TEAM_STATUS_WORD: Record<TeamView['status'], string> = {
  running: 'running', paused: 'paused', done: 'ready to merge', stopped: 'stopped', disbanded: 'disbanded',
};

const TASK_COLUMNS: ReadonlyArray<{ readonly status: TaskStatus; readonly label: string }> = [
  { status: 'open', label: 'Open' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
];

export function renderTasks(tasks: readonly TeamTask[]): Line[] {
  if (tasks.length === 0) return [line('No tasks yet. The lead creates them after planning.', 'dim')];
  return TASK_COLUMNS.flatMap(({ status, label }) => {
    const inColumn = tasks.filter((task) => task.status === status);
    if (inColumn.length === 0) return [];
    return [
      line(`${label} (${inColumn.length})`, 'info'),
      ...inColumn.map((task) => line(
        `  ${task.id.padEnd(4)} ${sanitize(task.title)}${task.assignee ? `  @${task.assignee}` : ''}${task.note ? ` — ${sanitize(task.note)}` : ''}`,
      )),
    ];
  });
}

export function renderMembers(team: TeamView, agents: readonly Agent[]): Line[] {
  return team.members.map((member) => {
    const agent = member.agentId ? agents.find((candidate) => candidate.id === member.agentId) : undefined;
    const state = member.terminal ? 'in your CLI' : member.merged ? 'merged'
      : !member.agentId ? 'not started' : agent ? STATUS_WORD[agent.status] : 'exited';
    const kind = `${member.role} · ${member.vendor === 'claude' ? 'Claude' : 'Codex'}${member.model ? ` ${member.model}` : ''}`;
    return line(`  ${member.name.padEnd(12)} ${kind.padEnd(24)} ${state.padEnd(15)} ${member.branch}`);
  });
}

export function agentBanner(agent: Agent): Line[] {
  return [
    line(`━━ ${sanitize(agent.name)} ━━`, 'info'),
    line(`${agent.vendor} · ${sanitize(agent.source)} · ${STATUS_WORD[agent.status]}${agent.cwd ? ` · ${sanitize(agent.cwd)}` : ''}`, 'dim'),
    line('Type a message, or /help for commands.', 'dim'),
  ];
}

export function teamBanner(team: TeamView, everything: boolean): Line[] {
  const minutesLeft = Math.max(0, Math.round((team.budget.deadline - Date.now()) / 60_000));
  return [
    line(`━━ ${sanitize(team.name)} · ${TEAM_STATUS_WORD[team.status]} ━━`, 'info'),
    line(`Goal: ${sanitize(team.goal)}`),
    line(`Base ${team.baseBranch} · wake-ups ${team.budget.wakesUsed}/${team.budget.maxWakes} · ${minutesLeft} min left · ${team.repoRoot}`, 'dim'),
    line(`Showing ${everything ? 'everything' : 'the team channel'}. Type a message, @name to address one member, or /help.`, 'dim'),
  ];
}
