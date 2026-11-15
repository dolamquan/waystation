/**
 * Tiles that live only on the canvas: a blank tile waiting for the operator to choose what it becomes, a browser tile
 * browsing the web, and a file tile showing a file from a project folder (code, notebook, PDF, image). Consoles
 * and agents are tiles too, but the daemon owns those. Pure logic, no React and no DOM; everything read back from
 * storage is untrusted and sanitised on the way in.
 */

export type LocalTileKind = 'blank' | 'browser' | 'file' | 'note' | 'orchestrator' | 'worktree';

export interface LocalTile {
  readonly id: string;
  readonly kind: LocalTileKind;
  /** The project (folder key) whose canvas the tile was made on; it is shown there. */
  readonly project: string;
  /** What the operator called the tile; absent means a default label (see tileLabel). */
  readonly name?: string;
  /** Browser tiles only: the page shown, always a validated HTTP(S) URL. */
  readonly url?: string;
  /** File tiles: absolute root + relative file. Worktree tiles: repository root + selected absolute worktree path. */
  readonly root?: string;
  readonly path?: string;
  /** Plain Markdown, rendered without raw HTML. */
  readonly content?: string;
  /** Orchestrator tiles only: the teams (canvas group ids) wired to it with Connect. Empty means none. */
  readonly teams?: readonly string[];
  /** Orchestrator tiles only: single agents (board item keys such as `console:<id>`) wired to it. Empty means none. */
  readonly agents?: readonly string[];
  readonly createdAt: number;
}

export const TILES_KEY = 'waystation-canvas-tiles';
export const MAX_TILES = 32;
export const MAX_NAME = 60;
export const MAX_ORCHESTRATOR_TEAMS = 24;
const MAX_TEAM_ID = 128;
export const DEFAULT_BROWSER_URL = 'https://www.google.com/';
const TILE_PREFIX = 'tile:';
const MAX_URL = 2048;
const MAX_PATH = 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const tileKey = (id: string): string => `${TILE_PREFIX}${id}`;
export const isTileKey = (key: string): boolean => key.startsWith(TILE_PREFIX);

/** A name as typed, trimmed and capped; undefined when nothing is left (the tile falls back to its default label). */
export function cleanName(raw: string | undefined): string | undefined {
  const name = (raw ?? '').trim().slice(0, MAX_NAME).trim();
  return name || undefined;
}

/** The last part of a path, either slash. */
export const fileName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** What a tile is called on its title bar. */
export function tileLabel(tile: LocalTile): string {
  if (tile.name) return tile.name;
  if (tile.kind === 'browser') return 'web';
  if (tile.kind === 'file' && tile.path) return fileName(tile.path);
  if (tile.kind === 'note') return 'Note';
  if (tile.kind === 'orchestrator') return 'Orchestrator';
  if (tile.kind === 'worktree') return 'Worktrees';
  return 'New tile';
}

export type UrlCheck = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };

/**
 * Public sites default to HTTPS; local development servers default to HTTP.
 * The authenticated application and credentials in URLs are never browser tile destinations.
 */
export function browserUrl(raw: string, appOrigin: string): UrlCheck {
  const text = raw.trim();
  if (!text) return { ok: false, reason: 'Type a website address, such as example.com or localhost:3000.' };
  if (text.length > MAX_URL) return { ok: false, reason: 'That address is too long.' };
  let url: URL;
  try {
    const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(text);
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${local ? 'http' : 'https'}://${text}`);
  } catch {
    return { ok: false, reason: 'That is not a valid address.' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, reason: 'Use an http:// or https:// website address.' };
  if (url.username || url.password) return { ok: false, reason: 'Use an address without a username or password. Sign in on the website instead.' };
  const app = new URL(appOrigin);
  if (url.origin === app.origin || (LOCAL_HOSTS.has(url.hostname) && LOCAL_HOSTS.has(app.hostname) && url.port === app.port))
    return { ok: false, reason: 'That is Waystation itself; a tile cannot show it.' };
  return { ok: true, url: url.href };
}

/** Short label for a browser tile: "localhost:3000". */
export function urlLabel(url: string | undefined): string {
  if (!url) return 'browser';
  try { return new URL(url).host; } catch { return 'browser'; }
}

/** The tiles on one project's canvas; the all-projects canvas shows every tile. */
export const tilesFor = (tiles: readonly LocalTile[], project: string, showAll: boolean): readonly LocalTile[] =>
  (showAll ? tiles : tiles.filter((tile) => tile.project === project));

export const addTile = (tiles: readonly LocalTile[], tile: LocalTile): readonly LocalTile[] => [...tiles, tile].slice(-MAX_TILES);

export const removeTile = (tiles: readonly LocalTile[], id: string): readonly LocalTile[] => tiles.filter((tile) => tile.id !== id);

export type TilePatch = Partial<Pick<LocalTile, 'kind' | 'url' | 'name' | 'root' | 'path' | 'content' | 'teams' | 'agents'>>;

/** Team ids or agent keys as stored on an orchestrator: strings only, de-duplicated and capped. */
export function cleanTeamIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_TEAM_ID);
  return [...new Set(ids)].slice(0, MAX_ORCHESTRATOR_TEAMS);
}

/** Applies a patch; a `name` that is empty after trimming clears the tile's name. */
export function updateTile(tiles: readonly LocalTile[], id: string, patch: TilePatch): readonly LocalTile[] {
  return tiles.map((tile) => {
    if (tile.id !== id) return tile;
    const { name: _old, ...rest } = { ...tile, ...patch };
    const name = 'name' in patch ? cleanName(patch.name) : tile.name;
    return name ? { ...rest, name } : rest;
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH && !value.includes('\0') && !value.split(/[\\/]+/).includes('..');

export function readTile(value: unknown, appOrigin: string): LocalTile | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() || typeof value.project !== 'string') return undefined;
  if (!['blank', 'browser', 'file', 'note', 'orchestrator', 'worktree'].includes(String(value.kind))) return undefined;
  const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : 0;
  const name = typeof value.name === 'string' ? cleanName(value.name) : undefined;
  const base = { id: value.id, project: value.project, createdAt, ...(name ? { name } : {}) };
  const blank: LocalTile = { ...base, kind: 'blank' };
  if (value.kind === 'worktree') return isPath(value.root) && isPath(value.path) ? { ...base, kind: 'worktree', root: value.root, path: value.path } : blank;
  if (value.kind === 'orchestrator') return { ...base, kind: 'orchestrator', teams: cleanTeamIds(value.teams), agents: cleanTeamIds(value.agents) };
  if (value.kind === 'note') return { ...base, kind: 'note', content: typeof value.content === 'string' ? value.content.slice(0, 100_000) : '' };
  if (value.kind === 'browser') {
    // A stored URL is checked again: storage is not trusted, and a bad one turns the tile back into a blank one.
    const checked = typeof value.url === 'string' ? browserUrl(value.url, appOrigin) : undefined;
    return checked?.ok ? { ...base, kind: 'browser', url: checked.url } : blank;
  }
  if (value.kind === 'file') {
    return isPath(value.root) && isPath(value.path) ? { ...base, kind: 'file', root: value.root, path: value.path } : blank;
  }
  return blank;
}

/** Loads saved tiles; anything malformed is dropped. Never throws. */
export function loadTiles(appOrigin: string, storage: Storage = localStorage): readonly LocalTile[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(TILES_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const tiles = parsed.map((value) => readTile(value, appOrigin)).filter((tile): tile is LocalTile => tile !== undefined);
    return tiles.filter((tile, index) => tiles.findIndex((other) => other.id === tile.id) === index).slice(-MAX_TILES);
  } catch {
    return [];
  }
}

/** Saves tiles; false when the browser refused (blocked or full storage). */
export function saveTiles(tiles: readonly LocalTile[], storage: Storage = localStorage): boolean {
  try {
    storage.setItem(TILES_KEY, JSON.stringify(tiles));
    return true;
  } catch {
    return false;
  }
}
