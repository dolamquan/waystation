import { describe, expect, it } from 'vitest';
import { WORLD_HALF, type Rect } from '../web/src/components/consoles/canvasLayout.ts';
import { keysInMarquee, marqueeRect, moveTogether } from '../web/src/components/consoles/canvasMarquee.ts';

describe('marqueeRect', () => {
  it('normalizes a drag in any direction to a positive box', () => {
    expect(marqueeRect({ x: 100, y: 100 }, 50, 20)).toEqual({ x: 100, y: 100, width: 50, height: 20 });
    expect(marqueeRect({ x: 100, y: 100 }, -50, -20)).toEqual({ x: 50, y: 80, width: 50, height: 20 });
  });
});

describe('keysInMarquee', () => {
  const rects = {
    a: { x: 0, y: 0, width: 100, height: 100 },
    b: { x: 300, y: 0, width: 100, height: 100 },
    c: { x: 0, y: 300, width: 100, height: 100 },
  };
  const keys = ['a', 'b', 'c', 'missing'];

  it('selects every tile the box touches, even partly', () => {
    const box = marqueeRect({ x: 50, y: 50 }, 300, 10);
    expect(keysInMarquee(box, { panX: 0, panY: 0, zoom: 1 }, rects, keys)).toEqual(['a', 'b']);
  });

  it('maps the box through pan and zoom', () => {
    // At zoom 0.5 panned by 10px, world (300..400, 0..100) is screen (160..210, 10..60).
    const box = marqueeRect({ x: 150, y: 0 }, 20, 20);
    expect(keysInMarquee(box, { panX: 10, panY: 10, zoom: 0.5 }, rects, keys)).toEqual(['b']);
  });

  it('selects nothing for an empty area and ignores keys without a rect', () => {
    const box = marqueeRect({ x: 150, y: 150 }, 100, 100);
    expect(keysInMarquee(box, { panX: 0, panY: 0, zoom: 1 }, rects, keys)).toEqual([]);
  });
});

describe('moveTogether', () => {
  const r = (x: number, y: number, width = 400, height = 300): Rect => ({ x, y, width, height });
  it('moves every selected tile by the same amount, keeping their arrangement', () => {
    const moved = moveTogether({ a: r(0, 0), b: r(500, 200), note: r(-300, 900, 280, 180) }, 120, -40);
    expect(moved).toEqual({ a: r(120, -40), b: r(620, 160), note: r(-180, 860, 280, 180) });
  });
  it('stops the whole group at the world edge instead of squashing it against the wall', () => {
    const moved = moveTogether({ a: r(WORLD_HALF - 900, 0), b: r(WORLD_HALF - 500, 0) }, 5000, 0);
    expect(moved.b!.x).toBe(WORLD_HALF - 400);
    expect(moved.b!.x - moved.a!.x).toBe(400);
    const left = moveTogether({ a: r(-WORLD_HALF + 10, 0), b: r(0, -WORLD_HALF + 50) }, -999, -999);
    expect(left).toEqual({ a: r(-WORLD_HALF, -50), b: r(-10, -WORLD_HALF) });
  });
  it('returns an empty result for an empty selection and does not mutate the input', () => {
    expect(moveTogether({}, 10, 10)).toEqual({});
    const origins = { a: r(0, 0) };
    moveTogether(origins, 10, 10);
    expect(origins.a).toEqual(r(0, 0));
  });
});
