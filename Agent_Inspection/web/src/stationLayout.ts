import type { Agent, TeamMember, TeamView } from './api.ts';

/**
 * The station floor is a grid of desk slots: COLUMNS wide and as many rows as the crew needs (plus a
 * spare row, so it never looks packed). A solo agent's desk takes one slot; a team table takes two
 * neighbouring slots in a row (an even column and the next). Past MAX_ROWS, the rest goes to another deck.
 */
export const COLUMNS = 4;
export const MIN_ROWS = 3;
export const MAX_ROWS = 8;
const SPARE_ROWS = 1;
export const SLOTS_PER_DECK = COLUMNS * MAX_ROWS;
export const MAX_SEATS_PER_SIDE = 3;

/* Isometric axes of the floor grid, in scene units: one column to the right, one row toward the viewer. */
export const COL_AXIS = { x: 210, y: -26 } as const;
export const ROW_AXIS = { x: 100, y: 190 } as const;
const ORIGIN = { x: 220, y: 274 } as const;

export interface Point { readonly x: number; readonly y: number }

export interface Seat {
  readonly member: TeamMember;
  /** The member's live agent, once it has started. */
  readonly agent?: Agent;
  readonly side: 'back' | 'front';
  /** Position along its side, 0-based. */
  readonly index: number;
  /** How many seats share this side (for spacing). */
  readonly ofSide: number;
}

export type Placement =
  | { readonly kind: 'agent'; readonly slot: number; readonly agent: Agent }
  | { readonly kind: 'team'; readonly slot: number; readonly team: TeamView; readonly seats: readonly Seat[] };

/** A point on the floor grid; fractional coordinates are allowed (u = column, v = row). */
export function gridPoint(u: number, v: number): Point {
  return { x: ORIGIN.x + COL_AXIS.x * u + ROW_AXIS.x * v, y: ORIGIN.y + COL_AXIS.y * u + ROW_AXIS.y * v };
}

export const columnOf = (slot: number) => slot % COLUMNS;
export const rowOf = (slot: number) => Math.floor(slot / COLUMNS);

/** Screen position of a desk slot. */
export function slotPosition(slot: number): Point {
  return gridPoint(columnOf(slot), rowOf(slot));
}

/** A team table sits between its two slots. */
export function teamTablePosition(slot: number): Point {
  return gridPoint(columnOf(slot) + 0.5, rowOf(slot));
}

/** Teams that are still active on the floor (disbanded teams leave). */
export const onFloor = (team: TeamView) => team.status !== 'disbanded';

/** Agent ids that belong to a team, so they sit at the team table instead of a desk of their own. */
export function teamAgentIds(teams: readonly TeamView[]): Set<string> {
  return new Set(teams.flatMap((team) => team.members.flatMap((m) => (m.agentId ? [m.agentId] : []))));
}

/** Lead first, then workers; the first half sit behind the table, the rest in front. */
export function teamSeats(team: TeamView, agents: readonly Agent[]): Seat[] {
  const ordered = [...team.members].sort((a, b) => Number(b.role === 'lead') - Number(a.role === 'lead'));
  const backCount = Math.min(MAX_SEATS_PER_SIDE, Math.ceil(ordered.length / 2));
  const frontCount = Math.min(MAX_SEATS_PER_SIDE, ordered.length - backCount);
  return ordered.slice(0, backCount + frontCount).map((member, i) => {
    const back = i < backCount;
    return {
      member,
      agent: member.agentId ? agents.find((a) => a.id === member.agentId) : undefined,
      side: back ? 'back' : 'front',
      index: back ? i : i - backCount,
      ofSide: back ? backCount : frontCount,
    };
  });
}

/** Pack teams (into even-column slot pairs) and solo agents into decks. Always returns at least one deck. */
export function layoutDecks(teams: readonly TeamView[], solos: readonly Agent[], agents: readonly Agent[]): Placement[][] {
  const teamQueue = [...teams];
  const soloQueue = [...solos];
  const decks: Placement[][] = [];
  do {
    const deck: Placement[] = [];
    const used = new Set<number>();
    for (let slot = 0; slot < SLOTS_PER_DECK && teamQueue.length > 0; slot += 2) {
      deck.push({ kind: 'team', slot, team: teamQueue.shift()!, seats: [] });
      used.add(slot).add(slot + 1);
    }
    for (let slot = 0; slot < SLOTS_PER_DECK && soloQueue.length > 0; slot += 1) {
      if (!used.has(slot)) deck.push({ kind: 'agent', slot, agent: soloQueue.shift()! });
    }
    decks.push(deck.map((p) => (p.kind === 'team' ? { ...p, seats: teamSeats(p.team, agents) } : p)));
  } while (teamQueue.length > 0 || soloQueue.length > 0);
  return decks;
}

/** How many rows of floor a deck needs: everything placed, plus a spare row of free desks. */
export function deckRows(deck: readonly Placement[]): number {
  const lastRow = deck.reduce((max, p) => Math.max(max, rowOf(p.slot)), -1);
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, lastRow + 1 + SPARE_ROWS));
}

/** Slots on a deck's floor that hold nothing (drawn as vacant desks). */
export function vacantSlots(deck: readonly Placement[], rows: number): number[] {
  const taken = new Set(deck.flatMap((p) => (p.kind === 'team' ? [p.slot, p.slot + 1] : [p.slot])));
  return Array.from({ length: rows * COLUMNS }, (_, slot) => slot).filter((slot) => !taken.has(slot));
}

export interface SceneBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Floor corners for a given number of rows, with margins for furniture, decor and a front walkway. */
export function floorCorners(rows: number) {
  const u0 = -0.62;
  const u1 = COLUMNS - 1 + 0.72;
  const v0 = -0.42;
  const v1 = rows - 1 + 0.78;
  return {
    u0, u1, v0, v1,
    backLeft: gridPoint(u0, v0),
    backRight: gridPoint(u1, v0),
    frontRight: gridPoint(u1, v1),
    frontLeft: gridPoint(u0, v1),
  };
}

/** The visible scene: the floor plus sky above and room for the antenna, stairs and caption. */
export function sceneBox(rows: number): SceneBox {
  const { backLeft, backRight, frontRight, frontLeft } = floorCorners(rows);
  const x = Math.min(backLeft.x, frontLeft.x) - 125;
  const y = backRight.y - 185;
  const right = Math.max(backRight.x, frontRight.x) + 80;
  const bottom = Math.max(frontLeft.y, frontRight.y) + 130;
  return { x, y, width: right - x, height: bottom - y };
}
