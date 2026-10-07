import { describe, expect, it, vi } from 'vitest';
import type { Agent, AgentEvent } from '../daemon/domain/types.ts';
import type { NotifySender, ScheduleNotify } from '../daemon/library/types.ts';
import {
  buildMessage, finalMessage, formatDuration, judgeRun, MAX_SUMMARY_CHARS, ScheduleRunWatcher, shouldNotify,
} from '../daemon/ops/scheduleRuns.ts';
import { DEFAULT_OPTIONS, newSchedule, type Schedule } from '../daemon/ops/schedules.ts';
import { makeAgent } from './helpers.ts';

const MIN = 60_000;
const ID = 'managed:run-1';

function harness(options: { notify?: ScheduleNotify; stopWhenDone?: boolean; maxMinutes?: number } = {}) {
  let now = 1_000_000;
  let agent: Agent | undefined;
  let events: AgentEvent[] = [];
  let listener: (() => void) | undefined;
  const base = newSchedule({ label: 'Nightly', enabled: true, days: [1], time: '09:00' }, { vendor: 'claude', cwd: 'C:\\w', prompt: 'p' }, 0, {
    ...DEFAULT_OPTIONS, notify: options.notify, stopWhenDone: options.stopWhenDone ?? true, maxMinutes: options.maxMinutes ?? 60,
  });
  let schedule: Schedule = { ...base, lastRunAgentId: ID, runs: [{ agentId: ID, startedAt: now }] };
  const notifier: NotifySender = { send: vi.fn(async (ids: readonly string[]) => ids.map((channelId) => ({ channelId, ok: channelId !== 'broken' }))) };
  const stopAgent = vi.fn(async () => undefined);
  const watcher = new ScheduleRunWatcher({
    agent: () => agent,
    events: () => events,
    onAgentsChanged: (fn) => { listener = fn; return () => { listener = undefined; }; },
    loadSchedule: (id) => (id === schedule.id ? schedule : undefined),
    saveSchedule: (next) => { schedule = next; },
    stopAgent,
    notifier,
    now: () => now,
  });
  return {
    watcher, notifier, stopAgent,
    get schedule() { return schedule; },
    get listener() { return listener; },
    setAgent: (patch: Partial<Agent> | undefined) => { agent = patch && makeAgent({ id: ID, tier: 'A', ...patch }); },
    setEvents: (next: AgentEvent[]) => { events = next; },
    advance: (ms: number) => { now += ms; },
    track: () => watcher.track(schedule.id, ID, now),
  };
}

const said = (summary: string, kind: AgentEvent['kind'] = 'assistant'): AgentEvent => ({ agentId: ID, ts: 1, kind, summary });

describe('run judging helpers', () => {
  const run = { scheduleId: 's', agentId: ID, startedAt: 0, seen: true };

  it('treats waiting and busy as still running, idle or stopped as done', () => {
    expect(judgeRun(makeAgent({ status: 'waiting' }), run, 60, MIN)).toBeUndefined();
    expect(judgeRun(makeAgent({ status: 'busy' }), run, 60, MIN)).toBeUndefined();
    expect(judgeRun(makeAgent({ status: 'idle' }), run, 60, MIN)).toEqual({ outcome: 'finished' });
    expect(judgeRun(makeAgent({ status: 'stopped' }), run, 60, MIN)).toEqual({ outcome: 'finished' });
    expect(judgeRun(makeAgent({ status: 'idle', lastError: 'boom' }), run, 60, MIN)).toEqual({ outcome: 'failed', reason: 'boom' });
    expect(judgeRun(makeAgent({ status: 'busy' }), run, 1, MIN)?.outcome).toBe('timed_out');
  });

  it('waits a grace period for an agent that has not appeared yet', () => {
    const unseen = { ...run, seen: false };
    expect(judgeRun(undefined, unseen, 60, 1000)).toBeUndefined();
    expect(judgeRun(undefined, unseen, 60, 2 * MIN)?.reason).toMatch(/never started/);
    expect(judgeRun(undefined, run, 60, 1000)?.reason).toMatch(/exited/);
  });

  it('formats durations, picks the final message, and builds clipped messages', () => {
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(4 * MIN + 10_000)).toBe('4m');
    expect(formatDuration(125 * MIN)).toBe('2h 5m');
    expect(finalMessage([said('first'), said('oops', 'error'), said('last')])).toBe('last');
    expect(finalMessage([said('oops', 'error')])).toBe('oops');
    expect(finalMessage([])).toBeUndefined();
    const message = buildMessage('Nightly', ID, { outcome: 'finished' }, 'x'.repeat(5000), 4 * MIN);
    expect(message).toMatchObject({ title: 'Nightly: finished', level: 'success', source: 'schedule:Nightly', agentId: ID });
    expect(message.body.length).toBeLessThan(MAX_SUMMARY_CHARS + 30);
    expect(message.body).toMatch(/Duration: 4m$/);
    expect(buildMessage('N', ID, { outcome: 'failed', reason: 'crash' }, undefined, 1000).body).toContain('Problem: crash');
    expect(buildMessage('N', ID, { outcome: 'finished' }, undefined, 1000).body).toContain('without a final message');
  });

  it('applies the notify "when" rule', () => {
    expect(shouldNotify(undefined, 'failed')).toBe(false);
    expect(shouldNotify({ channelIds: [], when: 'never' }, 'failed')).toBe(false);
    expect(shouldNotify({ channelIds: [], when: 'always' }, 'finished')).toBe(true);
    expect(shouldNotify({ channelIds: [], when: 'failure' }, 'finished')).toBe(false);
    expect(shouldNotify({ channelIds: [], when: 'failure' }, 'timed_out')).toBe(true);
  });
});

describe('ScheduleRunWatcher', () => {
  it('reports a finished run, notifies, stops the agent and records the result', async () => {
    const h = harness({ notify: { channelIds: ['slack1', 'broken'], when: 'always' } });
    h.track();
    h.setAgent({ status: 'busy' });
    await h.watcher.check();
    expect(h.notifier.send).not.toHaveBeenCalled();
    h.advance(4 * MIN);
    h.setAgent({ status: 'idle' });
    h.setEvents([said('Pulled 3 commits; nothing broke.')]);
    await h.watcher.check();
    await h.watcher.check();
    expect(h.notifier.send).toHaveBeenCalledTimes(1);
    expect(h.notifier.send).toHaveBeenCalledWith(['slack1', 'broken'], expect.objectContaining({
      title: 'Nightly: finished', level: 'success', body: expect.stringContaining('Pulled 3 commits'),
    }));
    expect(h.stopAgent).toHaveBeenCalledWith(ID);
    expect(h.schedule.lastResult).toBe('Finished in 4m · notified inbox + 1 channel (1 failed)');
    expect(h.schedule.runs?.[0]).toMatchObject({ agentId: ID, outcome: 'finished', endedAt: expect.any(Number), notified: ['inbox', 'slack1'] });
    expect(h.watcher.activeRuns()).toEqual([]);
  });

  it('only notifies on failure when asked to, and keeps the agent when stopWhenDone is off', async () => {
    const h = harness({ notify: { channelIds: [], when: 'failure' }, stopWhenDone: false });
    h.track();
    h.setAgent({ status: 'idle' });
    await h.watcher.check();
    expect(h.notifier.send).not.toHaveBeenCalled();
    expect(h.stopAgent).not.toHaveBeenCalled();
    expect(h.schedule.lastResult).toMatch(/^Finished in/);

    h.track();
    h.setAgent({ status: 'idle', lastError: 'Turn ended: error during execution' });
    await h.watcher.check();
    expect(h.notifier.send).toHaveBeenCalledWith([], expect.objectContaining({ title: 'Nightly: failed', level: 'error' }));
    expect(h.schedule.lastResult).toMatch(/^Failed after .*Turn ended: error during execution · notified inbox$/);
  });

  it('times out a long run, stopping the agent even when stopWhenDone is off', async () => {
    const h = harness({ notify: { channelIds: ['slack1'], when: 'never' }, stopWhenDone: false, maxMinutes: 5 });
    h.track();
    h.setAgent({ status: 'waiting' });
    h.advance(5 * MIN);
    await h.watcher.check();
    expect(h.stopAgent).toHaveBeenCalledWith(ID);
    expect(h.notifier.send).not.toHaveBeenCalled();
    expect(h.schedule.lastResult).toBe('Timed out after 5m');
    expect(h.schedule.runs?.[0].outcome).toBe('timed_out');
  });

  it('records a result without notifying when no notify is configured, and tolerates stop errors', async () => {
    const h = harness();
    h.stopAgent.mockRejectedValueOnce(new Error('already gone'));
    h.track();
    h.setAgent({ status: 'stopped' });
    await h.watcher.check();
    expect(h.notifier.send).not.toHaveBeenCalled();
    expect(h.stopAgent).not.toHaveBeenCalled(); // already stopped
    h.track();
    h.setAgent({ status: 'busy' });
    await h.watcher.check();
    h.setAgent(undefined);
    await h.watcher.check();
    expect(h.schedule.runs?.[0].summary).toMatch(/exited before reporting/);
  });

  it('resumes open runs on start, checks on agent changes, and forgets deleted schedules', async () => {
    const h = harness();
    h.watcher.start([h.schedule]);
    expect(h.watcher.activeRuns()).toHaveLength(1);
    h.setAgent({ status: 'idle' });
    h.listener?.();
    await h.watcher.check();
    expect(h.schedule.lastResult).toMatch(/^Finished/);
    h.watcher.track('sch_gone0000', 'managed:x');
    await h.watcher.check();
    expect(h.watcher.activeRuns()).toEqual([]);
    h.watcher.stop();
    expect(h.listener).toBeUndefined();
  });
});
