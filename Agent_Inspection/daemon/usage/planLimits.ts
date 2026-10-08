import type { PlanLimit } from './windowTypes.ts';

/**
 * Real plan-limit readings, as the vendors report them:
 * - Codex writes `rate_limits` (primary ~5h, secondary weekly) on rollout `token_count` events.
 * - The Claude Agent SDK emits `rate_limit_event` messages to managed agents.
 * - Claude Code transcripts record `quotaLimits` only on the synthetic "you've hit your limit" message.
 */

type Json = Record<string, unknown>;

const SECOND = 1000;
const FIVE_HOURS_MIN = 300;
const WEEK_MIN = 7 * 24 * 60;

const asRecord = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const timestampOf = (entry: Json | undefined): number | undefined => {
  const parsed = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
/** Epoch seconds (how both vendors send it) to ms; already-ms values pass through. */
const epochMs = (value: unknown): number | undefined => {
  const n = num(value);
  if (n === undefined || n <= 0) return undefined;
  return n < 1e12 ? n * SECOND : n;
};

const CLAUDE_LABELS: Readonly<Record<string, string>> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_oauth_apps: 'Weekly · apps',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
  seven_day_overage_included: 'Weekly · incl. extra usage',
  overage: 'Extra usage',
  unknown: 'Plan limit',
};

/** Display order: the 5-hour window first, then weekly ones. */
export const LIMIT_ORDER = ['five_hour', 'weekly', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage'];

export function sortLimits(limits: readonly PlanLimit[]): PlanLimit[] {
  const rank = (window: string) => {
    const index = LIMIT_ORDER.indexOf(window);
    return index === -1 ? LIMIT_ORDER.length : index;
  };
  return [...limits].sort((a, b) => rank(a.window) - rank(b.window));
}

function codexWindowName(minutes: number | undefined, fallback: 'five_hour' | 'weekly'): { window: string; label: string } {
  if (minutes === FIVE_HOURS_MIN) return { window: 'five_hour', label: '5-hour' };
  if (minutes === WEEK_MIN) return { window: 'weekly', label: 'Weekly' };
  if (minutes === undefined) return { window: fallback, label: fallback === 'five_hour' ? '5-hour' : 'Weekly' };
  const label = minutes % (24 * 60) === 0 ? `${minutes / (24 * 60)}-day` : `${Math.round(minutes / 60)}-hour`;
  return { window: `${minutes}m`, label };
}

function codexWindow(raw: unknown, fallback: 'five_hour' | 'weekly', observedAt: number): PlanLimit | undefined {
  const window = asRecord(raw);
  const usedPercent = num(window?.used_percent);
  if (!window || usedPercent === undefined) return undefined;
  const windowMinutes = num(window.window_minutes);
  const resetsIn = num(window.resets_in_seconds);
  const resetsAt = epochMs(window.resets_at) ?? (resetsIn !== undefined ? observedAt + resetsIn * SECOND : undefined);
  return {
    ...codexWindowName(windowMinutes, fallback),
    usedPercent,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    observedAt,
    source: 'codex',
  };
}

export interface CodexLimitReading {
  readonly limits: readonly PlanLimit[];
  readonly planType?: string;
  readonly observedAt: number;
}

/** `rate_limits` on a Codex rollout `token_count` event, or undefined. */
export function codexRateLimits(line: unknown, fallbackTs = Date.now()): CodexLimitReading | undefined {
  const entry = asRecord(line);
  const payload = asRecord(entry?.payload);
  const rateLimits = asRecord(payload?.rate_limits);
  if (entry?.type !== 'event_msg' || payload?.type !== 'token_count' || !rateLimits) return undefined;
  const observedAt = timestampOf(entry) ?? fallbackTs;
  const limits = [codexWindow(rateLimits.primary, 'five_hour', observedAt), codexWindow(rateLimits.secondary, 'weekly', observedAt)]
    .filter((limit): limit is PlanLimit => limit !== undefined);
  if (limits.length === 0) return undefined;
  const planType = typeof rateLimits.plan_type === 'string' ? rateLimits.plan_type : undefined;
  return { limits, ...(planType ? { planType } : {}), observedAt };
}

type ClaudeStatus = NonNullable<PlanLimit['status']>;
const STATUSES: readonly ClaudeStatus[] = ['allowed', 'allowed_warning', 'rejected'];

function claudeLimit(info: Json, observedAt: number, source: PlanLimit['source']): PlanLimit {
  const window = typeof info.rateLimitType === 'string' ? info.rateLimitType : 'unknown';
  const status = STATUSES.find((s) => s === info.status);
  const utilization = num(info.utilization);
  // The SDK documents no scale; the underlying headers are 0-1 fractions. Values above 1 are taken as percents.
  const usedPercent = utilization === undefined ? undefined : utilization <= 1 ? utilization * 100 : utilization;
  const resetsAt = epochMs(info.resetsAt);
  return {
    window,
    label: CLAUDE_LABELS[window] ?? window.replace(/_/g, ' '),
    ...(status ? { status } : {}),
    ...(usedPercent !== undefined ? { usedPercent: Math.round(usedPercent * 10) / 10 } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    observedAt,
    source,
  };
}

/** A Claude Code transcript line carrying `quotaLimits` (written when a plan limit is hit). */
export function claudeQuotaLimit(line: unknown, fallbackTs = Date.now()): PlanLimit | undefined {
  const entry = asRecord(line);
  const quota = asRecord(entry?.quotaLimits);
  if (!quota) return undefined;
  return claudeLimit(quota, timestampOf(entry) ?? fallbackTs, 'claude-transcript');
}

/** An Agent SDK `rate_limit_event` message. */
export function claudeRateLimitEvent(message: unknown, observedAt: number): PlanLimit | undefined {
  const entry = asRecord(message);
  const info = asRecord(entry?.rate_limit_info);
  if (entry?.type !== 'rate_limit_event' || !info) return undefined;
  return claudeLimit(info, observedAt, 'claude-sdk');
}

export interface ClaudePlanReading {
  readonly limits: readonly PlanLimit[];
  readonly planType?: string;
}

/** Structured SDK /usage values are already percentages, unlike rate_limit_event fractions. */
export function claudeUsageLimits(response: unknown, observedAt: number): ClaudePlanReading | undefined {
  const data = asRecord(response);
  const windows = asRecord(data?.rate_limits);
  if (data?.rate_limits_available !== true || !windows) return undefined;
  const limits: PlanLimit[] = [];
  const add = (window: string, label: string, raw: unknown) => {
    const value = asRecord(raw);
    const utilization = num(value?.utilization);
    if (utilization === undefined) return;
    const reset = typeof value?.resets_at === 'string' ? Date.parse(value.resets_at) : NaN;
    limits.push({
      window, label, usedPercent: Math.max(0, Math.min(100, utilization)),
      ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
      observedAt, source: 'claude-sdk',
    });
  };
  for (const window of ['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet']) {
    add(window, CLAUDE_LABELS[window] ?? window, windows[window]);
  }
  if (Array.isArray(windows.model_scoped)) {
    for (const raw of windows.model_scoped) {
      const value = asRecord(raw);
      if (typeof value?.display_name === 'string') add(`model:${value.display_name}`, `Weekly · ${value.display_name}`, value);
    }
  }
  if (limits.length === 0) return undefined;
  return { limits: sortLimits(limits), ...(typeof data.subscription_type === 'string' ? { planType: data.subscription_type } : {}) };
}

/** Newest reading per window wins. */
export function latestPerWindow(limits: readonly PlanLimit[]): PlanLimit[] {
  const byWindow = new Map<string, PlanLimit>();
  for (const limit of limits) {
    const current = byWindow.get(limit.window);
    if (!current || limit.observedAt >= current.observedAt) byWindow.set(limit.window, limit);
  }
  return sortLimits([...byWindow.values()]);
}

/** In-memory latest Claude plan limits reported by managed agents through the Agent SDK. */
export class ClaudeLimitRecorder {
  private limits: readonly PlanLimit[] = [];

  record(message: unknown, now = Date.now()): void {
    const limit = claudeRateLimitEvent(message, now);
    if (limit) this.limits = latestPerWindow([...this.limits, limit]);
  }

  list(): readonly PlanLimit[] {
    return this.limits;
  }
}

/** Shared by every managed Claude runner in this daemon. */
export const claudeSdkLimits = new ClaudeLimitRecorder();
