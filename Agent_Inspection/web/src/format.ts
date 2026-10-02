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

export const STATUS_LABEL: Record<Agent['status'], string> = {
  busy: 'Working',
  idle: 'Idle',
  waiting: 'Needs you',
  stopped: 'Stopped',
  unknown: 'Running',
};
