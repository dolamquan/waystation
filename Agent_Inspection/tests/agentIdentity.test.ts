import { describe, expect, it } from 'vitest';
import { uniqueAgents } from '../daemon/domain/agentIdentity.ts';
import { AgentRegistry } from '../daemon/domain/registry.ts';
import { makeAgent } from './helpers.ts';

const managed = makeAgent({ id: 'managed:designer', vendor: 'codex', tier: 'A', name: 'UI Designer', sessionId: 'designer-thread', canInstruct: true });
const observed = makeAgent({ id: 'codex:designer-thread', vendor: 'codex', tier: 'C', name: 'Codex · Agents', sessionId: 'designer-thread', canInstruct: false });

describe('managed session identity', () => {
  it('keeps the named managed agent and its controls regardless of discovery order', () => {
    expect(uniqueAgents([managed, observed])).toEqual([managed]);
    expect(uniqueAgents([observed, managed])).toEqual([managed]);
  });

  it('preserves genuine children and independent threads in the same folder', () => {
    const child = makeAgent({ id: 'codex:child', vendor: 'codex', tier: 'C', sessionId: 'child-thread', parentId: observed.id });
    const other = makeAgent({ id: 'codex:other', vendor: 'codex', tier: 'C', sessionId: 'other-thread' });
    const result = uniqueAgents([managed, observed, child, other]);
    expect(result.map(agent => agent.id)).toEqual([managed.id, child.id, other.id]);
    expect(result[1].parentId).toBe(managed.id);
    expect(child.parentId).toBe(observed.id);
  });

  it('does not match by folder, name, vendor-independent ids or missing session ids', () => {
    const others = [
      { ...observed, id: 'claude:designer-thread', vendor: 'claude' as const },
      { ...observed, id: 'unknown', sessionId: undefined },
      { ...observed, id: 'empty', sessionId: '' },
      { ...observed, id: 'different', sessionId: 'different-thread', name: 'UI Designer' },
    ];
    expect(uniqueAgents([managed, ...others])).toHaveLength(5);
  });

  it('keeps two explicitly managed agents visible, rather than hiding a real second launch', () => {
    const second = { ...managed, id: 'managed:second', name: 'Second launch' };
    expect(uniqueAgents([managed, second, observed])).toEqual([managed, second]);
  });

  it('handles scanner-before-runner discovery, follow-ups, overrides and ownership ending', () => {
    const registry = new AgentRegistry();
    registry.replaceSource('codex-sessions', [observed]);
    expect(registry.list()).toEqual([observed]);
    registry.upsert('managed', managed);
    registry.setOverride(managed.id, { name: 'Renamed designer', status: 'waiting' });
    expect(registry.list()).toHaveLength(1);
    expect(registry.findBySessionId('designer-thread')).toMatchObject({ id: managed.id, name: 'Renamed designer', status: 'waiting', canInstruct: true });
    registry.upsert('managed', { ...managed, status: 'busy', currentActivity: 'Second prompt' });
    registry.replaceSource('codex-sessions', [{ ...observed, currentActivity: 'Second prompt' }]);
    expect(registry.list()).toHaveLength(1);
    registry.drop('managed', managed.id);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].id).toBe(observed.id);
  });
});
