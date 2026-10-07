import { randomUUID } from 'node:crypto';
import type { LaunchLoadout, ScheduleNotify, ScheduleResource } from '../library/types.ts';
import { OpsInputError, optionalText } from './templates.ts';

/** What a schedule launches: the same fields as New agent. */
export interface ScheduledLaunch {
  readonly vendor: 'claude' | 'codex';
  readonly cwd: string;
  readonly prompt: string;
  readonly name?: string;
  readonly model?: string;
  readonly appendSystemPrompt?: string;
  readonly intercept?: boolean;
  /** Skills, docs, MCP servers and plugins the agent launches with. */
  readonly loadout?: LaunchLoadout;
}

export type ScheduleRunOutcome = 'finished' | 'failed' | 'timed_out';

/** One launch of a schedule, from start to its outcome. */
export interface ScheduleRun {
  readonly agentId: string;
  readonly agentName?: string;
  readonly startedAt: number;
  /** Absent while the run is still going. */
  readonly endedAt?: number;
  readonly outcome?: ScheduleRunOutcome;
  /** The agent's final message (or what went wrong), clipped. */
  readonly summary?: string;
  /** Channels the run's update was delivered to (the inbox included). */
  readonly notified?: readonly string[];
}

/** Launches an agent at a local time on chosen weekdays (0 = Sunday). */
export interface Schedule {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly days: readonly number[];
  /** Local time, "HH:MM" (24-hour). */
  readonly time: string;
  readonly launch: ScheduledLaunch;
  /** What the agent must access for the task: repos, pages, files, folders, notes. */
  readonly resources: readonly ScheduleResource[];
  /** Where to send the run's outcome. Absent: only the schedule's last result records it. */
  readonly notify?: ScheduleNotify;
  /** Stop the agent once its first turn ends. */
  readonly stopWhenDone: boolean;
  /** A run still going after this long is stopped and reported as timed out. */
  readonly maxMinutes: number;
  readonly createdAt: number;
  readonly lastRunAt?: number;
  readonly lastRunAgentId?: string;
  /** "Launched <agent name>", "Finished in 4m · notified 2 channels", or why the run failed. */
  readonly lastResult?: string;
  /** Most recent runs, newest last. */
  readonly runs?: readonly ScheduleRun[];
}

export interface ScheduleOptions {
  readonly resources: readonly ScheduleResource[];
  readonly notify?: ScheduleNotify;
  readonly stopWhenDone: boolean;
  readonly maxMinutes: number;
}

/** A run missed by more than this (tower was off, PC asleep) is skipped rather than fired late. */
export const CATCH_UP_MS = 10 * 60_000;
export const DEFAULT_MAX_MINUTES = 60;
export const MAX_MAX_MINUTES = 600;
export const MAX_RUNS_KEPT = 10;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const DEFAULT_OPTIONS: ScheduleOptions = { resources: [], stopWhenDone: true, maxMinutes: DEFAULT_MAX_MINUTES };

export function validateScheduleFields(raw: unknown): Pick<Schedule, 'label' | 'enabled' | 'days' | 'time'> {
  const body = (raw ?? {}) as Record<string, unknown>;
  const label = optionalText(body.label, 'label', 60);
  if (!label) throw new OpsInputError('label is required');
  if (typeof body.time !== 'string' || !TIME_PATTERN.test(body.time)) throw new OpsInputError('time must be HH:MM (24-hour)');
  const days = Array.isArray(body.days) ? [...new Set(body.days)] : [];
  if (days.length === 0 || !days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) {
    throw new OpsInputError('days must list at least one weekday (0 = Sunday … 6 = Saturday)');
  }
  return { label, enabled: body.enabled !== false, days: (days as number[]).sort(), time: body.time };
}

export function validateMaxMinutes(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_MAX_MINUTES;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_MAX_MINUTES) {
    throw new OpsInputError(`maxMinutes must be a whole number from 1 to ${MAX_MAX_MINUTES}`);
  }
  return raw;
}

export function newSchedule(
  fields: ReturnType<typeof validateScheduleFields>,
  launch: ScheduledLaunch,
  now = Date.now(),
  options: ScheduleOptions = DEFAULT_OPTIONS,
): Schedule {
  return { id: `sch_${randomUUID().slice(0, 8)}`, ...fields, launch, ...options, createdAt: now };
}

/** Fills in fields that records saved before resources and notifications existed lack. */
export function normalizeSchedule(stored: Schedule): Schedule {
  const raw = stored as Partial<Schedule> & Schedule;
  return {
    ...raw,
    resources: Array.isArray(raw.resources) ? raw.resources : [],
    stopWhenDone: raw.stopWhenDone !== false,
    maxMinutes: typeof raw.maxMinutes === 'number' ? raw.maxMinutes : DEFAULT_MAX_MINUTES,
  };
}

/** The schedule's slot on a given day, in epoch ms. */
function slotOn(day: Date, time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes).getTime();
}

/**
 * The slot to run now, if any: today is a chosen weekday, the slot has passed by less than
 * CATCH_UP_MS, and nothing ran since it (a schedule created after the slot waits for the next one).
 */
export function dueSlot(schedule: Schedule, now = Date.now()): number | undefined {
  if (!schedule.enabled) return undefined;
  const since = schedule.lastRunAt ?? schedule.createdAt;
  // Yesterday too: a 23:58 slot checked just after midnight is still inside its catch-up window.
  for (const back of [0, 1]) {
    const day = new Date(now);
    day.setDate(day.getDate() - back);
    if (!schedule.days.includes(day.getDay())) continue;
    const slot = slotOn(day, schedule.time);
    if (slot <= now && now - slot < CATCH_UP_MS && since < slot) return slot;
  }
  return undefined;
}

/** Next time the schedule will fire, for display. */
export function nextRun(schedule: Schedule, now = Date.now()): number | undefined {
  if (!schedule.enabled) return undefined;
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(now);
    day.setDate(day.getDate() + offset);
    const slot = slotOn(day, schedule.time);
    if (schedule.days.includes(day.getDay()) && slot > now) return slot;
  }
  return undefined;
}

/** The schedule with `run` replacing the run of the same agent (or appended), keeping the latest few. */
export function withRun(schedule: Schedule, run: ScheduleRun): Schedule {
  const others = (schedule.runs ?? []).filter((candidate) => candidate.agentId !== run.agentId);
  return { ...schedule, runs: [...others, run].slice(-MAX_RUNS_KEPT) };
}
