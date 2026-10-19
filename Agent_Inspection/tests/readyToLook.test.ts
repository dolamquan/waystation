import { describe, expect, it } from 'vitest';
import { writesFiles } from '../shared/fileEdits.ts';
import { EMPTY_TURN_WATCH, unseenReady, watchAgents, watchEvent } from '../web/src/readyToLook.ts';
import type { Agent, AgentEvent } from '../daemon/domain/types.ts';
import { makeAgent } from './helpers.ts';

const ID = 'claude:a';
const agent = (status: Agent['status'], id = ID): Agent => makeAgent({ id, status });
const call = (summary: string, agentId = ID): AgentEvent => ({ agentId, ts: 1, kind: 'tool_call', summary });

describe('writesFiles', () => {
  it('recognises edits and patches, even with clipped paths', () => {
    expect(writesFiles('Edit: C:\\work\\demo\\a.ts')).toBe(true);
    expect(writesFiles('Write: C:\\very\\long\\pa…')).toBe(true);
    expect(writesFiles('apply_patch: *** Begin Patch *** Add File: index.html')).toBe(true);
  });

  it('ignores reads, commands and held calls', () => {
    expect(writesFiles('Read: a.ts')).toBe(false);
    expect(writesFiles('Bash: npm test')).toBe(false);
    expect(writesFiles('⏸ Edit: a.ts')).toBe(false);
  });
});

describe('ready to look', () => {
  it('marks an agent ready when a turn that changed files finishes', () => {
    let watch = watchAgents(EMPTY_TURN_WATCH, [], [agent('busy')], 1);
    watch = watchEvent(watch, call('Edit: a.ts'));
    watch = watchAgents(watch, [agent('busy')], [agent('idle')], 50);
    expect(watch.ready.get(ID)).toBe(50);
    expect(watch.edited.has(ID)).toBe(false);
  });

  it('stays quiet when the turn only read files or ran commands', () => {
    let watch = watchEvent(EMPTY_TURN_WATCH, call('Read: a.ts'));
    watch = watchEvent(watch, { agentId: ID, ts: 2, kind: 'assistant', summary: 'Edit: looks like an edit but is a message' });
    watch = watchAgents(watch, [agent('busy')], [agent('idle')], 50);
    expect(watch.ready.size).toBe(0);
  });

  it('waits through a held approval, and counts it once the turn really ends', () => {
    let watch = watchEvent(EMPTY_TURN_WATCH, call('Write: index.html'));
    watch = watchAgents(watch, [agent('busy')], [agent('waiting')], 10);
    expect(watch.ready.size).toBe(0);
    watch = watchAgents(watch, [agent('waiting')], [agent('idle')], 20);
    expect(watch.ready.get(ID)).toBe(20);
  });

  it('clears when the agent starts working again or goes away', () => {
    const ready = { edited: new Set<string>(), ready: new Map([[ID, 5], ['claude:b', 6]]) };
    const next = watchAgents(ready, [agent('idle'), agent('idle', 'claude:b')], [agent('busy')], 9);
    expect(next.ready.size).toBe(0);
  });

  it('hides results the operator has already opened', () => {
    const ready = new Map([[ID, 100], ['claude:b', 200], ['claude:c', 300]]);
    expect([...unseenReady(ready, { [ID]: 100, 'claude:b': 150 }, 'claude:c')]).toEqual(['claude:b']);
  });
});
