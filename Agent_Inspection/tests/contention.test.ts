import { describe, expect, it } from 'vitest';
import { ContentionTracker, fileKey } from '../daemon/guard/contention.ts';
import type { Agent, AgentEvent } from '../daemon/domain/types.ts';
import { makeAgent } from './helpers.ts';

const MIN = 60_000;
const agentA = makeAgent({ id: 'a', name: 'Pip', cwd: 'C:\\work\\web', status: 'busy' });
const agentB = makeAgent({ id: 'b', name: 'Mica', cwd: 'C:\\work\\web', status: 'busy' });
const edit = (agentId: string, summary: string, ts: number): AgentEvent => ({ agentId, ts, kind: 'tool_call', summary });

function tracker(agents: Agent[]) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return new ContentionTracker((id) => byId.get(id), 10 * MIN);
}

describe('fileKey', () => {
  it('resolves relative paths against the folder and folds case for Windows drives', () => {
    expect(fileKey('src/App.tsx', 'C:\\Work\\Web')).toBe('c:/work/web/src/app.tsx');
    expect(fileKey('C:\\Work\\Web\\src\\..\\src\\App.tsx', undefined)).toBe('c:/work/web/src/app.tsx');
    expect(fileKey('src/a.ts', undefined)).toBeUndefined();
  });
});

describe('ContentionTracker', () => {
  it('flags a file two agents edited in the same checkout within the window', () => {
    const t = tracker([agentA, agentB]);
    expect(t.observe(edit('a', 'Edit: C:\\work\\web\\src\\App.tsx', 1000))).toBe(false);
    expect(t.observe(edit('b', 'Write: src/App.tsx', 2000))).toBe(true);
    expect(t.list(3000)).toEqual([{
      path: 'C:\\work\\web\\src\\App.tsx',
      agents: [{ agentId: 'b', lastAt: 2000 }, { agentId: 'a', lastAt: 1000 }],
      since: 1000,
    }]);
  });

  it('reads files out of patches (Codex) and ignores reads, held calls and other tools', () => {
    const t = tracker([agentA, agentB]);
    t.observe(edit('a', 'apply_patch: *** Begin Patch *** Update File: src/api.ts @@', 1000));
    t.observe(edit('b', 'Read: C:\\work\\web\\src\\api.ts', 1500));
    t.observe(edit('b', '⏸ Edit: C:\\work\\web\\src\\api.ts', 1600));
    t.observe(edit('b', 'Bash: npm test', 1700));
    expect(t.list(2000)).toEqual([]);
    t.observe(edit('b', 'Edit: C:\\work\\web\\src\\api.ts', 1800));
    expect(t.list(2000)).toHaveLength(1);
  });

  it('does not flag separate worktrees, a parent and its own subagent, or one agent twice', () => {
    const tree = makeAgent({ id: 'c', cwd: 'C:\\work\\web--feature', status: 'busy' });
    const child = makeAgent({ id: 'd', cwd: 'C:\\work\\web', parentId: 'a', status: 'busy' });
    const t = tracker([agentA, tree, child]);
    t.observe(edit('a', 'Edit: src/x.ts', 1));
    t.observe(edit('a', 'Edit: src/x.ts', 2));
    t.observe(edit('c', 'Edit: src/x.ts', 3));
    t.observe(edit('d', 'Edit: src/x.ts', 4));
    expect(t.list(5)).toEqual([]);
  });

  it('expires after the window and drops stopped agents', () => {
    const stopped = { ...agentB, status: 'stopped' as const };
    const agents = new Map<string, Agent>([['a', agentA], ['b', agentB]]);
    const t = new ContentionTracker((id) => agents.get(id), 10 * MIN);
    t.observe(edit('a', 'Edit: src/x.ts', 0));
    t.observe(edit('b', 'Edit: src/x.ts', 1));
    expect(t.list(5 * MIN)).toHaveLength(1);
    expect(t.list(11 * MIN)).toEqual([]);
    t.observe(edit('a', 'Edit: src/x.ts', 12 * MIN));
    t.observe(edit('b', 'Edit: src/x.ts', 12 * MIN));
    agents.set('b', stopped);
    expect(t.list(12 * MIN)).toEqual([]);
  });

  it('reports a change only when the set of contested files or agents changes', () => {
    const t = tracker([agentA, agentB]);
    t.observe(edit('a', 'Edit: src/x.ts', 1));
    expect(t.observe(edit('b', 'Edit: src/x.ts', 2))).toBe(true);
    expect(t.observe(edit('b', 'Edit: src/x.ts', 3))).toBe(false);
    expect(t.refresh(11 * MIN)).toBe(true);
    expect(t.refresh(12 * MIN)).toBe(false);
  });
});
