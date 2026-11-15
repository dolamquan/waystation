import { describe, expect, it } from 'vitest';
import {
  CANVAS_STORAGE_KEY, DEFAULT_VIEWPORT, MAX_ENTRIES, MAX_RECTS, MAX_ZOOM, MIN_HEIGHT, MIN_WIDTH, MIN_ZOOM, READABLE_ZOOM, TILE_GAP, TILE_HEIGHT, TILE_WIDTH,
  WORLD_HALF, WORLD_SIZE,
  bringToFront, clampRect, clampZoom, emptyCanvas, fitAll, freePlacement, gridPlacement, loadCanvas, markUpgraded, moveRect, needsUpgrade, panViewport,
  readableViewport, reconcile, resizeRect, saveCanvas, screenToWorld, setViewport, tidyColumns, tidyGrid, viewportFor, worldToScreen, zoomAbout,
  type CanvasState, type Rect,
} from '../web/src/components/consoles/canvasLayout.ts';

const rect = (x: number, y: number, width = 400, height = 300): Rect => ({ x, y, width, height });

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  } as unknown as Storage;
}

describe('zoom clamp', () => {
  it('keeps zoom inside the allowed range and survives garbage', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(Number.NaN)).toBe(1);
  });
});

const touching = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('gridPlacement', () => {
  it('puts each new console beside the previous one with a gap, at full size', () => {
    const first = gridPlacement(0);
    const second = gridPlacement(1);
    expect(first).toMatchObject({ width: TILE_WIDTH, height: TILE_HEIGHT });
    expect(second.y).toBe(first.y);
    expect(second.x - (first.x + first.width)).toBe(TILE_GAP);
  });
  it('starts a new row below once a row is full, without overlapping any earlier slot', () => {
    const slots = Array.from({ length: 9 }, (_, index) => gridPlacement(index));
    expect(slots[3]!.x).toBe(slots[0]!.x);
    expect(slots[3]!.y - (slots[0]!.y + slots[0]!.height)).toBe(TILE_GAP);
    for (const [i, a] of slots.entries()) for (const b of slots.slice(i + 1)) expect(touching(a, b)).toBe(false);
  });
  it('wraps so a long run never leaves the world', () => {
    const far = gridPlacement(500);
    expect(far.x + far.width).toBeLessThanOrEqual(WORLD_HALF);
    expect(far.y + far.height).toBeLessThanOrEqual(WORLD_HALF);
  });
});

describe('freePlacement', () => {
  it('uses the first slot on an empty canvas', () => {
    expect(freePlacement([])).toEqual(gridPlacement(0));
  });
  it('skips slots a tile already covers, even one dragged off the grid', () => {
    const dragged = rect(gridPlacement(1).x - 100, gridPlacement(1).y + 50, 400, 300);
    const placed = freePlacement([gridPlacement(0), dragged]);
    expect(placed).toEqual(gridPlacement(2));
  });
  it('reuses a slot left empty by a closed console', () => {
    expect(freePlacement([gridPlacement(1), gridPlacement(2)])).toEqual(gridPlacement(0));
  });
});

describe('tidyGrid', () => {
  it('lays the given tiles out full size, in order, with no overlap, and leaves the rest alone', () => {
    const rects = { a: rect(5, 5), b: rect(6, 6), c: rect(7, 7), d: rect(8, 8), other: rect(-900, -900) };
    const tidy = tidyGrid(rects, ['a', 'b', 'c', 'd']);
    const laid = [tidy.a!, tidy.b!, tidy.c!, tidy.d!];
    expect(laid.every((r) => r.width === TILE_WIDTH && r.height === TILE_HEIGHT)).toBe(true);
    for (const [i, a] of laid.entries()) for (const b of laid.slice(i + 1)) expect(touching(a, b)).toBe(false);
    expect(tidy.b!.x).toBeGreaterThan(tidy.a!.x);
    expect(tidy.d!.y).toBeGreaterThan(tidy.a!.y);
    expect(tidy.other).toBe(rects.other);
    expect(rects.a).toEqual(rect(5, 5));
  });
  it('prefers a grid wider than it is tall', () => {
    expect(tidyColumns(1)).toBe(1);
    expect(tidyColumns(2)).toBe(2);
    expect(tidyColumns(6)).toBe(3);
    expect(tidyColumns(8)).toBe(4);
  });
});

describe('move, resize, clamp', () => {
  it('moves without mutating', () => {
    const before = rect(10, 20);
    const after = moveRect(before, 5, -5);
    expect(after).toMatchObject({ x: 15, y: 15 });
    expect(before.x).toBe(10);
  });
  it('lets a tile go left of and above where the canvas started', () => {
    expect(moveRect(rect(0, 0), -100, -100)).toMatchObject({ x: -100, y: -100 });
    expect(moveRect(rect(48, 48), -3000, -3000)).toMatchObject({ x: -2952, y: -2952 });
  });
  it('stops a tile only at the far edge of the world, in every direction', () => {
    const near = moveRect(rect(0, 0), -WORLD_SIZE * 2, -WORLD_SIZE * 2);
    expect(near).toMatchObject({ x: -WORLD_HALF, y: -WORLD_HALF });
    const far = moveRect(rect(0, 0), WORLD_SIZE * 2, WORLD_SIZE * 2);
    expect(far.x + far.width).toBe(WORLD_HALF);
    expect(far.y + far.height).toBe(WORLD_HALF);
  });
  it('enforces a minimum size when resizing', () => {
    const small = resizeRect(rect(0, 0), -5000, -5000);
    expect(small.width).toBe(MIN_WIDTH);
    expect(small.height).toBe(MIN_HEIGHT);
    expect(resizeRect(rect(0, 0), 20, 10)).toMatchObject({ width: 420, height: 310 });
  });
  it('clampRect repairs oversized and non-finite rects', () => {
    const fixed = clampRect({ x: Number.NaN, y: -9, width: 1e9, height: 1 });
    expect(fixed.width).toBe(WORLD_SIZE);
    expect(fixed.x).toBe(-WORLD_HALF); // a world-wide tile can only sit at the world's left edge
    expect(fixed.y).toBe(-9); // a negative y is now a legitimate place, not an error to repair
    expect(fixed.height).toBe(MIN_HEIGHT);
  });
});

describe('coordinate conversion', () => {
  const vp = { panX: 100, panY: -50, zoom: 0.5 };
  it('round-trips world and screen points', () => {
    const world = screenToWorld(vp, { x: 300, y: 200 });
    expect(world).toEqual({ x: 400, y: 500 });
    expect(worldToScreen(vp, world)).toEqual({ x: 300, y: 200 });
  });
});

describe('zoomAbout', () => {
  it('keeps the world point under the cursor fixed', () => {
    const vp = { panX: 30, panY: 40, zoom: 1 };
    const anchor = { x: 250, y: 180 };
    const before = screenToWorld(vp, anchor);
    const next = zoomAbout(vp, 1.25, anchor);
    expect(next.zoom).toBeCloseTo(1.25);
    const after = screenToWorld(next, anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
  it('clamps zoom and leaves the viewport alone when already at the limit', () => {
    const max = { panX: 5, panY: 5, zoom: MAX_ZOOM };
    expect(zoomAbout(max, 2, { x: 10, y: 10 })).toEqual(max);
    expect(zoomAbout(DEFAULT_VIEWPORT, 0.0001, { x: 0, y: 0 }).zoom).toBe(MIN_ZOOM);
  });
  it('pans by a screen delta', () => {
    expect(panViewport(DEFAULT_VIEWPORT, 12, -7)).toMatchObject({ panX: 12, panY: -7 });
  });
});

describe('fitAll', () => {
  it('returns the default viewport when there is nothing to fit', () => {
    expect(fitAll([], { width: 800, height: 600 })).toEqual(DEFAULT_VIEWPORT);
  });
  it('shows every rect inside the view', () => {
    const rects = [rect(0, 0, 400, 300), rect(1500, 900, 400, 300)];
    const view = { width: 1000, height: 600 };
    const vp = fitAll(rects, view);
    expect(vp.zoom).toBeLessThan(1);
    expect(vp.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    for (const r of rects) {
      const tl = worldToScreen(vp, { x: r.x, y: r.y });
      const br = worldToScreen(vp, { x: r.x + r.width, y: r.y + r.height });
      expect(tl.x).toBeGreaterThanOrEqual(0);
      expect(tl.y).toBeGreaterThanOrEqual(0);
      expect(br.x).toBeLessThanOrEqual(view.width + 0.001);
      expect(br.y).toBeLessThanOrEqual(view.height + 0.001);
    }
  });
  it('never zooms in past 1 for a small cluster', () => {
    expect(fitAll([rect(10, 10, 300, 200)], { width: 2000, height: 1500 }).zoom).toBeLessThanOrEqual(1);
  });
  it('zooms in to fill the view with one tile when a higher limit is allowed', () => {
    const view = { width: 2000, height: 1500 };
    const tile = rect(10, 10, 600, 400);
    const vp = fitAll([tile], view, MAX_ZOOM);
    expect(vp.zoom).toBeGreaterThan(1);
    expect(vp.zoom).toBeLessThanOrEqual(MAX_ZOOM);
    const bottomRight = worldToScreen(vp, { x: tile.x + tile.width, y: tile.y + tile.height });
    expect(bottomRight.x).toBeLessThanOrEqual(view.width);
    expect(bottomRight.y).toBeLessThanOrEqual(view.height);
  });
});

describe('z-order', () => {
  it('moves an id to the end without mutating', () => {
    const order = ['a', 'b', 'c'];
    expect(bringToFront(order, 'a')).toEqual(['b', 'c', 'a']);
    expect(order).toEqual(['a', 'b', 'c']);
  });
  it('adds an unknown id and is a no-op for the top one', () => {
    expect(bringToFront(['a'], 'z')).toEqual(['a', 'z']);
    const top = ['a', 'b'];
    expect(bringToFront(top, 'b')).toBe(top);
  });
});

describe('reconcile', () => {
  it('drops geometry for vanished consoles and places new ones', () => {
    const state: CanvasState = { ...emptyCanvas(), rects: { a: rect(5, 5), gone: rect(9, 9) }, order: ['gone', 'a'] };
    const next = reconcile(state, ['a', 'b']);
    expect(Object.keys(next.rects).sort()).toEqual(['a', 'b']);
    expect(next.rects.a).toEqual(rect(5, 5));
    expect(next.order).toEqual(['a', 'b']);
  });
  it('returns the same object when nothing changed', () => {
    const state = reconcile(emptyCanvas(), ['a']);
    expect(reconcile(state, ['a'])).toBe(state);
  });
  it('does not stack two new consoles on the same spot', () => {
    const next = reconcile(emptyCanvas(), ['a', 'b']);
    expect(next.rects.a).not.toEqual(next.rects.b);
  });
  it('places new tiles within their own project, so each project starts top-left', () => {
    const first = reconcile(emptyCanvas(), ['a1', 'a2', 'b1'], ['a1', 'a2']);
    expect(first.rects.a1).toEqual(gridPlacement(0));
    expect(first.rects.a2).toEqual(gridPlacement(1));
    expect(first.rects.b1).toBeUndefined();
    const second = reconcile(first, ['a1', 'a2', 'b1'], ['b1']);
    expect(second.rects.b1).toEqual(gridPlacement(0));
    expect(second.rects.a1).toEqual(first.rects.a1);
  });
  it('puts a newcomer where it was asked to go (a console taking its tile\'s place), and only a newcomer', () => {
    const wish = rect(-500, 300, 640, 420);
    const placed = reconcile(emptyCanvas(), ['a', 'b'], ['a', 'b'], { b: wish, ghost: rect(0, 0) });
    expect(placed.rects.b).toEqual(wish);
    expect(placed.rects.a).toEqual(gridPlacement(0));
    expect(placed.rects.ghost).toBeUndefined();
    expect(reconcile(placed, ['a', 'b'], ['a', 'b'], { a: rect(9, 9) })).toBe(placed);
  });
  it('gives a newcomer a slot clear of the tiles already on its canvas', () => {
    const state: CanvasState = { ...emptyCanvas(), rects: { a: gridPlacement(0) }, order: ['a'] };
    const next = reconcile(state, ['a', 'b']);
    expect(next.rects.b).toEqual(gridPlacement(1));
  });
  it('parks a vanished tile\'s geometry and puts it back exactly there when it returns', () => {
    const spot = rect(-1200, 700, 820, 510);
    const state: CanvasState = { ...emptyCanvas(), rects: { a: gridPlacement(0), b: spot }, order: ['b', 'a'] };
    const gone = reconcile(state, ['a']);
    expect(gone.rects.b).toBeUndefined();
    expect(gone.parked?.b).toEqual(spot);
    const back = reconcile(gone, ['a', 'b']);
    expect(back.rects.b).toEqual(spot);
    expect(back.parked?.b).toBeUndefined();
  });
  it('restores a whole board that vanished at once (daemon restart), not into the grid', () => {
    const rects = { a: rect(3000, 40, 900, 600), b: rect(-400, -900, 700, 500), c: rect(10, 2000, 900, 600) };
    const state: CanvasState = { ...emptyCanvas(), rects, order: ['c', 'a', 'b'] };
    const empty = reconcile(state, []);
    expect(empty.rects).toEqual({});
    const restored = reconcile(reconcile(empty, ['a']), ['a', 'b', 'c']);
    expect(restored.rects).toEqual(rects);
  });
  it('prefers an explicit placement over a parked one', () => {
    const gone = reconcile({ ...emptyCanvas(), rects: { a: rect(5, 5) }, order: ['a'] }, []);
    const wish = rect(800, 800);
    expect(reconcile(gone, ['a'], ['a'], { a: wish }).rects.a).toEqual(wish);
  });
  it('places a returning tile from another project when that project is shown', () => {
    const gone = reconcile({ ...emptyCanvas(), rects: { x: rect(77, 88) }, order: ['x'] }, [], []);
    const hidden = reconcile(gone, ['x'], []);
    expect(hidden.rects.x).toBeUndefined();
    expect(reconcile(hidden, ['x'], ['x']).rects.x).toEqual(rect(77, 88));
  });
  it('keeps other projects geometry while one project is shown, and is idempotent', () => {
    const state = reconcile(reconcile(emptyCanvas(), ['a', 'b'], ['a']), ['a', 'b'], ['b']);
    expect(reconcile(state, ['a', 'b'], ['a'])).toBe(state);
    expect(reconcile(state, ['a', 'b'], ['b'])).toBe(state);
  });
});

describe('per-project viewports', () => {
  it('falls back to the default and keeps projects independent without mutating', () => {
    const base = emptyCanvas();
    const a = setViewport(base, 'a', { panX: 1, panY: 2, zoom: 0.5 });
    expect(viewportFor(base, 'a')).toEqual(DEFAULT_VIEWPORT);
    expect(viewportFor(a, 'a')).toEqual({ panX: 1, panY: 2, zoom: 0.5 });
    expect(viewportFor(a, 'b')).toEqual(DEFAULT_VIEWPORT);
    const both = setViewport(a, 'b', { panX: 9, panY: 9, zoom: 1.2 });
    expect(viewportFor(both, 'a').zoom).toBe(0.5);
    expect(viewportFor(both, 'b').zoom).toBe(1.2);
    expect(a.viewports.b).toBeUndefined();
  });
});

describe('persistence', () => {
  it('round-trips through storage', () => {
    const storage = fakeStorage();
    const state = reconcile(emptyCanvas(), ['a', 'b']);
    saveCanvas(setViewport(state, 'p', { panX: 3, panY: 4, zoom: 0.8 }), storage);
    const loaded = loadCanvas(storage);
    expect(loaded.rects).toEqual(state.rects);
    expect(viewportFor(loaded, 'p')).toEqual({ panX: 3, panY: 4, zoom: 0.8 });
    expect(loaded.order).toEqual(['a', 'b']);
  });
  it('returns an empty canvas for missing or corrupt data', () => {
    expect(loadCanvas(fakeStorage())).toEqual(emptyCanvas());
    expect(loadCanvas(fakeStorage({ [CANVAS_STORAGE_KEY]: '{not json' }))).toEqual(emptyCanvas());
    expect(loadCanvas(fakeStorage({ [CANVAS_STORAGE_KEY]: '42' }))).toEqual(emptyCanvas());
  });
  it('sanitizes bad numbers, bad entries and unknown order ids', () => {
    const raw = JSON.stringify({
      rects: { ok: { x: 10, y: 10, width: 500, height: 400 }, bad: { x: 'a', y: 1, width: 1, height: 1 }, nan: null },
      order: ['ok', 'ghost', 7],
      viewport: { panX: 'x', panY: 1e99, zoom: 50 },
    });
    const loaded = loadCanvas(fakeStorage({ [CANVAS_STORAGE_KEY]: raw }));
    expect(Object.keys(loaded.rects)).toEqual(['ok']);
    expect(loaded.order).toEqual(['ok']);
    expect(viewportFor(loaded, 'any').zoom).toBe(MAX_ZOOM);
    expect(Number.isFinite(viewportFor(loaded, 'any').panX)).toBe(true);
    expect(Number.isFinite(viewportFor(loaded, 'any').panY)).toBe(true);
  });
  it('turns an old single viewport into the viewport of every project, rects unchanged', () => {
    const raw = JSON.stringify({ rects: { a: rect(5, 6) }, order: ['a'], viewport: { panX: 10, panY: 20, zoom: 0.5 } });
    const loaded = loadCanvas(fakeStorage({ [CANVAS_STORAGE_KEY]: raw }));
    expect(loaded.rects.a).toEqual(rect(5, 6));
    expect(viewportFor(loaded, 'folder:c:/one')).toEqual({ panX: 10, panY: 20, zoom: 0.5 });
    expect(viewportFor(loaded, 'folder:c:/two')).toEqual({ panX: 10, panY: 20, zoom: 0.5 });
  });
  it('sanitizes and caps per-project viewports', () => {
    const viewports: Record<string, unknown> = { good: { panX: 1, panY: 2, zoom: 0.5 }, bad: { panX: 'x', zoom: 99 }, junk: 7 };
    for (let i = 0; i < MAX_ENTRIES + 10; i++) viewports[`p${i}`] = { panX: i, panY: 0, zoom: 1 };
    const loaded = loadCanvas(fakeStorage({ [CANVAS_STORAGE_KEY]: JSON.stringify({ viewports }) }));
    expect(viewportFor(loaded, 'good')).toEqual({ panX: 1, panY: 2, zoom: 0.5 });
    expect(Object.keys(loaded.viewports).length).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(Object.values(loaded.viewports).every((v) => Number.isFinite(v.panX) && v.zoom >= MIN_ZOOM && v.zoom <= MAX_ZOOM)).toBe(true);
  });
  it('flags a save from before contents scaled with the zoom, so each project is re-laid-out once', () => {
    const old = JSON.stringify({ rects: { a: rect(5, 6, 300, 200) }, order: ['a'], viewports: { p: { panX: 0, panY: 0, zoom: 1.5 } } });
    const loaded = loadCanvas(fakeStorage({ [CANVAS_STORAGE_KEY]: old }));
    expect(needsUpgrade(loaded, 'p')).toBe(true);
    const done = markUpgraded(loaded, 'p');
    expect(needsUpgrade(done, 'p')).toBe(false);
    expect(needsUpgrade(done, 'q')).toBe(true);
    expect(markUpgraded(done, 'p')).toBe(done);
    const storage = fakeStorage();
    saveCanvas(done, storage);
    const again = loadCanvas(storage);
    expect(needsUpgrade(again, 'p')).toBe(false);
    expect(needsUpgrade(again, 'q')).toBe(true);
  });
  it('never asks a current or empty canvas to be re-laid-out', () => {
    const storage = fakeStorage();
    saveCanvas(reconcile(emptyCanvas(), ['a']), storage);
    expect(needsUpgrade(loadCanvas(storage), 'p')).toBe(false);
    expect(needsUpgrade(emptyCanvas(), 'p')).toBe(false);
    expect(needsUpgrade(loadCanvas(fakeStorage({ [CANVAS_STORAGE_KEY]: JSON.stringify({ viewports: {} }) })), 'p')).toBe(false);
  });
  it('caps the number of stored entries', () => {
    const rects = Object.fromEntries(Array.from({ length: MAX_RECTS + 20 }, (_, i) => [`c${i}`, rect(0, 0)]));
    const loaded = loadCanvas(fakeStorage({ [CANVAS_STORAGE_KEY]: JSON.stringify({ rects, parked: rects }) }));
    expect(Object.keys(loaded.rects)).toHaveLength(MAX_RECTS);
    expect(Object.keys(loaded.parked ?? {})).toHaveLength(MAX_RECTS);
    expect(loaded.parked?.[`c${MAX_RECTS + 19}`]).toBeDefined();
  });
  it('round-trips parked geometry, so a tile closed before a reload still comes back to its spot', () => {
    const storage = fakeStorage();
    const gone = reconcile({ ...emptyCanvas(), rects: { a: rect(-321, 654) }, order: ['a'] }, []);
    saveCanvas(gone, storage);
    const loaded = loadCanvas(storage);
    expect(loaded.parked?.a).toEqual(rect(-321, 654));
    expect(reconcile(loaded, ['a']).rects.a).toEqual(rect(-321, 654));
    const junk = loadCanvas(fakeStorage({ [CANVAS_STORAGE_KEY]: JSON.stringify({ parked: { ok: rect(1, 2), bad: 'x' } }) }));
    expect(junk.parked).toEqual({ ok: rect(1, 2) });
  });
  it('caps parked geometry, forgetting the oldest first', () => {
    let state: CanvasState = emptyCanvas();
    for (let i = 0; i < MAX_RECTS + 5; i++) state = reconcile(reconcile(state, [`t${i}`]), []);
    expect(Object.keys(state.parked ?? {})).toHaveLength(MAX_RECTS);
    expect(state.parked?.t0).toBeUndefined();
    expect(state.parked?.[`t${MAX_RECTS + 4}`]).toBeDefined();
  });
  it('never throws when storage is blocked', () => {
    const blocked = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    } as unknown as Storage;
    expect(loadCanvas(blocked)).toEqual(emptyCanvas());
    expect(() => saveCanvas(emptyCanvas(), blocked)).not.toThrow();
  });
});

describe('a canvas spread over a large area', () => {
  it('preserves missing geometry until console and local-tile inventories are loaded', () => {
    const original = { ...emptyCanvas(), rects: { 'console:a': rect(-800, 300, 800, 500), 'tile:b': rect(1100, -200, 650, 420) }, order: ['tile:b', 'console:a'], viewports: { p: { panX: 650, panY: -90, zoom: .22 } } };
    const loading = reconcile(original, [], [], {}, false);
    expect(loading).toBe(original);
    const consolesArrived = reconcile(loading, ['console:a'], ['console:a'], {}, false);
    expect(consolesArrived.rects).toEqual(original.rects);
    const ready = reconcile(consolesArrived, ['console:a', 'tile:b'], ['console:a', 'tile:b'], {}, true);
    expect(ready.rects).toEqual(original.rects);
    expect(ready.order).toEqual(original.order);
    expect(viewportFor(ready, 'p')).toEqual(original.viewports.p);
    expect(reconcile(ready, ['tile:b'], ['tile:b'], {}, true).rects['console:a']).toBeUndefined();
  });
  const view = { width: 1220, height: 674 };
  it('fit all still shows every tile when one was dragged far up and to the left', () => {
    const spread = [rect(-2452, -2452, 560, 360), rect(900, 700, 560, 360)];
    const viewport = fitAll(spread, view);
    for (const tile of spread) {
      const topLeft = worldToScreen(viewport, { x: tile.x, y: tile.y });
      const bottomRight = worldToScreen(viewport, { x: tile.x + tile.width, y: tile.y + tile.height });
      expect(topLeft.x).toBeGreaterThanOrEqual(0);
      expect(topLeft.y).toBeGreaterThanOrEqual(0);
      expect(bottomRight.x).toBeLessThanOrEqual(view.width);
      expect(bottomRight.y).toBeLessThanOrEqual(view.height);
    }
  });
  it('zooms out far enough to see tiles spread across most of the world', () => {
    const wide = [rect(-WORLD_HALF, -WORLD_HALF, 560, 360), rect(WORLD_HALF - 560, WORLD_HALF - 360, 560, 360)];
    const viewport = fitAll(wide, view);
    expect(viewport.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    const topLeft = worldToScreen(viewport, { x: wide[0]!.x, y: wide[0]!.y });
    const bottomRight = worldToScreen(viewport, { x: wide[1]!.x + wide[1]!.width, y: wide[1]!.y + wide[1]!.height });
    expect(topLeft.x).toBeGreaterThanOrEqual(0);
    expect(topLeft.y).toBeGreaterThanOrEqual(0);
    expect(bottomRight.x).toBeLessThanOrEqual(view.width);
    expect(bottomRight.y).toBeLessThanOrEqual(view.height);
  });
});

describe('readableViewport (opening a canvas)', () => {
  const view = { width: 1200, height: 700 };
  it('keeps a saved view that is already readable', () => {
    const saved = { panX: 10, panY: 20, zoom: 0.8 };
    expect(readableViewport(saved, [rect(0, 0, 560, 360)], view)).toBe(saved);
  });
  it('replaces a view zoomed out too far to read with one that fits the tiles', () => {
    const saved = { panX: 0, panY: 0, zoom: MIN_ZOOM };
    const next = readableViewport(saved, [rect(48, 48, 560, 360)], view);
    expect(next.zoom).toBeGreaterThanOrEqual(READABLE_ZOOM);
  });
  it('shows the first tile at a readable size when the tiles are too spread to fit', () => {
    const spread = [rect(-WORLD_HALF, -WORLD_HALF, 560, 360), rect(WORLD_HALF - 560, WORLD_HALF - 360, 560, 360)];
    const next = readableViewport({ panX: 0, panY: 0, zoom: MIN_ZOOM }, spread, view);
    expect(next.zoom).toBe(1);
    const topLeft = worldToScreen(next, { x: spread[0].x, y: spread[0].y });
    expect(topLeft.x).toBeGreaterThanOrEqual(0);
    expect(topLeft.y).toBeGreaterThanOrEqual(0);
  });
  it('leaves the view alone when there is nothing to show or no stage size yet', () => {
    const saved = { panX: 0, panY: 0, zoom: MIN_ZOOM };
    expect(readableViewport(saved, [], view)).toBe(saved);
    expect(readableViewport(saved, [rect(0, 0, 560, 360)], { width: 0, height: 0 })).toBe(saved);
  });
});
