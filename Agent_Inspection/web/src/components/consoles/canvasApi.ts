import { request } from '../../api.ts';
import type { LocalTile, TilePatch } from './canvasTiles.ts';
import type { PlanningDocument } from './planningBoard.ts';

export const canvasApi = {
  list: () => request<{ tiles: LocalTile[] }>('GET', '/api/canvas/tiles'),
  import: (tiles: readonly LocalTile[]) => request<{ tiles: LocalTile[]; rejected: string[] }>('POST', '/api/canvas/import', { tiles }),
  create: (tile: LocalTile) => request<{ tile: LocalTile }>('POST', '/api/canvas/tiles', tile),
  update: (id: string, patch: TilePatch, expectedContent?: string) => request<{ tile: LocalTile }>('POST', `/api/canvas/tiles/${encodeURIComponent(id)}`, { ...patch, ...(expectedContent === undefined ? {} : { expectedContent }) }),
  close: (id: string) => request('POST', `/api/canvas/tiles/${encodeURIComponent(id)}/close`),
};

/** The daemon's copy of a project's planning sketch, shared with agents (get_sketch / update_sketch). */
export interface SketchSnapshot { readonly project: string; readonly doc: PlanningDocument; readonly revision: number; readonly changedBy?: string }
export const sketchApi = {
  get: (project: string) => request<SketchSnapshot>('GET', `/api/sketch/${encodeURIComponent(project)}`),
  /** `ok: false` (with the newer sketch) when someone else saved since `baseRevision`. */
  save: (project: string, doc: PlanningDocument, baseRevision: number) =>
    request<SketchSnapshot & { readonly ok: boolean }>('POST', `/api/sketch/${encodeURIComponent(project)}`, { doc, baseRevision }),
};
