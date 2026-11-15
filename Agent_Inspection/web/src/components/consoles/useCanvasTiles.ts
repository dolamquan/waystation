import { useCallback, useEffect, useRef, useState } from 'react';
import { addTile, cleanName, loadTiles, removeTile, TILES_KEY, updateTile, type LocalTile, type TilePatch } from './canvasTiles.ts';
import { canvasApi } from './canvasApi.ts';

/** Daemon-owned tiles. Serialize this window's writes; never push a stale whole-board snapshot. */
export function useCanvasTiles(notify: (text: string, kind?: 'ok' | 'error') => void) {
  const [tiles, setTiles] = useState<readonly LocalTile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const notifyRef = useRef(notify); notifyRef.current = notify;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const generation = useRef(0);
  const mounted = useRef(false);
  const initializing = useRef(true);
  const bootstrapped = useRef(false);

  const refresh = useCallback(async () => {
    if (pending.current) return;
    const version = generation.current;
    const result = await canvasApi.list();
    if (mounted.current && !pending.current && version === generation.current) { setTiles(result.tiles); if (bootstrapped.current) setLoaded(true); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const init = async () => {
      const legacy = loadTiles(location.origin);
      if (legacy.length) {
        const result = await canvasApi.import(legacy);
        // Keep a recovery copy, retire the live key so a later mount cannot resurrect closed tiles.
        try { localStorage.setItem(`${TILES_KEY}-backup`, JSON.stringify(legacy)); localStorage.removeItem(TILES_KEY); } catch { /* Storage blocked. */ }
        if (result.rejected.length) notifyRef.current('Some saved tiles could not be imported. A browser recovery copy was kept.', 'error');
      }
      bootstrapped.current = true;
      await refresh();
    };
    let warned = false;
    const initialize = () => {
      initializing.current = true;
      queue.current = queue.current.then(init).catch(error => { if (mounted.current && !warned) { warned = true; notifyRef.current(`Could not load canvas tiles: ${error.message}`, 'error'); } }).finally(() => { initializing.current = false; });
    };
    initialize();
    const timer = setInterval(() => {
      if (initializing.current) return;
      if (!bootstrapped.current) initialize(); else void refresh().catch(() => undefined);
    }, 1000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [refresh]);

  const mutate = useCallback((change: (current: readonly LocalTile[]) => readonly LocalTile[], save: () => Promise<unknown>) => {
    generation.current += 1; pending.current += 1;
    setTiles(change);
    queue.current = queue.current.then(save).catch(error => {
      if (mounted.current) notifyRef.current(`Tile could not be saved: ${error.message}`, 'error');
    }).finally(async () => { pending.current -= 1; await refresh().catch(() => undefined); });
  }, [refresh]);

  /** A blank tile, or an orchestrator when asked for one (it needs no chooser). */
  const create = useCallback((project: string, init: { readonly kind?: 'blank' | 'orchestrator'; readonly name?: string } = {}): string => {
    const name = cleanName(init.name);
    const tile: LocalTile = {
      id: crypto.randomUUID(), kind: init.kind ?? 'blank', project, createdAt: Date.now(),
      ...(name ? { name } : {}), ...(init.kind === 'orchestrator' ? { teams: [], agents: [] } : {}),
    };
    mutate(current => addTile(current, tile), () => canvasApi.create(tile));
    return tile.id;
  }, [mutate]);
  const remove = useCallback((id: string) => mutate(current => removeTile(current, id), () => canvasApi.close(id)), [mutate]);
  const patch = useCallback((id: string, patch: TilePatch) => mutate(current => updateTile(current, id, patch), () => canvasApi.update(id, patch)), [mutate]);
  const rename = useCallback((id: string, name: string) => patch(id, { name }), [patch]);
  const showPage = useCallback((id: string, url: string, name?: string) => patch(id, { kind: 'browser', url, ...(cleanName(name) ? { name } : {}) }), [patch]);
  const showFile = useCallback((id: string, root: string, path: string, name?: string) => patch(id, { kind: 'file', root, path, ...(cleanName(name) ? { name } : {}) }), [patch]);
  const showWorktree = useCallback((id: string, root: string, path: string, name?: string) => patch(id, { kind: 'worktree', root, path, ...(cleanName(name) ? { name } : {}) }), [patch]);
  const orchestrate = useCallback((id: string, name?: string) => patch(id, { kind: 'orchestrator', teams: [], agents: [], ...(cleanName(name) ? { name } : {}) }), [patch]);
  /** What an orchestrator directs: the teams and single agents wired to it with Connect. */
  const setWiring = useCallback((id: string, wiring: { readonly teams: readonly string[]; readonly agents: readonly string[] }) =>
    patch(id, { teams: wiring.teams, agents: wiring.agents }), [patch]);
  return { tiles, loaded, create, remove, rename, showPage, showFile, showWorktree, orchestrate, setWiring };
}
