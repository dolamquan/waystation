import { describe, expect, it } from 'vitest';
import {
  MAX_NAME, MAX_TILES, TILES_KEY, addTile, browserUrl, cleanName, isTileKey, loadTiles, removeTile, saveTiles, tileKey, tileLabel, tilesFor, updateTile, urlLabel, type LocalTile,
} from '../web/src/components/consoles/canvasTiles.ts';

const APP = 'http://127.0.0.1:4317';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } } as unknown as Storage;
}

const tile = (id: string, extra: Partial<LocalTile> = {}): LocalTile => ({ id, kind: 'blank', project: 'p', createdAt: 1, ...extra });

describe('browserUrl', () => {
  it('accepts a local dev server, adding http:// when it was left out', () => {
    expect(browserUrl('localhost:3000', APP)).toEqual({ ok: true, url: 'http://localhost:3000/' });
    expect(browserUrl(' http://127.0.0.1:5173/app?x=1 ', APP)).toEqual({ ok: true, url: 'http://127.0.0.1:5173/app?x=1' });
  });
  it('accepts websites, defaults to HTTPS, and keeps explicit protocols and ports', () => {
    expect(browserUrl('example.com/docs?q=tiles#browser', APP)).toEqual({ ok: true, url: 'https://example.com/docs?q=tiles#browser' });
    expect(browserUrl('https://localhost:3000', APP)).toEqual({ ok: true, url: 'https://localhost:3000/' });
    expect(browserUrl('http://192.168.1.5:3000', APP)).toEqual({ ok: true, url: 'http://192.168.1.5:3000/' });
    expect(browserUrl('https://example.com:4317', APP).ok).toBe(true);
  });
  it('refuses unsafe schemes, URL credentials, malformed and oversized addresses', () => {
    for (const bad of ['', 'javascript:alert(1)', 'file:///c:/x', 'data:text/html,hello', 'ftp://example.com', 'https://user:secret@example.com', 'https://hello world', 'x'.repeat(2049)]) {
      expect(browserUrl(bad, APP).ok).toBe(false);
    }
  });
  it('refuses Waystation itself, so a framed copy cannot read the token', () => {
    const result = browserUrl('127.0.0.1:4317', APP);
    expect(result.ok).toBe(false);
    expect(browserUrl('localhost:4317', APP).ok).toBe(false);
    expect(browserUrl('[::1]:4317', APP).ok).toBe(false);
  });
  it('labels a tile by host', () => {
    expect(urlLabel('http://localhost:3000/a')).toBe('localhost:3000');
    expect(urlLabel(undefined)).toBe('browser');
  });
});

describe('tile list changes', () => {
  it('keys tiles apart from sessions', () => {
    expect(isTileKey(tileKey('x'))).toBe(true);
    expect(isTileKey('console:x')).toBe(false);
  });
  it('adds, updates and removes without mutating, and caps the count', () => {
    const one = [tile('a')];
    const two = addTile(one, tile('b'));
    expect(one).toHaveLength(1);
    expect(updateTile(two, 'b', { kind: 'browser', url: 'http://localhost:3000/' })[1]).toMatchObject({ kind: 'browser', url: 'http://localhost:3000/' });
    expect(two[1]!.kind).toBe('blank');
    expect(removeTile(two, 'a').map((t) => t.id)).toEqual(['b']);
    const many = Array.from({ length: MAX_TILES + 5 }, (_, i) => tile(`t${i}`)).reduce<readonly LocalTile[]>((list, t) => addTile(list, t), []);
    expect(many).toHaveLength(MAX_TILES);
    expect(many[MAX_TILES - 1]!.id).toBe(`t${MAX_TILES + 4}`);
  });
  it('shows a project only its own tiles, and every tile on the all-projects canvas', () => {
    const tiles = [tile('a', { project: 'one' }), tile('b', { project: 'two' })];
    expect(tilesFor(tiles, 'one', false).map((t) => t.id)).toEqual(['a']);
    expect(tilesFor(tiles, 'all', true)).toHaveLength(2);
  });
});

describe('loadTiles / saveTiles', () => {
  it('keeps a worktree tile and its selected folder through storage', () => {
    const storage = fakeStorage();
    const tiles = [tile('worktree', { kind: 'worktree', root: 'C:/repo', path: 'C:/repo--feature', name: 'Branches' })];
    expect(saveTiles(tiles, storage)).toBe(true);
    expect(loadTiles(APP, storage)).toEqual(tiles);
    expect(tileLabel(tile('worktree', { kind: 'worktree' }))).toBe('Worktrees');
  });
  it('round-trips through storage', () => {
    const storage = fakeStorage();
    const tiles = [tile('a'), tile('b', { kind: 'browser', url: 'http://localhost:3000/' }), tile('c', { kind: 'browser', url: 'https://example.com/' })];
    expect(saveTiles(tiles, storage)).toBe(true);
    expect(loadTiles(APP, storage)).toEqual(tiles);
  });
  it('drops malformed entries and duplicate ids, and turns a stored unsafe page back into a blank tile', () => {
    const raw = JSON.stringify([
      { id: 'a', kind: 'blank', project: 'p', createdAt: 1 },
      { id: 'a', kind: 'blank', project: 'p', createdAt: 2 },
      { id: 'evil', kind: 'browser', project: 'p', url: 'javascript:alert(1)', createdAt: 1 },
      { id: 'self', kind: 'browser', project: 'p', url: `${APP}/`, createdAt: 1 },
      { id: 'x', kind: 'rocket', project: 'p' }, { kind: 'blank' }, null, 7,
    ]);
    const loaded = loadTiles(APP, fakeStorage({ [TILES_KEY]: raw }));
    expect(loaded.map((t) => [t.id, t.kind, t.url])).toEqual([['a', 'blank', undefined], ['evil', 'blank', undefined], ['self', 'blank', undefined]]);
  });
  it('never throws on broken JSON or blocked storage', () => {
    expect(loadTiles(APP, fakeStorage({ [TILES_KEY]: '{nope' }))).toEqual([]);
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    expect(loadTiles(APP, blocked)).toEqual([]);
    expect(saveTiles([], blocked)).toBe(false);
  });
});

describe('names and file tiles', () => {
  it('labels a tile by its name, else by what it shows', () => {
    expect(tileLabel(tile('a'))).toBe('New tile');
    expect(tileLabel(tile('a', { kind: 'browser', url: 'http://localhost:3000/' }))).toBe('web');
    expect(tileLabel(tile('a', { kind: 'file', root: 'C:/p', path: 'src/model.py' }))).toBe('model.py');
    expect(tileLabel(tile('a', { kind: 'file', root: 'C:/p', path: 'src/model.py', name: 'Model' }))).toBe('Model');
  });
  it('trims and caps names, and an empty rename clears the name', () => {
    expect(cleanName('  Notes  ')).toBe('Notes');
    expect(cleanName('   ')).toBeUndefined();
    expect(cleanName('x'.repeat(200))).toHaveLength(MAX_NAME);
    const named = updateTile([tile('a', { name: 'Old' })], 'a', { name: '  New  ' });
    expect(named[0]!.name).toBe('New');
    const cleared = updateTile(named, 'a', { name: ' ' });
    expect(cleared[0]).not.toHaveProperty('name');
    expect(updateTile(named, 'a', { kind: 'browser', url: 'http://localhost:1/' })[0]!.name).toBe('New');
  });
  it('keeps a stored file tile, and turns one with a bad path back into a blank tile', () => {
    const raw = JSON.stringify([
      { id: 'f', kind: 'file', project: 'p', root: 'C:/proj', path: 'nb/analysis.ipynb', name: '  Analysis ', createdAt: 1 },
      { id: 'up', kind: 'file', project: 'p', root: 'C:/proj', path: '../secret.txt', createdAt: 1 },
      { id: 'none', kind: 'file', project: 'p', createdAt: 1 },
    ]);
    const loaded = loadTiles(APP, fakeStorage({ [TILES_KEY]: raw }));
    expect(loaded[0]).toEqual({ id: 'f', kind: 'file', project: 'p', root: 'C:/proj', path: 'nb/analysis.ipynb', name: 'Analysis', createdAt: 1 });
    expect(loaded.slice(1).map((t) => t.kind)).toEqual(['blank', 'blank']);
  });
});
