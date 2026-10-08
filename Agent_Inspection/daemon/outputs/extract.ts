import { posix } from 'node:path';
import type { AgentEvent } from '../domain/types.ts';
import type { ChangedFile, OutputTurn } from './types.ts';

/**
 * Reads what an agent produced from its recorded events. Tool-call summaries look like
 * "Edit: C:\repo\a.ts" or "apply_patch: *** Begin Patch *** Update File: a.ts @@ …" (see describeToolInput),
 * with newlines collapsed and clipped at 200 characters, so paths are recovered from that text.
 */

const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const HELD_PREFIX = /^⏸\s*/;
const CLIPPED = '…';
/** A patch header's path runs until the next patch line ("@@", "***", "+x", "-x") or the end. */
const PATCH_FILE = /\*\*\* (?:(?:Update|Add|Delete) File|Move to):\s*(.+?)(?=\s+(?:@@|\*\*\*|[+-])|\s*$)/g;
const TURN_DONE = /^(?:turn complete|finished its turn)/i;
const MAX_TURNS = 100;
const MAX_TURN_ERRORS = 5;

export interface ToolFileTouch {
  readonly tool: string;
  readonly path: string;
}

const isHeld = (summary: string): boolean => HELD_PREFIX.test(summary);

/** Files a single tool call wrote or edited, as recorded (not yet relative to the agent's folder). */
export function filesFromToolSummary(summary: string): ToolFileTouch[] {
  if (isHeld(summary)) return [];
  const colon = summary.indexOf(':');
  const tool = (colon >= 0 ? summary.slice(0, colon) : summary).trim();
  const arg = colon >= 0 ? summary.slice(colon + 1).trim() : '';
  if (WRITE_TOOLS.has(tool)) return arg && !arg.endsWith(CLIPPED) ? [{ tool, path: arg }] : [];
  return [...summary.matchAll(PATCH_FILE)]
    .map((match) => match[1].trim())
    .filter((path) => path.length > 0 && !path.endsWith(CLIPPED))
    .map((path) => ({ tool: 'apply_patch', path }));
}

interface Located {
  readonly key: string;
  readonly path: string;
  readonly insideCwd: boolean;
}

const toSlash = (path: string): string => path.replace(/\\/g, '/');
const isAbsolutePath = (slashed: string): boolean => /^[a-zA-Z]:\//.test(slashed) || slashed.startsWith('/');

/** Places a recorded path relative to the agent's folder when it is inside it. Windows folders compare case-insensitively. */
export function locatePath(raw: string, cwd: string | undefined): Located {
  const slashed = toSlash(raw);
  const caseless = cwd !== undefined && /^[a-zA-Z]:/.test(cwd);
  const fold = (text: string) => (caseless ? text.toLowerCase() : text);
  const outside = (): Located => ({ key: `abs:${fold(slashed)}`, path: raw, insideCwd: false });
  if (!cwd) return outside();
  const base = toSlash(cwd).replace(/\/+$/, '');
  if (isAbsolutePath(slashed)) {
    if (!fold(slashed).startsWith(`${fold(base)}/`)) return outside();
    return inside(slashed.slice(base.length + 1), fold) ?? outside();
  }
  return inside(slashed, fold) ?? outside();
}

function inside(relative: string, fold: (text: string) => string): Located | undefined {
  const rel = posix.normalize(relative).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || rel.startsWith('/')) return undefined;
  return { key: `rel:${fold(rel)}`, path: rel, insideCwd: true };
}

interface FileAccumulator {
  readonly path: string;
  readonly insideCwd: boolean;
  readonly touches: number;
  readonly firstTouchedAt: number;
  readonly lastTouchedAt: number;
  readonly tools: readonly string[];
}

/** Every file the agent wrote or edited, with how often and when, most recently touched first. */
export function extractChangedFiles(events: readonly AgentEvent[], cwd: string | undefined): ChangedFile[] {
  const files = new Map<string, FileAccumulator>();
  for (const event of events) {
    if (event.kind !== 'tool_call') continue;
    for (const touch of filesFromToolSummary(event.summary)) {
      const located = locatePath(touch.path, cwd);
      const prev = files.get(located.key);
      files.set(located.key, prev
        ? {
          ...prev,
          touches: prev.touches + 1,
          lastTouchedAt: Math.max(prev.lastTouchedAt, event.ts),
          firstTouchedAt: Math.min(prev.firstTouchedAt, event.ts),
          tools: prev.tools.includes(touch.tool) ? prev.tools : [...prev.tools, touch.tool],
        }
        : { path: located.path, insideCwd: located.insideCwd, touches: 1, firstTouchedAt: event.ts, lastTouchedAt: event.ts, tools: [touch.tool] });
    }
  }
  return [...files.values()].sort((a, b) => b.lastTouchedAt - a.lastTouchedAt);
}

interface TurnDraft {
  readonly startedAt: number;
  readonly prompt?: string;
  readonly complete: boolean;
  readonly endedAt?: number;
  readonly result?: string;
  readonly resultAt?: number;
  readonly toolCalls: number;
  /** key → display path, in first-touched order. */
  readonly files: ReadonlyMap<string, string>;
  readonly errors: readonly string[];
  readonly hasContent: boolean;
}

const newTurn = (startedAt: number, prompt?: string): TurnDraft =>
  ({ startedAt, prompt, complete: false, toolCalls: 0, files: new Map(), errors: [], hasContent: false });

const finish = (turn: TurnDraft, ts: number): TurnDraft => ({ ...turn, complete: true, endedAt: turn.endedAt ?? ts });

function withToolCall(turn: TurnDraft, event: AgentEvent, cwd: string | undefined): TurnDraft {
  const files = new Map(turn.files);
  for (const touch of filesFromToolSummary(event.summary)) {
    const located = locatePath(touch.path, cwd);
    if (!files.has(located.key)) files.set(located.key, located.path);
  }
  return { ...turn, toolCalls: turn.toolCalls + 1, files, hasContent: true };
}

/** Applies one event; returns the closed turn (if this event ended one) and the turn now open. */
function step(open: TurnDraft | undefined, event: AgentEvent, cwd: string | undefined): { closed?: TurnDraft; open?: TurnDraft } {
  const current = () => open ?? newTurn(event.ts);
  switch (event.kind) {
    case 'prompt':
      if (open && (open.prompt !== undefined || open.hasContent)) return { closed: finish(open, event.ts), open: newTurn(event.ts, event.summary) };
      return { open: open ? { ...open, prompt: event.summary } : newTurn(event.ts, event.summary) };
    case 'assistant':
      return { open: { ...current(), result: event.summary, resultAt: event.ts, hasContent: true } };
    case 'tool_call':
      return isHeld(event.summary) ? { open } : { open: withToolCall(current(), event, cwd) };
    case 'error': {
      const turn = current();
      return { open: { ...turn, errors: [...turn.errors, event.summary].slice(-MAX_TURN_ERRORS), hasContent: true } };
    }
    case 'status':
      if (TURN_DONE.test(event.summary)) return { open: open && finish(open, event.ts) };
      if (event.summary === 'turn started' && open?.complete) return { closed: open, open: newTurn(event.ts) };
      if (event.summary === 'turn started' && !open) return { open: newTurn(event.ts) };
      return { open };
    case 'stop':
      return { open: open && finish(open, event.ts) };
    default:
      return { open };
  }
}

const toTurn = (draft: TurnDraft, index: number): OutputTurn => ({
  id: `${draft.startedAt}-${index}`,
  prompt: draft.prompt,
  startedAt: draft.startedAt,
  endedAt: draft.endedAt,
  complete: draft.complete,
  result: draft.result,
  resultAt: draft.resultAt,
  toolCalls: draft.toolCalls,
  files: [...draft.files.values()],
  errors: draft.errors,
});

/** Splits the session into request → result turns, newest first. */
export function groupTurns(events: readonly AgentEvent[], cwd: string | undefined): OutputTurn[] {
  const drafts: TurnDraft[] = [];
  let open: TurnDraft | undefined;
  for (const event of events) {
    const next = step(open, event, cwd);
    if (next.closed) drafts.push(next.closed);
    open = next.open;
  }
  if (open) drafts.push(open);
  return drafts.map(toTurn).reverse().slice(0, MAX_TURNS);
}
