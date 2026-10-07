import { describe, expect, it } from 'vitest';
import type { TeamView } from '../daemon/teams/types.ts';
import {
  COLUMNS, MAX_ROWS, MIN_ROWS, SLOTS_PER_DECK, deckRows, layoutDecks, onFloor, sceneBox, slotPosition, teamAgentIds,
  teamSeats, teamTablePosition, vacantSlots,
} from '../web/src/stationLayout.ts';
import { makeAgent } from './helpers.ts';

const agent = (id: string) => makeAgent({ id, sessionId: id });

function team(id: string, memberCount: number, overrides: Partial<TeamView> = {}): TeamView {
  return {
    id,
    name: `Team ${id}`,
    goal: 'goal',
    repoRoot: 'C:\\repo',
    baseBranch: 'main',
    status: 'running',
    createdAt: 0,
    members: Array.from({ length: memberCount }, (_, i) => ({
      id: `m${i}`, name: `m${i}`, role: i === 1 ? 'lead' as const : 'worker' as const, vendor: 'claude' as const,
      agentId: i < 2 ? `${id}-agent-${i}` : undefined, worktree: '', branch: '', merged: false,
    })),
    tasks: [],
    budget: { maxWakes: 1, wakesUsed: 0, deadline: 0 },
    ...overrides,
  };
}

describe('station layout', () => {
  it('lays desks on an isometric grid, with a team table centred on its two slots', () => {
    const a = slotPosition(0);
    const b = slotPosition(1);
    expect(a).toEqual({ x: 220, y: 274 });
    expect(slotPosition(COLUMNS).y).toBeGreaterThan(a.y);
    expect(teamTablePosition(0)).toEqual({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  });

  it('gives a team two neighbouring slots and fills the rest with solo desks', () => {
    const [deck] = layoutDecks([team('a', 3)], [agent('s1'), agent('s2')], []);
    expect(deck.map((p) => [p.kind, p.slot])).toEqual([['team', 0], ['agent', 2], ['agent', 3]]);
    expect(vacantSlots(deck, MIN_ROWS)).toEqual(Array.from({ length: MIN_ROWS * COLUMNS - 4 }, (_, i) => i + 4));
  });

  it('grows the office with the crew, always keeping a spare row, up to the maximum', () => {
    expect(deckRows([])).toBe(MIN_ROWS);
    const teams = Array.from({ length: 6 }, (_, i) => team(`t${i}`, 2));
    const [deck] = layoutDecks(teams, [], []);
    expect(deckRows(deck)).toBe(4);
    const [full] = layoutDecks(Array.from({ length: SLOTS_PER_DECK / 2 }, (_, i) => team(`t${i}`, 2)), [], []);
    expect(deckRows(full)).toBe(MAX_ROWS);
    expect(sceneBox(4).height).toBeGreaterThan(sceneBox(MIN_ROWS).height);
  });

  it('spills onto a second deck only when the biggest office is full', () => {
    const teams = Array.from({ length: SLOTS_PER_DECK / 2 + 1 }, (_, i) => team(`t${i}`, 2));
    const decks = layoutDecks(teams, [agent('s1')], []);
    expect(decks).toHaveLength(2);
    expect(decks[1].map((p) => [p.kind, p.slot])).toEqual([['team', 0], ['agent', 2]]);
  });

  it('always returns one deck, even when empty', () => {
    expect(layoutDecks([], [], [])).toEqual([[]]);
  });

  it('seats the lead first, splits members behind and in front, and links live agents', () => {
    const t = team('a', 5);
    const live = agent('a-agent-1');
    const seats = teamSeats(t, [live]);
    expect(seats[0]).toMatchObject({ side: 'back', index: 0, ofSide: 3, agent: live });
    expect(seats[0].member.role).toBe('lead');
    expect(seats.map((s) => s.side)).toEqual(['back', 'back', 'back', 'front', 'front']);
    expect(seats[3]).toMatchObject({ index: 0, ofSide: 2, agent: undefined });
  });

  it('tracks which agents sit at a team table and hides disbanded teams', () => {
    expect([...teamAgentIds([team('a', 3)])]).toEqual(['a-agent-0', 'a-agent-1']);
    expect(onFloor(team('a', 2, { status: 'disbanded' }))).toBe(false);
    expect(onFloor(team('a', 2, { status: 'paused' }))).toBe(true);
  });
});
