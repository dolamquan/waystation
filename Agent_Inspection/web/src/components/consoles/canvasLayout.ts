/**
 * Pure geometry for the free-form console canvas: where each console sits in an unbounded-feeling "world",
 * and which part of that world the viewport shows. No React and no DOM, so it is unit tested directly.
 * Coordinates are world pixels; the viewport maps them to screen pixels as `screen = world * zoom + pan`.
 */

export const CANVAS_STORAGE_KEY = 'waystation-console-canvas';

/** Low enough for a bird's-eye view of a big board, and for "Fit all" to show tiles spread across the whole world. */
export const MIN_ZOOM = 0.025;
/** Tiles scale with the zoom (text included), so zooming in past 100% is how one session is read up close. */
export const MAX_ZOOM = 2.5;
export const MIN_WIDTH = 280;
export const MIN_HEIGHT = 180;
/**
 * The world reaches this far in EVERY direction from the origin, so a tile can be dragged left of and above where the
 * canvas started (a world that began at 0 put an invisible wall at the origin once the view was panned or zoomed).
 * It is large enough to never feel like a wall, small enough to stay finite.
 */
export const WORLD_HALF = 10_000;
export const WORLD_SIZE = WORLD_HALF * 2;
/** The pan offset is bounded too, so a corrupt save cannot throw the stage into empty space. */
const PAN_LIMIT = WORLD_SIZE * 2;
export const MAX_ENTRIES = 64;
/** Tile geometry kept, live and parked each: generous, since a lost position means a rearranged board. */
export const MAX_RECTS = 256;
const FIT_PADDING = 48;
/** A new tile is big enough to hold a real conversation at 100% (about 110 columns by 35 rows of terminal text). */
export const TILE_WIDTH = 900;
export const TILE_HEIGHT = 600;
/** Room between neighbours, so a board of sessions reads as separate cards rather than a packed stack. */
export const TILE_GAP = 48;
const GRID_ORIGIN = 48;
const GRID_COLUMNS = 3;
const GRID_ROWS = 12;
const GRID_SLOTS = GRID_COLUMNS * GRID_ROWS;
const LAP_OFFSET = 28;

export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface Point { readonly x: number; readonly y: number }
export interface Viewport { readonly panX: number; readonly panY: number; readonly zoom: number }
export interface CanvasState {
  readonly rects: Readonly<Record<string, Rect>>;
  /** Back to front: the last id is drawn on top. */
  readonly order: readonly string[];
  /** Each project has its own pan and zoom, keyed by project (folder) key. */
  readonly viewports: Readonly<Record<string, Viewport>>;
  /** Used by projects with no viewport of their own; an old save's single viewport lands here. */
  readonly fallbackViewport: Viewport;
  /**
   * Where tiles that went away last sat, oldest first. A console that stops with the daemon (or is closed and later
   * restored under the same id) returns to exactly this spot instead of the next free grid slot.
   */
  readonly parked?: Readonly<Record<string, Rect>>;
  /**
   * Only on a canvas saved before tile contents scaled with the zoom: the projects already re-laid-out for it. Such a
   * save holds small tiles viewed zoomed in (zoom used to enlarge the tile, not its text), which now reads as giant
   * text in a tiny box, so each project is tidied into full-size tiles the first time it opens. Absent on a current canvas.
   */
  readonly upgraded?: readonly string[];
}

/** Written into every save, so a save without it is known to predate content scaling. */
const SAVE_VERSION = 2;

export const needsUpgrade = (state: CanvasState, project: string): boolean =>
  state.upgraded !== undefined && !state.upgraded.includes(project);

export const markUpgraded = (state: CanvasState, project: string): CanvasState =>
  (needsUpgrade(state, project) ? { ...state, upgraded: [...(state.upgraded ?? []), project].slice(-MAX_ENTRIES) } : state);

export const DEFAULT_VIEWPORT: Viewport = { panX: 0, panY: 0, zoom: 1 };
export const emptyCanvas = (): CanvasState => ({ rects: {}, order: [], viewports: {}, fallbackViewport: DEFAULT_VIEWPORT });

export const viewportFor = (state: CanvasState, project: string): Viewport => state.viewports[project] ?? state.fallbackViewport;

export const setViewport = (state: CanvasState, project: string, viewport: Viewport): CanvasState =>
  ({ ...state, viewports: { ...state.viewports, [project]: viewport } });

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const finiteOr = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);

export const clampZoom = (zoom: number): number => (Number.isFinite(zoom) ? clamp(zoom, MIN_ZOOM, MAX_ZOOM) : 1);

/** Keeps a rect inside the world (which extends equally left, right, up and down of the origin) and at least minimum size; repairs non-finite numbers. */
export function clampRect(rect: Rect): Rect {
  const width = clamp(finiteOr(rect.width, TILE_WIDTH), MIN_WIDTH, WORLD_SIZE);
  const height = clamp(finiteOr(rect.height, TILE_HEIGHT), MIN_HEIGHT, WORLD_SIZE);
  return {
    x: clamp(finiteOr(rect.x, 0), -WORLD_HALF, WORLD_HALF - width),
    y: clamp(finiteOr(rect.y, 0), -WORLD_HALF, WORLD_HALF - height),
    width,
    height,
  };
}

export const moveRect = (rect: Rect, dx: number, dy: number): Rect => clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy });

export const resizeRect = (rect: Rect, dw: number, dh: number): Rect =>
  clampRect({ ...rect, width: rect.width + dw, height: rect.height + dh });

/**
 * Slot `index` of the board's grid: three wide, left to right then down, with a gap between neighbours. Past the last
 * slot it starts over slightly offset, so a very long run neither leaves the world nor hides a tile exactly under another.
 */
export function gridPlacement(index: number): Rect {
  const safe = Math.max(0, Math.floor(index));
  const slot = safe % GRID_SLOTS;
  const lap = Math.floor(safe / GRID_SLOTS) % 4;
  return clampRect({
    x: GRID_ORIGIN + lap * LAP_OFFSET + (slot % GRID_COLUMNS) * (TILE_WIDTH + TILE_GAP),
    y: GRID_ORIGIN + lap * LAP_OFFSET + Math.floor(slot / GRID_COLUMNS) * (TILE_HEIGHT + TILE_GAP),
    width: TILE_WIDTH,
    height: TILE_HEIGHT,
  });
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The first grid slot that no tile in `occupied` touches, so a new session never lands on top of one already there. */
export function freePlacement(occupied: readonly Rect[]): Rect {
  for (let index = 0; index < GRID_SLOTS; index++) {
    const slot = gridPlacement(index);
    if (!occupied.some((rect) => overlaps(slot, rect))) return slot;
  }
  return gridPlacement(occupied.length);
}

/** The most full-size columns that fit between the grid's origin and the world's right edge. */
const MAX_TIDY_COLUMNS = Math.floor((WORLD_HALF - GRID_ORIGIN + TILE_GAP) / (TILE_WIDTH + TILE_GAP));

/** How many columns a tidy grid of `count` tiles gets: a little wider than square, since screens are. */
export const tidyColumns = (count: number): number =>
  Math.max(1, Math.min(count, MAX_TIDY_COLUMNS, Math.ceil(Math.sqrt(count * 1.5))));

/** Lays `ids` out as an evenly spaced grid of full-size tiles, in the order given; other tiles keep their identity. */
export function tidyGrid(rects: Readonly<Record<string, Rect>>, ids: readonly string[]): Record<string, Rect> {
  const columns = tidyColumns(ids.length);
  const next: Record<string, Rect> = { ...rects };
  ids.forEach((id, index) => {
    next[id] = clampRect({
      x: GRID_ORIGIN + (index % columns) * (TILE_WIDTH + TILE_GAP),
      y: GRID_ORIGIN + Math.floor(index / columns) * (TILE_HEIGHT + TILE_GAP),
      width: TILE_WIDTH,
      height: TILE_HEIGHT,
    });
  });
  return next;
}

export const screenToWorld = (viewport: Viewport, point: Point): Point =>
  ({ x: (point.x - viewport.panX) / viewport.zoom, y: (point.y - viewport.panY) / viewport.zoom });

export const worldToScreen = (viewport: Viewport, point: Point): Point =>
  ({ x: point.x * viewport.zoom + viewport.panX, y: point.y * viewport.zoom + viewport.panY });

/** Zooms by a factor while the world point under `anchor` (a screen point) stays put, as wheel and pinch expect. */
export function zoomAbout(viewport: Viewport, factor: number, anchor: Point): Viewport {
  const zoom = clampZoom(viewport.zoom * factor);
  if (zoom === viewport.zoom) return viewport;
  const world = screenToWorld(viewport, anchor);
  return { zoom, panX: anchor.x - world.x * zoom, panY: anchor.y - world.y * zoom };
}

export const panViewport = (viewport: Viewport, dx: number, dy: number): Viewport =>
  ({ ...viewport, panX: clamp(viewport.panX + dx, -PAN_LIMIT, PAN_LIMIT), panY: clamp(viewport.panY + dy, -PAN_LIMIT, PAN_LIMIT) });

/**
 * A viewport that shows every rect, centered. By default it never zooms in past 100% (a lone small tile should not
 * balloon); pass a higher `maxZoom` to fill the view with one tile on purpose.
 */
export function fitAll(rects: readonly Rect[], view: { readonly width: number; readonly height: number }, maxZoom = 1): Viewport {
  if (rects.length === 0 || view.width <= 0 || view.height <= 0) return DEFAULT_VIEWPORT;
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  const boundsW = maxX - minX;
  const boundsH = maxY - minY;
  const zoom = clampZoom(Math.min(maxZoom, (view.width - FIT_PADDING * 2) / boundsW, (view.height - FIT_PADDING * 2) / boundsH));
  return { zoom, panX: (view.width - boundsW * zoom) / 2 - minX * zoom, panY: (view.height - boundsH * zoom) / 2 - minY * zoom };
}

/**
 * Below this zoom a tile's text (which scales with the zoom) is too small to read, so a canvas should never OPEN that
 * far out. Zooming there on purpose for an overview is still allowed.
 */
export const READABLE_ZOOM = 0.5;

/**
 * The view to open a project's canvas with: the saved one when readable; otherwise "fit all" if that is readable;
 * otherwise 100% with the first tile in the top-left corner. Without tiles or a measured stage, the saved view stays.
 */
export function readableViewport(saved: Viewport, rects: readonly Rect[], view: { readonly width: number; readonly height: number }): Viewport {
  if (saved.zoom >= READABLE_ZOOM || rects.length === 0 || view.width <= 0 || view.height <= 0) return saved;
  const fitted = fitAll(rects, view);
  if (fitted.zoom >= READABLE_ZOOM) return fitted;
  const first = rects[0]!;
  return { zoom: 1, panX: FIT_PADDING - first.x, panY: FIT_PADDING - first.y };
}

export function bringToFront(order: readonly string[], id: string): readonly string[] {
  if (order[order.length - 1] === id) return order;
  return [...order.filter((existing) => existing !== id), id];
}

/** Adds `gone` to the parked geometry (moving re-parked ids to the newest end) and drops `returned`, oldest-first capped. */
function repark(
  parked: Readonly<Record<string, Rect>>, gone: Readonly<Record<string, Rect>>, returned: readonly string[],
): Record<string, Rect> {
  const skip = new Set([...returned, ...Object.keys(gone)]);
  const entries = [...Object.entries(parked).filter(([id]) => !skip.has(id)), ...Object.entries(gone)];
  return Object.fromEntries(entries.slice(-MAX_RECTS));
}

/**
 * Matches the canvas to the consoles that exist: parks the gone ones, places newcomers, keeps the rest as they are.
 * `ids` is every live item (so other projects keep their geometry); `shown` is the visible project's items. Only those
 * are placed: a newcomer with a `preferred` rect goes there (a console opened from a tile takes that tile's place); one
 * that was on the canvas before goes back to its parked spot; anything else takes the first grid slot free of that
 * project's tiles, so each project starts top-left.
 */
export function reconcile(
  state: CanvasState, ids: readonly string[], shown: readonly string[] = ids, preferred: Readonly<Record<string, Rect>> = {},
  inventoryReady = true,
): CanvasState {
  // An empty in-flight response is not evidence that a console or daemon-owned tile was closed.
  const wanted = new Set(inventoryReady ? ids : [...Object.keys(state.rects), ...ids]);
  const keptOrder = state.order.filter((id) => wanted.has(id) && id in state.rects);
  const missing = shown.filter((id) => wanted.has(id) && !(id in state.rects));
  const dropped = Object.keys(state.rects).some((id) => !wanted.has(id));
  if (!dropped && missing.length === 0 && keptOrder.length === Object.keys(state.rects).length) return state;
  const rects: Record<string, Rect> = {};
  for (const id of keptOrder) rects[id] = state.rects[id]!;
  for (const id of Object.keys(state.rects)) if (wanted.has(id) && !(id in rects)) rects[id] = state.rects[id]!;
  const order = [...keptOrder, ...Object.keys(rects).filter((id) => !keptOrder.includes(id))];
  const parked = state.parked ?? {};
  const gone: Record<string, Rect> = {};
  for (const id of Object.keys(state.rects)) if (!wanted.has(id)) gone[id] = state.rects[id]!;
  const occupied = shown.flatMap((id) => rects[id] ?? []);
  // Returning tiles first, so a brand-new one never takes the spot a returning one is about to reclaim.
  const returning = missing.filter((id) => !preferred[id] && parked[id]);
  occupied.push(...returning.map((id) => parked[id]!));
  for (const id of missing) {
    const wish = preferred[id] ?? parked[id];
    const slot = wish ? clampRect(wish) : freePlacement(occupied);
    rects[id] = slot;
    occupied.push(slot);
    order.push(id);
  }
  return { ...state, rects, order, parked: repark(parked, gone, missing) };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function readRect(value: unknown): Rect | undefined {
  if (!isRecord(value) || !isNumber(value.x) || !isNumber(value.y) || !isNumber(value.width) || !isNumber(value.height)) return undefined;
  return clampRect({ x: value.x, y: value.y, width: value.width, height: value.height });
}

/** Valid rects from a saved map, at most MAX_RECTS: the first ones for live tiles, the newest (last) for parked ones. */
function readRects(value: unknown, keep: 'first' | 'last'): Record<string, Rect> {
  if (!isRecord(value)) return {};
  const valid = Object.entries(value).flatMap(([id, raw]) => {
    const rect = readRect(raw);
    return rect ? [[id, rect] as const] : [];
  });
  return Object.fromEntries(keep === 'first' ? valid.slice(0, MAX_RECTS) : valid.slice(-MAX_RECTS));
}

function readViewport(value: unknown): Viewport {
  if (!isRecord(value)) return DEFAULT_VIEWPORT;
  const pan = (n: unknown) => (isNumber(n) ? clamp(n, -PAN_LIMIT, PAN_LIMIT) : 0);
  return { panX: pan(value.panX), panY: pan(value.panY), zoom: isNumber(value.zoom) ? clampZoom(value.zoom) : 1 };
}

/** Loads saved geometry. Anything malformed is dropped rather than trusted; this never throws. */
export function loadCanvas(storage: Storage = localStorage): CanvasState {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CANVAS_STORAGE_KEY) ?? 'null');
    if (!isRecord(parsed)) return emptyCanvas();
    const rects = readRects(parsed.rects, 'first');
    const parked = readRects(parsed.parked, 'last');
    const saved = Array.isArray(parsed.order) ? parsed.order.filter((id): id is string => typeof id === 'string' && id in rects) : [];
    const order = [...new Set(saved), ...Object.keys(rects).filter((id) => !saved.includes(id))];
    const viewports: Record<string, Viewport> = {};
    if (isRecord(parsed.viewports)) {
      for (const [project, value] of Object.entries(parsed.viewports)) {
        if (Object.keys(viewports).length >= MAX_ENTRIES) break;
        if (isRecord(value)) viewports[project] = readViewport(value);
      }
    }
    // An old save has one `viewport`; it becomes the starting view of every project.
    const base = {
      rects, order, viewports, fallbackViewport: readViewport(parsed.fallbackViewport ?? parsed.viewport),
      ...(Object.keys(parked).length > 0 ? { parked } : {}),
    };
    const listed = Array.isArray(parsed.upgraded) ? parsed.upgraded.filter((key): key is string => typeof key === 'string').slice(-MAX_ENTRIES) : undefined;
    if (parsed.version === SAVE_VERSION) return listed ? { ...base, upgraded: listed } : base;
    // An older save: every project with tiles still has to be re-laid-out. Nothing to do when there are no tiles.
    return Object.keys(rects).length > 0 ? { ...base, upgraded: [] } : base;
  } catch {
    return emptyCanvas();
  }
}

export function saveCanvas(state: CanvasState, storage: Storage = localStorage): void {
  try { storage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...state, version: SAVE_VERSION })); } catch { /* storage blocked or full */ }
}
