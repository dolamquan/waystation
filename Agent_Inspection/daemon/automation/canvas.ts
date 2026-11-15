import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { TowerStore } from '../store/db.ts';
import { LibraryInputError } from '../library/types.ts';
import { browserUrl, MAX_ORCHESTRATOR_TEAMS, MAX_TILES, readTile, type LocalTile } from '../../shared/canvasTiles.ts';
import { folderRoot } from '../files/folderFiles.ts';
import { resolveInsideCwd } from '../outputs/pathSafety.ts';

/** Shared by the UI and MCP. Per-tile mutations never replace another client's whole board. */
export class CanvasStore extends EventEmitter {
  origin = 'http://127.0.0.1:4317';
  constructor(private readonly store: TowerStore) { super(); }

  list(): LocalTile[] { return this.store.loadRecords<LocalTile>('canvas_tiles'); }
  require(id: unknown): LocalTile {
    const tile = this.list().find(tile => tile.id === id);
    if (!tile) throw new LibraryInputError('Tile not found. List tiles to find its id.');
    return tile;
  }

  private validate(raw: Record<string, unknown>): LocalTile {
    if (typeof raw.project !== 'string' || !raw.project || raw.project.length > 1100) throw new LibraryInputError('A canvas project key is required.');
    if (typeof raw.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.id)) throw new LibraryInputError('Invalid tile id.');
    if (!['blank', 'browser', 'file', 'note', 'orchestrator', 'worktree'].includes(String(raw.kind))) throw new LibraryInputError('Unknown tile kind.');
    if (raw.teams !== undefined && (!Array.isArray(raw.teams) || raw.teams.length > MAX_ORCHESTRATOR_TEAMS || raw.teams.some(id => typeof id !== 'string')))
      throw new LibraryInputError(`An orchestrator's teams must be a list of at most ${MAX_ORCHESTRATOR_TEAMS} team ids.`);
    if (raw.agents !== undefined && (!Array.isArray(raw.agents) || raw.agents.length > MAX_ORCHESTRATOR_TEAMS || raw.agents.some(key => typeof key !== 'string')))
      throw new LibraryInputError(`An orchestrator's agents must be a list of at most ${MAX_ORCHESTRATOR_TEAMS} agent keys.`);
    if (raw.content !== undefined && (typeof raw.content !== 'string' || raw.content.length > 100_000)) throw new LibraryInputError('Note content must be text of at most 100000 characters.');
    if (raw.name !== undefined && typeof raw.name !== 'string') throw new LibraryInputError('Tile name must be text.');
    if (raw.kind === 'browser') {
      const checked = browserUrl(typeof raw.url === 'string' ? raw.url : '', this.origin);
      if (!checked.ok) throw new LibraryInputError(checked.reason);
    }
    if (raw.kind === 'worktree') {
      try { raw = { ...raw, root: folderRoot(raw.root), path: folderRoot(raw.path) }; }
      catch (error) { throw new LibraryInputError((error as Error).message); }
    }
    if (raw.kind === 'file') {
      try {
        const root = folderRoot(raw.root);
        const safe = resolveInsideCwd(root, raw.path);
        if (!safe.exists) throw new Error('That file does not exist.');
        raw = { ...raw, root, path: safe.rel };
      } catch (error) { throw new LibraryInputError((error as Error).message); }
    }
    const tile = readTile(raw, this.origin);
    if (!tile || tile.kind !== raw.kind) throw new LibraryInputError('Invalid tile contents.');
    return tile;
  }

  create(raw: Record<string, unknown>, actor = 'operator'): LocalTile {
    if (this.list().length >= MAX_TILES) throw new LibraryInputError(`The canvas has ${MAX_TILES} tiles. Close a tile before adding another.`);
    const tile = this.validate({ ...raw, id: raw.id ?? randomUUID(), createdAt: Date.now() });
    if (this.list().some(existing => existing.id === tile.id)) throw new LibraryInputError('Tile id already exists.');
    this.store.saveRecord('canvas_tiles', tile);
    this.store.audit('canvas_create', tile.id, { actor, kind: tile.kind, project: tile.project });
    this.emit('changed', tile);
    return tile;
  }

  update(id: unknown, patch: Record<string, unknown>, actor = 'operator'): LocalTile {
    const previous = this.require(id);
    const { expectedContent, ...changes } = patch;
    if (expectedContent !== undefined && (typeof expectedContent !== 'string' || previous.content !== expectedContent)) throw new LibraryInputError('This note changed while you were editing. Copy your edits before reopening it.');
    const allowed = ['kind', 'name', 'url', 'root', 'path', 'content', 'teams', 'agents'];
    if (Object.keys(changes).some(key => !allowed.includes(key))) throw new LibraryInputError('Unknown tile property.');
    const tile = this.validate({ ...previous, ...changes });
    this.store.saveRecord('canvas_tiles', tile);
    this.store.audit('canvas_update', tile.id, { actor, fields: Object.keys(patch) });
    this.emit('changed', tile);
    return tile;
  }

  remove(id: unknown, actor = 'operator'): void {
    const tile = this.require(id);
    this.store.deleteRecord('canvas_tiles', tile.id);
    this.store.audit('canvas_close', tile.id, { actor, kind: tile.kind });
    this.emit('removed', tile.id);
  }
}
