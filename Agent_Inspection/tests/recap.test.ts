import { describe, expect, it } from 'vitest';
import { buildRecap, readLastVisit, RECAP_MIN_AWAY_MS, shouldShowRecap, writeLastVisit, type VisitStorage } from '../web/src/recap.ts';
import type { PendingInterception } from '../web/src/api.ts';
import { makeAgent } from './helpers.ts';

const LAST_VISIT = 1_000_000;
const NOW = LAST_VISIT + 60 * 60 * 1000;
const AFTER = LAST_VISIT + 5_000;
const BEFORE = LAST_VISIT - 5_000;

const pendingFor = (agentId: string, createdAt = AFTER): PendingInterception => ({
  id: `p-${agentId}`, agentId, sessionId: 's', toolName: 'Bash', input: {}, createdAt, origin: 'hook',
});

const memoryStorage = (initial: Record<string, string> = {}): VisitStorage & { data: Record<string, string> } => {
  const data = { ...initial };
  return { data, getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = value; } };
};

const brokenStorage: VisitStorage = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
};

describe('away recap grouping', () => {
  it('lists agents that went idle or stopped since the last visit as finished', () => {
    // Arrange
    const agents = [
      makeAgent({ id: 'a', name: 'Alpha', status: 'idle', lastEventAt: AFTER }),
      makeAgent({ id: 'b', name: 'Beta', status: 'stopped', lastEventAt: AFTER + 1 }),
      makeAgent({ id: 'c', name: 'Gamma', status: 'idle', lastEventAt: BEFORE }),
    ];

    // Act
    const recap = buildRecap(agents, [], LAST_VISIT, NOW);

    // Assert
    expect(recap.finished.map(e => e.id)).toEqual(['b', 'a']);
    expect(recap.activeCount).toBe(2);
  });

  it('puts agents with a waiting status or a pending approval under waiting on you', () => {
    // Arrange
    const agents = [
      makeAgent({ id: 'w', status: 'waiting', lastEventAt: AFTER }),
      makeAgent({ id: 'p', status: 'busy', lastEventAt: AFTER }),
      makeAgent({ id: 'q', status: 'busy', lastEventAt: AFTER }),
    ];

    // Act
    const recap = buildRecap(agents, [pendingFor('p'), pendingFor('p', AFTER + 1)], LAST_VISIT, NOW);

    // Assert
    expect(recap.waiting.map(e => e.id).sort()).toEqual(['p', 'w']);
    expect(recap.waiting.find(e => e.id === 'p')?.pendingCount).toBe(2);
    expect(recap.stillWorking).toBe(1);
  });

  it('flags new errors and tripped breakers as trouble but ignores breakers at ok', () => {
    // Arrange
    const agents = [
      makeAgent({ id: 'e', status: 'idle', lastEventAt: AFTER, lastError: 'Process exited with code 1' }),
      makeAgent({ id: 'k', status: 'busy', lastEventAt: AFTER, breaker: { level: 'warned', reason: 'Spending fast', since: AFTER } }),
      makeAgent({ id: 'o', status: 'idle', lastEventAt: AFTER, breaker: { level: 'ok', reason: '', since: AFTER } }),
    ];

    // Act
    const recap = buildRecap(agents, [], LAST_VISIT, NOW);

    // Assert
    expect(recap.trouble.map(e => e.id).sort()).toEqual(['e', 'k']);
    expect(recap.trouble.find(e => e.id === 'e')?.detail).toBe('Process exited with code 1');
    expect(recap.trouble.find(e => e.id === 'k')?.detail).toBe('Spending fast');
    expect(recap.finished.map(e => e.id)).toEqual(['o']);
  });

  it('places each agent in only one group, preferring waiting over trouble over finished', () => {
    // Arrange
    const agents = [makeAgent({ id: 'x', status: 'waiting', lastEventAt: AFTER, lastError: 'boom' })];

    // Act
    const recap = buildRecap(agents, [], LAST_VISIT, NOW);

    // Assert
    expect(recap.waiting.map(e => e.id)).toEqual(['x']);
    expect(recap.trouble).toEqual([]);
    expect(recap.finished).toEqual([]);
  });

  it('ignores old errors on agents that have been quiet since the last visit', () => {
    // Arrange
    const agents = [makeAgent({ id: 'old', status: 'idle', lastEventAt: BEFORE, lastError: 'stale failure' })];

    // Act
    const recap = buildRecap(agents, [], LAST_VISIT, NOW);

    // Assert
    expect(recap.trouble).toEqual([]);
    expect(recap.activeCount).toBe(0);
  });

  it('sums estimated cost only across agents active since the last visit', () => {
    // Arrange
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    const agents = [
      makeAgent({ id: 'a', status: 'idle', lastEventAt: AFTER, usage: { tokens, costUsd: 1.25 } }),
      makeAgent({ id: 'b', status: 'busy', lastEventAt: AFTER, usage: { tokens, costUsd: 0.5 } }),
      makeAgent({ id: 'c', status: 'busy', lastEventAt: AFTER, usage: { tokens } }),
      makeAgent({ id: 'd', status: 'idle', lastEventAt: BEFORE, usage: { tokens, costUsd: 9 } }),
    ];

    // Act
    const recap = buildRecap(agents, [], LAST_VISIT, NOW);

    // Assert
    expect(recap.spentUsd).toBeCloseTo(1.75);
    expect(recap.hasCost).toBe(true);
  });

  it('reports no cost when no active agent has a price estimate', () => {
    // Arrange
    const agents = [makeAgent({ id: 'a', status: 'idle', lastEventAt: AFTER })];

    // Act
    const recap = buildRecap(agents, [], LAST_VISIT, NOW);

    // Assert
    expect(recap.spentUsd).toBe(0);
    expect(recap.hasCost).toBe(false);
  });

  it('records how long the operator was away', () => {
    // Act
    const recap = buildRecap([], [], LAST_VISIT, NOW);

    // Assert
    expect(recap.awayMs).toBe(NOW - LAST_VISIT);
    expect(recap.activeCount).toBe(0);
  });
});

describe('when the away recap is shown', () => {
  const active = [makeAgent({ id: 'a', status: 'idle', lastEventAt: AFTER })];

  it('shows after ten or more minutes away when an agent has done something', () => {
    // Arrange
    const recap = buildRecap(active, [], LAST_VISIT, LAST_VISIT + RECAP_MIN_AWAY_MS);

    // Act / Assert
    expect(RECAP_MIN_AWAY_MS).toBe(10 * 60 * 1000);
    expect(shouldShowRecap(recap)).toBe(true);
  });

  it('stays hidden after a short absence', () => {
    // Arrange
    const recap = buildRecap(active, [], LAST_VISIT, LAST_VISIT + RECAP_MIN_AWAY_MS - 1);

    // Act / Assert
    expect(shouldShowRecap(recap)).toBe(false);
  });

  it('stays hidden when nothing happened while away', () => {
    // Arrange
    const quiet = [makeAgent({ id: 'q', status: 'idle', lastEventAt: BEFORE })];
    const recap = buildRecap(quiet, [], LAST_VISIT, NOW);

    // Act / Assert
    expect(shouldShowRecap(recap)).toBe(false);
  });
});

describe('last visit storage', () => {
  it('round-trips the last visit timestamp', () => {
    // Arrange
    const storage = memoryStorage();

    // Act
    writeLastVisit(12345, storage);

    // Assert
    expect(readLastVisit(storage)).toBe(12345);
  });

  it('returns undefined on a first-ever visit or for a corrupted value', () => {
    // Act / Assert
    expect(readLastVisit(memoryStorage())).toBeUndefined();
    expect(readLastVisit(memoryStorage({ 'waystation-last-visit': 'not a number' }))).toBeUndefined();
  });

  it('degrades quietly when storage is blocked', () => {
    // Act / Assert
    expect(readLastVisit(brokenStorage)).toBeUndefined();
    expect(() => writeLastVisit(1, brokenStorage)).not.toThrow();
    expect(readLastVisit(undefined)).toBeUndefined();
  });
});
