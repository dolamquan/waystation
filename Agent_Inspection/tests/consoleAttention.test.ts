import { describe, expect, it } from 'vitest';
import { ConsoleAttention, attentionForHook, type AttentionConsoles } from '../daemon/pty/consoleAttention.ts';
import { PtyManager } from '../daemon/pty/ptyManager.ts';
import type { ConsoleInfo, PtyHandle, PtySpawn } from '../daemon/pty/types.ts';

describe('attentionForHook', () => {
  it.each([
    ['UserPromptSubmit', {}, 'working'],
    ['PreToolUse', {}, 'working'],
    ['PostToolUse', {}, 'working'],
    ['Notification', { notification_type: 'permission_prompt' }, 'needs-you'],
    ['Notification', { notification_type: 'idle_prompt' }, 'needs-you'],
    ['Notification', {}, 'needs-you'],
    ['Notification', { notification_type: 'auth_success' }, undefined],
    ['Stop', {}, 'ready'],
    ['SessionStart', {}, undefined],
    ['SessionEnd', {}, null],
    ['Whatever', {}, undefined],
  ])('maps %s %j to %s', (name, extra, expected) => {
    expect(attentionForHook({ hook_event_name: name, ...extra })).toBe(expected);
  });

  it('ignores input without an event name', () => {
    expect(attentionForHook({})).toBeUndefined();
  });
});

const info = (id: string, kind: ConsoleInfo['kind'], state: ConsoleInfo['state'] = 'running'): ConsoleInfo =>
  ({ id, name: id, kind, cwd: 'C:\\w', state, createdAt: 0, lastOutputAt: 0 });

function setup(options: { sessionPid?: number | undefined; parents?: Array<[number, number]>; failParents?: boolean } = {}) {
  const consoles = [info('c1', 'claude'), info('c2', 'claude'), info('sh', 'shell')];
  const pids: Record<string, number> = { c1: 100, c2: 200, sh: 300 };
  const calls: Array<[string, string | undefined]> = [];
  const fake: AttentionConsoles = {
    list: () => consoles,
    pidOf: (id) => pids[id],
    setAttention: (id, value) => { calls.push([id, value]); },
  };
  let lookups = 0;
  const attention = new ConsoleAttention({
    consoles: fake,
    sessionPid: async () => ('sessionPid' in options ? options.sessionPid : 102),
    parents: async () => {
      lookups += 1;
      if (options.failParents) throw new Error('no powershell');
      return new Map(options.parents ?? [[102, 101], [101, 100]]);
    },
    now: () => 0,
  });
  return { attention, calls, lookups: () => lookups };
}

describe('ConsoleAttention', () => {
  it('links a session to the console whose pty pid is an ancestor of the Claude process', async () => {
    const { attention, calls } = setup();
    await attention.handle({ hook_event_name: 'Notification', session_id: 's1' });
    expect(calls).toEqual([['c1', 'needs-you']]);
  });

  it('caches the link so later events do not rescan processes', async () => {
    const { attention, calls, lookups } = setup();
    await attention.handle({ hook_event_name: 'PreToolUse', session_id: 's1' });
    await attention.handle({ hook_event_name: 'Stop', session_id: 's1' });
    expect(calls).toEqual([['c1', 'working'], ['c1', 'ready']]);
    expect(lookups()).toBe(1);
  });

  it('clears the attention when the session ends', async () => {
    const { attention, calls } = setup();
    await attention.handle({ hook_event_name: 'SessionEnd', session_id: 's1' });
    expect(calls).toEqual([['c1', undefined]]);
  });

  it('does nothing for a session that runs outside any console', async () => {
    const { attention, calls } = setup({ parents: [[102, 101], [101, 7]] });
    await attention.handle({ hook_event_name: 'Stop', session_id: 's1' });
    expect(calls).toEqual([]);
  });

  it('does not link a Claude process that sits under a shell console', async () => {
    const { attention, calls } = setup({ parents: [[102, 300]] });
    await attention.handle({ hook_event_name: 'Stop', session_id: 's1' });
    expect(calls).toEqual([]);
  });

  it('degrades silently when the session pid or the process table is unavailable', async () => {
    const noPid = setup({ sessionPid: undefined });
    await noPid.attention.handle({ hook_event_name: 'Stop', session_id: 's1' });
    const broken = setup({ failParents: true });
    await broken.attention.handle({ hook_event_name: 'Stop', session_id: 's1' });
    expect([...noPid.calls, ...broken.calls]).toEqual([]);
  });

  it('survives a parent cycle', async () => {
    const { attention, calls } = setup({ parents: [[102, 103], [103, 102]] });
    await attention.handle({ hook_event_name: 'Stop', session_id: 's1' });
    expect(calls).toEqual([]);
  });

  it('ignores events without a session id or a mapped meaning', async () => {
    const { attention, calls, lookups } = setup();
    await attention.handle({ hook_event_name: 'Stop' });
    await attention.handle({ hook_event_name: 'SessionStart', session_id: 's1' });
    expect(calls).toEqual([]);
    expect(lookups()).toBe(0);
  });
});

class FakePty implements PtyHandle {
  readonly pid = 4242;
  onData() { /* unused */ }
  onExit() { /* unused */ }
  write() { /* unused */ }
  resize() { /* unused */ }
  kill() { /* unused */ }
}

describe('PtyManager.setAttention', () => {
  const spawn: PtySpawn = async () => new FakePty();

  it('updates the console immutably, emits changed once, and exposes the pty pid', async () => {
    const manager = new PtyManager(spawn);
    const created = await manager.create({ kind: 'claude', cwd: process.cwd() });
    const changes: ConsoleInfo[][] = [];
    manager.on('changed', (list: ConsoleInfo[]) => changes.push(list));
    manager.setAttention(created.id, 'needs-you');
    manager.setAttention(created.id, 'needs-you');
    expect(manager.get(created.id)?.attention).toBe('needs-you');
    expect(created.attention).toBeUndefined();
    expect(changes).toHaveLength(1);
    manager.setAttention(created.id, undefined);
    expect(manager.get(created.id)).not.toHaveProperty('attention');
    expect(manager.pidOf(created.id)).toBe(4242);
    expect(manager.pidOf('nope')).toBeUndefined();
  });

  it('ignores unknown ids and consoles that are not Claude Code', async () => {
    const manager = new PtyManager(spawn);
    const shell = await manager.create({ kind: 'shell', cwd: process.cwd() });
    manager.setAttention(shell.id, 'ready');
    manager.setAttention('missing', 'ready');
    expect(manager.get(shell.id)?.attention).toBeUndefined();
  });
});
