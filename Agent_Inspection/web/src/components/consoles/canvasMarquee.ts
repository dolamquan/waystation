import { WORLD_HALF, screenToWorld, type Point, type Rect, type Viewport } from './canvasLayout.ts';

/**
 * Moves every rect by the same (dx, dy), so a selection keeps its arrangement. The step is limited by the selection's
 * bounding box, so the whole group stops at the world's edge rather than its tiles piling up against it.
 */
export function moveTogether(origins: Readonly<Record<string, Rect>>, dx: number, dy: number): Record<string, Rect> {
  const rects = Object.values(origins);
  if (rects.length === 0) return {};
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  const stepX = Math.min(Math.max(dx, -WORLD_HALF - minX), WORLD_HALF - maxX);
  const stepY = Math.min(Math.max(dy, -WORLD_HALF - minY), WORLD_HALF - maxY);
  return Object.fromEntries(Object.entries(origins).map(([id, r]) => [id, { ...r, x: r.x + stepX, y: r.y + stepY }]));
}

/** The box dragged from `start` by (dx, dy), in stage pixels, with a non-negative width and height whichever way it was dragged. */
export function marqueeRect(start: Point, dx: number, dy: number): Rect {
  return {
    x: Math.min(start.x, start.x + dx),
    y: Math.min(start.y, start.y + dy),
    width: Math.abs(dx),
    height: Math.abs(dy),
  };
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Keys whose world rect the screen-space box touches; a tile only partly inside the box counts. */
export function keysInMarquee(
  box: Rect, viewport: Viewport, rects: Readonly<Record<string, Rect>>, keys: readonly string[],
): string[] {
  const from = screenToWorld(viewport, { x: box.x, y: box.y });
  const to = screenToWorld(viewport, { x: box.x + box.width, y: box.y + box.height });
  const world: Rect = { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y };
  return keys.filter((key) => {
    const rect = rects[key];
    return rect !== undefined && overlaps(world, rect);
  });
}
