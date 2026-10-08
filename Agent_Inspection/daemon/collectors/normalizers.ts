import type { AgentEvent, EventKind } from '../domain/types.ts';
import { describeToolInput, summarize, summarizeBlock, taskTitle } from '../domain/text.ts';
import { isApprovalReview } from '../../shared/approvalReview.ts';

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;

const toTs = (value: unknown, fallback: number): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  return fallback;
};

/** Agent replies are what the Outputs tab shows as results, so they keep far more than other summaries. */
const REPLY_MAX = 4000;

const make = (agentId: string, ts: number, kind: EventKind, summary: string): AgentEvent =>
  ({ agentId, ts, kind, summary });

export interface NormalizedTranscript {
  readonly events: AgentEvent[];
  readonly title?: string;
  /** A short name derived from a user request; collectors keep the first one as a fallback session name. */
  readonly taskTitle?: string;
}

/** Claude Code transcript line (~/.claude/projects/<slug>/<session>.jsonl) -> events. */
export function normalizeClaudeLine(agentId: string, line: unknown, now = Date.now()): NormalizedTranscript {
  const entry = asRecord(line);
  if (!entry) return { events: [] };
  if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') return { events: [], title: entry.aiTitle };
  if (entry.isSidechain === true) return { events: [] };

  const ts = toTs(entry.timestamp, now);
  const message = asRecord(entry.message);
  const content = message?.content;

  if (entry.type === 'user') {
    if (typeof content === 'string') return { events: [make(agentId, ts, 'prompt', summarize(content))], taskTitle: taskTitle(content) };
    if (Array.isArray(content)) {
      const text = content.map(asRecord).find((block) => block?.type === 'text');
      if (text && typeof text.text === 'string' && !text.text.startsWith('<')) {
        return { events: [make(agentId, ts, 'prompt', summarize(text.text))], taskTitle: taskTitle(text.text) };
      }
    }
    return { events: [] };
  }

  if (entry.type === 'assistant' && Array.isArray(content)) {
    const events = content.flatMap((raw): AgentEvent[] => {
      const block = asRecord(raw);
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        return [make(agentId, ts, 'tool_call', describeToolInput(block.name, block.input))];
      }
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return [make(agentId, ts, 'assistant', summarizeBlock(block.text, REPLY_MAX))];
      }
      return [];
    });
    return { events };
  }
  return { events: [] };
}

/** Codex rollout line (~/.codex/sessions/YYYY/MM/DD/*.jsonl) -> events. */
export function normalizeCodexLine(agentId: string, line: unknown, now = Date.now()): NormalizedTranscript {
  const entry = asRecord(line);
  const payload = asRecord(entry?.payload);
  if (!entry || !payload) return { events: [] };
  const ts = toTs(entry.timestamp, now);

  if (entry.type === 'response_item') {
    if ((payload.type === 'function_call' || payload.type === 'custom_tool_call') && typeof payload.name === 'string') {
      const input = payload.input ?? payload.arguments;
      return { events: [make(agentId, ts, 'tool_call', describeToolInput(payload.name, input))] };
    }
    if (payload.type === 'message' && payload.role === 'assistant' && Array.isArray(payload.content)) {
      const text = payload.content.map(asRecord).find((block) => typeof block?.text === 'string');
      if (text) {
        const message = String(text.text);
        return { events: [make(agentId, ts, isApprovalReview(message) ? 'system' : 'assistant', summarizeBlock(message, REPLY_MAX))] };
      }
    }
    return { events: [] };
  }

  if (entry.type === 'event_msg') {
    if (payload.type === 'user_message' && typeof payload.message === 'string') {
      return { events: [make(agentId, ts, 'prompt', summarize(payload.message))], taskTitle: taskTitle(payload.message) };
    }
    if (payload.type === 'agent_message' && typeof payload.message === 'string') {
      return { events: [make(agentId, ts, isApprovalReview(payload.message) ? 'system' : 'assistant', summarizeBlock(payload.message, REPLY_MAX))] };
    }
    if (payload.type === 'task_started') return { events: [make(agentId, ts, 'status', 'turn started')] };
    if (payload.type === 'task_complete') return { events: [make(agentId, ts, 'status', 'turn complete')] };
  }
  return { events: [] };
}

export interface CodexSessionMeta {
  readonly id: string;
  readonly cwd?: string;
  readonly originator?: string;
  readonly startedAt?: number;
  readonly parentThreadId?: string;
  readonly agentRole?: string;
  readonly agentNickname?: string;
}

export function parseCodexSessionMeta(line: unknown): CodexSessionMeta | undefined {
  const entry = asRecord(line);
  const payload = asRecord(entry?.payload);
  if (entry?.type !== 'session_meta' || !payload || typeof payload.id !== 'string') return undefined;
  const subagent = asRecord(asRecord(payload.source)?.subagent);
  const spawn = asRecord(subagent?.thread_spawn);
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const parentThreadId = text(payload.parent_thread_id) ?? text(spawn?.parent_thread_id);
  return {
    id: payload.id,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
    originator: typeof payload.originator === 'string' ? payload.originator : undefined,
    startedAt: toTs(payload.timestamp ?? entry.timestamp, Date.now()),
    parentThreadId: parentThreadId !== payload.id ? parentThreadId : undefined,
    agentRole: text(payload.agent_role) ?? text(spawn?.agent_role) ?? text(subagent?.other),
    agentNickname: text(payload.agent_nickname) ?? text(spawn?.agent_nickname),
  };
}
