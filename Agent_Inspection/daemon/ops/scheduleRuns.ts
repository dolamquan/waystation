import type { Agent, AgentEvent } from '../domain/types.ts';
import { INBOX_CHANNEL_ID, type NotifyLevel, type NotifyMessage, type NotifyResult, type NotifySender, type ScheduleNotify } from '../library/types.ts';
import { notifies } from './scheduleResources.ts';
import { withRun, type Schedule, type ScheduleRun, type ScheduleRunOutcome } from './schedules.ts';

export const MAX_SUMMARY_CHARS = 3000;
/** How long a freshly launched agent may take to show up in the registry before the run counts as failed. */
export const APPEAR_GRACE_MS = 60_000;
const TICK_MS = 15_000;

export interface RunWatcherDeps {
  readonly agent: (agentId: string) => Agent | undefined;
  /** Recent events of an agent, oldest first. */
  readonly events: (agentId: string) => readonly AgentEvent[];
  /** Calls back whenever agents change; returns an unsubscribe function. */
  readonly onAgentsChanged?: (listener: () => void) => () => void;
  readonly loadSchedule: (id: string) => Schedule | undefined;
  readonly saveSchedule: (schedule: Schedule) => void;
  readonly stopAgent: (agentId: string) => Promise<void>;
  readonly notifier?: NotifySender;
  readonly now?: () => number;
}

interface ActiveRun {
  readonly scheduleId: string;
  readonly agentId: string;
  readonly startedAt: number;
  readonly seen: boolean;
}

export interface RunVerdict {
  readonly outcome: ScheduleRunOutcome;
  /** Why it failed, when it did. */
  readonly reason?: string;
}

/** Decides whether a run is over. Waiting for an approval is not the end of a run. */
export function judgeRun(agent: Agent | undefined, run: ActiveRun, maxMinutes: number, now: number): RunVerdict | undefined {
  if (now - run.startedAt >= maxMinutes * 60_000) return { outcome: 'timed_out', reason: `Still running after ${maxMinutes} min` };
  if (!agent) {
    if (run.seen) return { outcome: 'failed', reason: 'The agent exited before reporting back.' };
    return now - run.startedAt >= APPEAR_GRACE_MS ? { outcome: 'failed', reason: 'The agent never started.' } : undefined;
  }
  if (agent.lastError) return { outcome: 'failed', reason: agent.lastError };
  if (agent.status === 'idle' || agent.status === 'stopped') return { outcome: 'finished' };
  return undefined;
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The agent's last word: its final assistant message, else the latest error. */
export function finalMessage(events: readonly AgentEvent[]): string | undefined {
  const last = (kind: AgentEvent['kind']) => [...events].reverse().find((event) => event.kind === kind)?.summary;
  return last('assistant') ?? last('error');
}

const TITLES: Record<ScheduleRunOutcome, string> = { finished: 'finished', failed: 'failed', timed_out: 'timed out' };

export function buildMessage(label: string, agentId: string, verdict: RunVerdict, lastWord: string | undefined, durationMs: number): NotifyMessage {
  const lines = [
    lastWord ?? (verdict.outcome === 'finished' ? 'The agent finished without a final message.' : ''),
    verdict.reason && verdict.reason !== lastWord ? `Problem: ${verdict.reason}` : '',
  ].filter(Boolean);
  const body = `${clip(lines.join('\n\n'), MAX_SUMMARY_CHARS)}\n\nDuration: ${formatDuration(durationMs)}`;
  const level: NotifyLevel = verdict.outcome === 'finished' ? 'success' : 'error';
  return { title: `${label}: ${TITLES[verdict.outcome]}`, body: body.trim(), level, source: `schedule:${label}`, agentId };
}

export function shouldNotify(notify: ScheduleNotify | undefined, outcome: ScheduleRunOutcome): notify is ScheduleNotify {
  if (!notifies(notify)) return false;
  return notify.when === 'always' || outcome !== 'finished';
}

function resultLine(verdict: RunVerdict, durationMs: number, deliveries: readonly NotifyResult[] | undefined): string {
  const head = {
    finished: `Finished in ${formatDuration(durationMs)}`,
    failed: `Failed after ${formatDuration(durationMs)}${verdict.reason ? `: ${clip(verdict.reason, 120)}` : ''}`,
    timed_out: `Timed out after ${formatDuration(durationMs)}`,
  }[verdict.outcome];
  if (!deliveries) return head;
  const external = deliveries.filter((delivery) => delivery.channelId !== INBOX_CHANNEL_ID);
  const sent = external.filter((delivery) => delivery.ok).length;
  const failed = external.length - sent;
  const note = external.length === 0 ? 'notified inbox' : `notified inbox + ${sent} channel${sent === 1 ? '' : 's'}`;
  return `${head} · ${note}${failed ? ` (${failed} failed)` : ''}`;
}

/**
 * Follows each scheduled launch until its first turn ends, the agent stops or fails, or the run
 * runs out of time, then reports the outcome and (optionally) stops the agent.
 */
export class ScheduleRunWatcher {
  private active = new Map<string, ActiveRun>();
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private checking: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RunWatcherDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Resumes runs left open (the tower restarted mid-run) and starts watching. */
  start(schedules: readonly Schedule[]): void {
    for (const schedule of schedules) {
      for (const run of schedule.runs ?? []) {
        if (run.endedAt === undefined) this.track(schedule.id, run.agentId, run.startedAt, true);
      }
    }
    this.unsubscribe = this.deps.onAgentsChanged?.(() => void this.check());
    this.timer = setInterval(() => void this.check(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  track(scheduleId: string, agentId: string, startedAt = this.now(), seen = false): void {
    this.active = new Map([...this.active, [agentId, { scheduleId, agentId, startedAt, seen }]]);
  }

  activeRuns(): readonly { scheduleId: string; agentId: string; startedAt: number }[] {
    return [...this.active.values()];
  }

  /** Checks every active run once. Calls are serialized so an outcome is never reported twice. */
  check(): Promise<void> {
    this.checking = this.checking.then(() => this.checkAll())
      .catch((error: unknown) => console.error('[schedules] checking runs failed:', (error as Error).message));
    return this.checking;
  }

  private async checkAll(): Promise<void> {
    const now = this.now();
    for (const run of [...this.active.values()]) {
      const schedule = this.deps.loadSchedule(run.scheduleId);
      if (!schedule) {
        this.forget(run.agentId);
        continue;
      }
      const agent = this.deps.agent(run.agentId);
      const current = agent && !run.seen ? { ...run, seen: true } : run;
      if (current !== run) this.active = new Map([...this.active, [run.agentId, current]]);
      const verdict = judgeRun(agent, current, schedule.maxMinutes, now);
      if (verdict) await this.complete(schedule, current, agent, verdict, now);
    }
  }

  private forget(agentId: string): void {
    this.active = new Map([...this.active].filter(([id]) => id !== agentId));
  }

  private async complete(schedule: Schedule, run: ActiveRun, agent: Agent | undefined, verdict: RunVerdict, now: number): Promise<void> {
    this.forget(run.agentId);
    const duration = now - run.startedAt;
    const lastWord = finalMessage(this.deps.events(run.agentId));
    const message = buildMessage(schedule.label, run.agentId, verdict, lastWord, duration);
    const deliveries = shouldNotify(schedule.notify, verdict.outcome) && this.deps.notifier
      ? await this.deps.notifier.send(schedule.notify.channelIds, message)
      : undefined;
    if (agent && agent.status !== 'stopped' && (schedule.stopWhenDone || verdict.outcome === 'timed_out')) {
      await this.deps.stopAgent(run.agentId)
        .catch((error: unknown) => console.error('[schedules] stopping a finished run failed:', (error as Error).message));
    }
    // Re-read: the operator may have edited the schedule while the run was going.
    const latest = this.deps.loadSchedule(schedule.id) ?? schedule;
    const previous = latest.runs?.find((candidate) => candidate.agentId === run.agentId);
    const record: ScheduleRun = {
      ...previous,
      agentId: run.agentId,
      startedAt: run.startedAt,
      endedAt: now,
      outcome: verdict.outcome,
      summary: message.body,
      ...(deliveries ? { notified: [...new Set([INBOX_CHANNEL_ID, ...deliveries.filter((d) => d.ok).map((d) => d.channelId)])] } : {}),
    };
    const lastResult = resultLine(verdict, duration, deliveries);
    const isLatestRun = latest.lastRunAgentId === undefined || latest.lastRunAgentId === run.agentId;
    this.deps.saveSchedule({ ...withRun(latest, record), ...(isLatestRun ? { lastResult } : {}) });
  }
}
