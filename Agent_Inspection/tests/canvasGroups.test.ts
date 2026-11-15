import { describe, expect, it } from 'vitest';
import {
  GROUPS_KEY, GROUP_HEAD, GROUP_PAD, MAX_GROUPS, addGroup, arrangeGroup, groupFrame, groupOf, loadGroups, moveGroup, pruneGroups,
  removeGroup, renameGroup, saveGroups, type CanvasGroup,
} from '../web/src/components/consoles/canvasGroups.ts';
import type { Rect } from '../web/src/components/consoles/canvasLayout.ts';

const rect = (x: number, y: number, width = 400, height = 300): Rect => ({ x, y, width, height });
const group = (id: string, members: string[], extra: Partial<CanvasGroup> = {}): CanvasGroup => ({ id, name: `Team ${id}`, members, arranged: true, ...extra });

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } } as unknown as Storage;
}

describe('groupFrame', () => {
  it('wraps every member with padding and room for the header', () => {
    const frame = groupFrame(group('g', ['a', 'b']), { a: rect(100, 100), b: rect(600, 200) });
    expect(frame).toEqual({ x: 100 - GROUP_PAD, y: 100 - GROUP_PAD - GROUP_HEAD, width: 900 + GROUP_PAD * 2, height: 400 + GROUP_PAD * 2 + GROUP_HEAD });
  });
  it('has no frame while no member has been placed', () => {
    expect(groupFrame(group('g', ['a']), {})).toBeUndefined();
  });
});

describe('moveGroup', () => {
  it('moves every member by the same amount and leaves other tiles alone', () => {
    const rects = { a: rect(0, 0), b: rect(500, 0), c: rect(0, 900) };
    const moved = moveGroup(rects, group('g', ['a', 'b']), 40, -20);
    expect(moved.a).toMatchObject({ x: 40, y: -20 });
    expect(moved.b).toMatchObject({ x: 540, y: -20 });
    expect(moved.c).toBe(rects.c);
  });
});

describe('arrangeGroup', () => {
  it('lays the members out in a grid at the origin, three to a row at most', () => {
    const laid = arrangeGroup({}, group('g', ['a', 'b', 'c', 'd', 'e']), { x: 1000, y: 50 });
    expect(laid.a).toMatchObject({ x: 1000, y: 50 });
    expect(laid.b!.y).toBe(50);
    expect(laid.c!.y).toBe(50);
    expect(laid.d!.x).toBe(1000);
    expect(laid.d!.y).toBeGreaterThan(laid.a!.y + laid.a!.height);
  });
  it('uses two columns for four or fewer members', () => {
    const laid = arrangeGroup({}, group('g', ['a', 'b', 'c']), { x: 0, y: 0 });
    expect(laid.c!.x).toBe(0);
    expect(laid.c!.y).toBeGreaterThan(0);
  });
});

describe('group list changes', () => {
  it('a tile belongs to at most one group: adding a group takes its members out of the others', () => {
    const next = addGroup([group('one', ['a', 'b'])], group('two', ['b', 'c']));
    expect(next.map((g) => [g.id, g.members])).toEqual([['one', ['a']], ['two', ['b', 'c']]]);
    expect(groupOf(next, 'b')?.id).toBe('two');
  });
  it('drops closed consoles, and groups left empty', () => {
    const next = pruneGroups([group('one', ['a', 'b']), group('two', ['c'])], ['a']);
    expect(next).toEqual([group('one', ['a'])]);
  });
  it('returns the same list when nothing changed, so React does not re-render', () => {
    const groups = [group('one', ['a'])];
    expect(pruneGroups(groups, ['a'])).toBe(groups);
  });
  it('removes and renames without touching the others', () => {
    const groups = [group('one', ['a']), group('two', ['b'])];
    expect(removeGroup(groups, 'one').map((g) => g.id)).toEqual(['two']);
    expect(renameGroup(groups, 'two', '  Reviewers ')[1]!.name).toBe('Reviewers');
    expect(renameGroup(groups, 'two', '   ')).toBe(groups);
  });
});

describe('loadGroups / saveGroups', () => {
  it('round-trips through storage', () => {
    const storage = fakeStorage();
    saveGroups([group('one', ['a', 'b'], { arranged: false })], storage);
    expect(loadGroups(storage)).toEqual([group('one', ['a', 'b'], { arranged: false })]);
  });
  it('drops anything malformed and caps the count', () => {
    const junk = [{ id: 1 }, { id: 'x', name: '', members: ['a'] }, { id: 'y', name: 'Y', members: 'a' }, null,
      ...Array.from({ length: MAX_GROUPS + 5 }, (_, i) => ({ id: `g${i}`, name: `G${i}`, members: [`m${i}`, 7] }))];
    const loaded = loadGroups(fakeStorage({ [GROUPS_KEY]: JSON.stringify(junk) }));
    expect(loaded).toHaveLength(MAX_GROUPS);
    expect(loaded[0]).toEqual({ id: 'g0', name: 'G0', members: ['m0'], arranged: true });
  });
  it('never throws on broken JSON or blocked storage', () => {
    expect(loadGroups(fakeStorage({ [GROUPS_KEY]: '{oops' }))).toEqual([]);
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    expect(loadGroups(blocked)).toEqual([]);
    expect(saveGroups([], blocked)).toBe(false);
  });
});
