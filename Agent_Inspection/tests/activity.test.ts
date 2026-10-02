import { describe, expect, it } from 'vitest';
import { activityTitle, currentActivity, filterActivity, mergeActivity, sessionSource } from '../web/src/activity.ts';
import type { AgentEvent } from '../web/src/api.ts';
import { makeAgent } from './helpers.ts';

const event = (kind: AgentEvent['kind'], ts: number, summary: string): AgentEvent => ({ agentId: 'one', kind, ts, summary });

describe('readable session activity', () => {
  it('separates conversation from tools and routine turn events without discarding records', () => {
    const events = [event('prompt', 1, 'Review the UI'), event('status', 2, 'turn started'), event('tool_call', 3, 'exec: raw code'), event('assistant', 4, 'Updated the panel')];
    expect(filterActivity(events, 'messages').map(e => e.kind)).toEqual(['prompt', 'assistant']);
    expect(filterActivity(events, 'tools').map(e => e.kind)).toEqual(['tool_call']);
    expect(filterActivity(events, 'all')).toEqual(events);
  });

  it('preserves live events when history arrives late and removes overlapping records', () => {
    const live = event('assistant', 30, 'Done');
    const history = [event('prompt', 10, 'Begin'), event('tool_call', 20, 'Read: app.ts'), { ...live }];
    const merged = mergeActivity([live], history);
    expect(merged.map(e => e.ts)).toEqual([10, 20, 30]);
    expect(merged[2]).toBe(live);
    expect(merged[1].summary).toBe('Read: app.ts');
  });

  it('uses human labels while keeping recorded tool payloads intact', () => {
    const tool = event('tool_call', 1, 'exec: const code = true');
    expect(activityTitle(tool)).toBe('Run a tool');
    expect(tool.summary).toBe('exec: const code = true');
    expect(activityTitle(event('status', 2, 'turn complete'))).toBe('Finished this turn');
    expect(sessionSource(makeAgent({ tier: 'C', source: 'codex_vscode' }))).toBe('Editor session');
  });

  it('shows actual session state instead of treating stale tool output as current work', () => {
    const lastTool = event('tool_call', 1, 'exec: await tools.run()');
    expect(currentActivity(makeAgent({ status: 'idle' }), lastTool)).toBe('Ready for the next task.');
    expect(currentActivity(makeAgent({ status: 'stopped' }), lastTool)).toBe('This session has ended.');
    expect(currentActivity(makeAgent({ status: 'busy', currentActivity: 'exec: await tools.run()' }))).toBe('Working on the current task.');
  });
});
