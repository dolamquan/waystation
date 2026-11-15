import type { AgentEvent } from '../../api.ts';
import { isApprovalReview } from '../../../../shared/approvalReview.ts';

/** Keep a tile's DOM small: many feeds can be mounted at once. */
export const MAX_FEED_LINES = 400;
export const MAX_LINE_CHARS = 600;

export type FeedTone = 'prompt' | 'assistant' | 'tool' | 'result' | 'error' | 'approval' | 'status';

export interface FeedLine {
  /** Stable React key: position-independent for the same event, unique within a list. */
  readonly id: string;
  readonly tone: FeedTone;
  readonly text: string;
}

/**
 * Events carry no sequence number, so identity is agent + time + kind + summary (the same key the activity
 * list uses). Live and fetched events overlap while the first request is in flight.
 */
export function eventKey(event: AgentEvent): string {
  return JSON.stringify([event.agentId, event.ts, event.kind, event.summary]);
}

/** Merge history with live events: other agents' events dropped, duplicates removed, oldest first, newest kept. */
export function mergeFeedEvents(
  existing: readonly AgentEvent[],
  incoming: readonly AgentEvent[],
  agentId?: string,
): readonly AgentEvent[] {
  const unique = new Map<string, AgentEvent>();
  for (const event of [...existing, ...incoming]) {
    if (agentId !== undefined && event.agentId !== agentId) continue;
    const key = eventKey(event);
    if (!unique.has(key)) unique.set(key, event);
  }
  // Array.prototype.sort is stable, so events sharing a timestamp keep arrival order.
  return [...unique.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_FEED_LINES);
}

/** A summary is cut to this before it is split, so a multi-megabyte event costs nothing per render. */
export const MAX_SUMMARY_CHARS = 20_000;
/** Bidi controls (U+202A-U+202E, U+2066-U+2069) let event text visually reorder the lines around it. */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;
const sanitize = (text: string): string => text.slice(0, MAX_SUMMARY_CHARS).replace(BIDI_CONTROLS, '');

function clip(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS - 1)}…` : text;
}

function splitLines(text: string): string[] {
  const rows = sanitize(text).replace(/\r\n?/g, '\n').split('\n').map(row => row.trimEnd());
  // Drop leading/trailing blanks but keep one-line-minimum so an empty event is still visible.
  const trimmed = rows.join('\n').replace(/^\n+|\n+$/g, '');
  return (trimmed || '(empty)').split('\n').map(clip);
}

/** "Bash: npm test" -> "$ Bash  npm test". Summaries without a tool prefix are shown as-is. */
function formatToolCall(summary: string): { readonly text: string; readonly pending: boolean } {
  const pending = /^⏸\s*/.test(summary);
  const body = summary.replace(/^⏸\s*/, '');
  const colon = body.indexOf(':');
  const head = colon > 0 && colon <= 40 && !/\s/.test(body.slice(0, colon).trim()) ? body.slice(0, colon).trim() : '';
  const text = head ? `$ ${head}  ${body.slice(colon + 1).trim()}`.trimEnd() : `$ ${body}`;
  return { text: pending ? `${text}  (awaiting approval)` : text, pending };
}

function eventRows(event: AgentEvent): readonly { readonly tone: FeedTone; readonly text: string }[] {
  const summary = typeof event.summary === 'string' ? sanitize(event.summary) : '';
  switch (event.kind) {
    case 'prompt':
      return splitLines(summary).map((text, i) => ({ tone: 'prompt', text: i === 0 ? `> ${text}` : `  ${text}` }));
    case 'assistant':
      if (isApprovalReview(summary)) return [];
      return splitLines(summary).map(text => ({ tone: 'assistant', text }));
    case 'tool_call': {
      const call = formatToolCall(summary);
      return [{ tone: call.pending ? 'approval' : 'tool', text: clip(call.text) }];
    }
    case 'tool_result': {
      const failed = event.tool?.failed === true || (typeof event.tool?.exitCode === 'number' && event.tool.exitCode !== 0);
      return splitLines(summary).map((text, i) => ({ tone: failed ? 'error' : 'result', text: `  ${text}` }));
    }
    case 'error':
      return splitLines(summary).map(text => ({ tone: 'error', text: `! ${text}` }));
    case 'status':
    case 'system':
    case 'stop':
      return [{ tone: 'status', text: clip(`-- ${summary || event.kind}`) }];
    default:
      // A newer daemon may add kinds; show them neutrally rather than hide or crash.
      return [{ tone: 'status', text: clip(`-- ${String((event as { kind?: unknown }).kind ?? 'event')}: ${summary}`.trimEnd()) }];
  }
}

/** Turn events (any order is fine; they are rendered as given) into at most MAX_FEED_LINES display lines. */
export function toFeedLines(events: readonly AgentEvent[]): readonly FeedLine[] {
  const lines: FeedLine[] = [];
  const seen = new Map<string, number>();
  for (const event of events) {
    const base = eventKey(event);
    const repeat = seen.get(base) ?? 0;
    seen.set(base, repeat + 1);
    eventRows(event).forEach((row, i) => lines.push({ id: `${base}#${repeat}:${i}`, ...row }));
  }
  return lines.slice(-MAX_FEED_LINES);
}
