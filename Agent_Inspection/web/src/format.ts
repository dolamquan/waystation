import type { Agent } from './api.ts';

export function timeAgo(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export const TIER_LABEL: Record<Agent['tier'], { label: string; hint: string }> = {
  A: { label: 'Full control', hint: 'Launched from the tower: message, interrupt, approve tools, stop.' },
  B: { label: 'Hook control', hint: 'Existing Claude Code session: intercept tool calls and queue instructions via hooks.' },
  C: { label: 'Observe only', hint: 'Watched from logs/processes. Stop may be available; instructions are not.' },
};

export const VENDOR_LABEL: Record<Agent['vendor'], string> = { claude: 'Claude', codex: 'Codex', other: 'Agent' };

/** "claude-opus-5-5" → "Opus 5.5"; other ids stay as they are. */
export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const match = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d))?(?:-\d{8})?$/.exec(model);
  if (!match) return model;
  const [, family, major, minor] = match;
  return `${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}`;
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** Share of the context window used by the latest request, 0–100, when both numbers are known. */
export function contextPercent(agent: Agent): number | undefined {
  const used = agent.usage?.contextTokens;
  const window = agent.usage?.contextWindow;
  return used !== undefined && window ? Math.min(100, Math.round((used / window) * 100)) : undefined;
}

export const BREAKER_LABEL: Record<NonNullable<Agent['breaker']>['level'], string> = {
  ok: 'OK',
  warned: 'Guard warned',
  constrained: 'Guard: approvals on',
  stopped: 'Guard stopped it',
};

export const STATUS_LABEL: Record<Agent['status'], string> = {
  busy: 'Working',
  idle: 'Idle',
  waiting: 'Needs you',
  stopped: 'Stopped',
  unknown: 'Running',
};

/** "Subagent of <parent>" for a subagent card; undefined for top-level agents. */
export function subagentOfLabel(agent: Agent): string | undefined {
  if (!agent.parentId) return undefined;
  return `Subagent of ${agent.subagent?.parentName ?? 'another session'}`;
}

export const subagentCountLabel = (count: number): string => `${count} ${count === 1 ? 'subagent' : 'subagents'}`;
