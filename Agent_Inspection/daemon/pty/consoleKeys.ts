import type { ConsoleKind } from './types.ts';

/**
 * Fixed keystrokes the board may send to a console on the operator's behalf (team "Pause all" / "Resume all"),
 * and the handoff brief. Nothing here passes operator text through as raw keys: a handoff is wrapped in one
 * bracketed paste, so its newlines cannot submit early and an embedded paste-end cannot escape into the shell.
 */

export const KEY_ACTIONS = ['pause', 'resume'] as const;
export type KeyAction = (typeof KEY_ACTIONS)[number];

export const isKeyAction = (value: unknown): value is KeyAction =>
  typeof value === 'string' && (KEY_ACTIONS as readonly string[]).includes(value);

/** Esc interrupts the running turn in Claude Code and Codex; "continue" picks the work back up. Shells get nothing. */
const KEYS: Readonly<Record<KeyAction, Readonly<Partial<Record<ConsoleKind, string>>>>> = {
  pause: { claude: '\x1b', codex: '\x1b' },
  resume: { claude: 'continue\r', codex: 'continue\r' },
};

export function keysFor(action: KeyAction, kind: ConsoleKind): string | undefined {
  return KEYS[action][kind];
}

export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';
export const MAX_TASK_CHARS = 4000;
const TAIL_LINES = 40;
const TAIL_CHARS = 6000;

// CSI (colours, cursor moves), OSC (titles, links; ended by BEL or ST) and the other two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** The last lines a console printed, as plain text: no escape codes, no blank lines, at most `maxChars`. */
export function plainTail(scrollback: string, maxLines = TAIL_LINES, maxChars = TAIL_CHARS): string {
  const lines = scrollback.replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n')
    .map((line) => line.replace(CONTROL, '').trimEnd())
    .filter((line) => line.trim() !== '');
  const tail = lines.slice(-maxLines).join('\n');
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;
}

export interface HandoffRequest { readonly to: string; readonly task: string }

export function validateHandoff(raw: unknown): HandoffRequest {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const to = typeof body.to === 'string' ? body.to.trim() : '';
  const task = typeof body.task === 'string' ? body.task.trim() : '';
  if (!to) throw new Error('Choose the console to hand the task to.');
  if (!task) throw new Error('Describe the task to hand over.');
  if (task.length > MAX_TASK_CHARS) throw new Error(`The task is too long (at most ${MAX_TASK_CHARS} characters).`);
  return { to, task };
}

/** Removes paste markers and control characters (keeping newlines), so nothing in the brief can act as a keystroke. */
const inert = (text: string): string =>
  text.split(BRACKETED_PASTE_END).join('').split(BRACKETED_PASTE_START).join('').replace(/\r\n?/g, '\n').replace(CONTROL, '');

/** One bracketed paste holding the task and the source console's recent output; the caller submits it with Enter. */
export function handoffBrief({ from, task, context }: { readonly from: string; readonly task: string; readonly context: string }): string {
  const body = [
    `Handoff from ${inert(from)}: please take over this task.`,
    '',
    `Task: ${inert(task)}`,
    ...(context ? ['', `Recent output from ${inert(from)} (for context):`, inert(context)] : []),
  ].join('\n');
  return `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`;
}
