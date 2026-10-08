import type { Agent, PendingInterception } from '../api.ts';
import { plainToolActivity } from '../../../shared/plainActivity.ts';

/** Claude Code's "ask the user" tool: it needs real answers, so the station only links to the full panel. */
export const ASK_TOOL = 'AskUserQuestion';
// pattern before path: Grep's path is only the folder it searches in.
const ARG_KEYS = ['command', 'file_path', 'pattern', 'path', 'url', 'query'] as const;
/** Cost meter steps, in USD: under each bound is one more coin. */
export const COST_STEPS = [0.1, 1, 5] as const;

export type DeskBubble =
  | { readonly kind: 'approval'; readonly item: PendingInterception }
  | { readonly kind: 'question'; readonly item: PendingInterception }
  | { readonly kind: 'ask' };

/** "Bash: npm test" from a held call: tool name plus its first meaningful string argument. */
export function pendingSummary(item: Pick<PendingInterception, 'toolName' | 'input'>): string {
  const arg = ARG_KEYS.map(key => item.input?.[key]).find((value): value is string => typeof value === 'string' && value.trim() !== '');
  return arg ? `${item.toolName}: ${arg.trim().replace(/\s+/g, ' ')}` : item.toolName;
}

/** Plain-language wording for a held call, e.g. "Running npm test". */
export function describePending(item: Pick<PendingInterception, 'toolName' | 'input'>): string {
  return plainToolActivity(pendingSummary(item));
}

/** Bubble text area: characters per line and lines shown before the call must be reviewed in the panel. */
export const BUBBLE_LINE_CHARS = 40;
export const BUBBLE_MAX_LINES = 4;
/** Tools whose whole effect is the argument shown (a command, or a read-only lookup). Others, like Write or Edit, carry content the bubble cannot show. */
const ONE_CLICK_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'exec', 'exec_command', 'shell', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);

export interface ApprovalView {
  /** The argument exactly as it will run, line breaks kept, hard-wrapped for the bubble. */
  readonly lines: readonly string[];
  /** Approve from the floor only when the bubble shows everything the call will do. */
  readonly oneClick: boolean;
}

export function approvalView(item: Pick<PendingInterception, 'toolName' | 'input'>): ApprovalView {
  const arg = ARG_KEYS.map(key => item.input?.[key]).find((value): value is string => typeof value === 'string' && value.trim() !== '');
  if (!arg) return { lines: [], oneClick: false };
  const wrapped = arg.replace(/\r\n?/g, '\n').split('\n')
    .flatMap(line => line.length === 0 ? [''] : Array.from({ length: Math.ceil(line.length / BUBBLE_LINE_CHARS) }, (_, i) => line.slice(i * BUBBLE_LINE_CHARS, (i + 1) * BUBBLE_LINE_CHARS)));
  const fits = wrapped.length <= BUBBLE_MAX_LINES;
  const lines = fits ? wrapped : [...wrapped.slice(0, BUBBLE_MAX_LINES - 1), `${wrapped[BUBBLE_MAX_LINES - 1].slice(0, BUBBLE_LINE_CHARS - 1)}…`];
  return { lines, oneClick: fits && ONE_CLICK_TOOLS.has(item.toolName) };
}

/** The oldest held call for this agent, if any. */
export function pendingFor(agentId: string, pending: readonly PendingInterception[]): PendingInterception | undefined {
  return pending.filter(item => item.agentId === agentId).sort((a, b) => a.createdAt - b.createdAt)[0];
}

/** A held call wins over the generic "A little help?" bubble, which stays for waiting agents with nothing held. */
export function deskBubble(agent: Pick<Agent, 'id' | 'status'>, pending: readonly PendingInterception[]): DeskBubble | undefined {
  const item = pendingFor(agent.id, pending);
  if (item) return item.toolName === ASK_TOOL ? { kind: 'question', item } : { kind: 'approval', item };
  return agent.status === 'waiting' ? { kind: 'ask' } : undefined;
}

/** 1–4 coins by spend; undefined when the cost is unknown. */
export function costStep(costUsd: number | undefined): number | undefined {
  if (costUsd === undefined || !Number.isFinite(costUsd)) return undefined;
  const below = COST_STEPS.findIndex(bound => costUsd < bound);
  return below === -1 ? COST_STEPS.length + 1 : below + 1;
}

/** The runaway guard's alarm, only once it has stepped in. */
export function breakerAlarm(agent: Pick<Agent, 'breaker'>): NonNullable<Agent['breaker']> | undefined {
  return agent.breaker && agent.breaker.level !== 'ok' ? agent.breaker : undefined;
}

/** Shortens text for a fixed-width SVG label. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
