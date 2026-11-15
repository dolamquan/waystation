import { useCallback, useEffect, useRef, useState } from 'react';
import { constrainPlanning, emptyPlanning, parsePlanning, PLANNING_KEY, readPlanning, type PlanningDocument } from './planningBoard.ts';
import { sketchApi } from './canvasApi.ts';
import { ALL_PROJECTS } from './ProjectStrip.tsx';

/** How often the board looks for sketch changes made by agents (through update_sketch). */
const SKETCH_POLL_MS = 2000;
/** What the board last agreed with the daemon on: its revision and the sketch at that revision. */
type ServerState = { readonly project: string; readonly revision: number; readonly synced: string };

type History = { current: PlanningDocument; past: readonly PlanningDocument[]; future: readonly PlanningDocument[]; unreadable?: string; conflict?: PlanningDocument };
const initial = (project: string): History => { const loaded = readPlanning(project); return { current: loaded.doc, unreadable: loaded.unreadable, past: [], future: [] }; };

export function usePlanningBoard(project: string, notify: (text: string, kind?: 'ok' | 'error') => void) {
  const [scope, setScope] = useState(() => ({ project, history: initial(project) }));
  // Switch synchronously: a debounced save must never write the previous project's content into this one.
  if (scope.project !== project) setScope({ project, history: initial(project) });
  const history = scope.project === project ? scope.history : initial(project);
  const [saveState, setSaveState] = useState('Saved locally');
  const pending = useRef(new Map<string, PlanningDocument>());
  const persist = useCallback((key: string, doc: PlanningDocument) => {
    try {
      localStorage.setItem(PLANNING_KEY + key, JSON.stringify(doc));
      if (pending.current.get(key) === doc) pending.current.delete(key);
      setSaveState('Saved locally');
    }
    catch { setSaveState('Not saved'); }
  }, []);
  /*
   * The daemon keeps the shared copy, so agents can read and draw on the sketch. The browser copy above stays the
   * instant save (and the fallback when the daemon is unreachable); the daemon copy follows it by revision.
   */
  const server = useRef<ServerState | undefined>(undefined);
  const latest = useRef(history.current);
  latest.current = history.current;
  const shared = project !== ALL_PROJECTS;
  const pushing = useRef<{ running: boolean; again: boolean }>({ running: false, again: false });
  /** Sends the newest sketch if it differs from what the daemon has; one request at a time, then once more if it changed meanwhile. */
  const push = useCallback(async () => {
    const state = server.current;
    if (!state || state.project !== project) return;
    if (pushing.current.running) { pushing.current.again = true; return; }
    const doc = latest.current;
    const json = JSON.stringify(doc);
    if (json === state.synced) return;
    pushing.current.running = true;
    try {
      const result = await sketchApi.save(project, doc, state.revision);
      if (server.current?.project !== project) return;
      if (result.ok) { server.current = { project, revision: result.revision, synced: json }; setSaveState('Saved'); }
      else {
        // Someone (an agent) saved first: keep both and let the operator choose, as for another window's change.
        server.current = { project, revision: result.revision, synced: JSON.stringify(result.doc) };
        setScope((previous) => previous.project !== project ? previous : { project, history: { ...previous.history, conflict: result.doc } });
      }
    } catch { setSaveState('Saved in this browser'); }
    finally {
      pushing.current.running = false;
      if (pushing.current.again) { pushing.current.again = false; void push(); }
    }
  }, [project]);
  useEffect(() => {
    if (history.unreadable !== undefined || history.conflict) { pending.current.delete(project); return; }
    pending.current.set(project, history.current);
    setSaveState('Saving…');
    const timer = setTimeout(() => { persist(project, history.current); if (shared) void push(); }, 350);
    return () => clearTimeout(timer);
  }, [project, history.current, history.unreadable, history.conflict, persist, push, shared]);
  /** Load the daemon's sketch, then follow it: agent edits appear on the board (and can be undone like any change). */
  useEffect(() => {
    server.current = undefined;
    if (!shared) return undefined;
    let stopped = false;
    const adopt = (doc: PlanningDocument) => setScope((previous) => {
      if (previous.project !== project) return previous;
      const h = previous.history;
      return { project, history: { ...h, current: doc, past: [...h.past, h.current].slice(-40), future: [] } };
    });
    const tick = async () => {
      let snapshot;
      try { snapshot = await sketchApi.get(project); } catch { return; /* daemon unreachable: the browser copy carries on */ }
      if (stopped) return;
      const incoming = JSON.stringify(snapshot.doc);
      const local = JSON.stringify(latest.current);
      const known = server.current;
      if (!known) {
        // First contact. An empty daemon copy takes this browser's sketch; otherwise the daemon's copy is the truth
        // (the browser's version stays one undo step away).
        if (snapshot.revision === 0) { server.current = { project, revision: 0, synced: JSON.stringify(emptyPlanning()) }; void push(); }
        else { server.current = { project, revision: snapshot.revision, synced: incoming }; if (incoming !== local) adopt(snapshot.doc); }
        return;
      }
      if (snapshot.revision <= known.revision) return;
      const dirty = local !== known.synced;
      server.current = { project, revision: snapshot.revision, synced: incoming };
      if (incoming === local) return;
      if (dirty) { setScope((previous) => previous.project !== project ? previous : { project, history: { ...previous.history, conflict: snapshot.doc } }); return; }
      adopt(snapshot.doc);
      if (snapshot.changedBy && snapshot.changedBy !== 'operator') notify('An agent updated the sketch. Ctrl+Z undoes it.');
    };
    void tick();
    const timer = setInterval(() => { if (!document.hidden) void tick(); }, SKETCH_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [project, shared, push, notify]);
  useEffect(() => () => {
    const doc = pending.current.get(project);
    if (doc) persist(project, doc);
  }, [project, persist]);
  useEffect(() => {
    const save = () => { for (const [key, doc] of pending.current) persist(key, doc); };
    window.addEventListener('pagehide', save);
    return () => { save(); window.removeEventListener('pagehide', save); };
  }, [persist]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== PLANNING_KEY + project || !event.newValue) return;
      try {
        const incoming = parsePlanning(JSON.parse(event.newValue));
        const dirty = pending.current.has(project);
        pending.current.delete(project);
        setScope((previous) => {
          if (previous.project !== project) return previous;
          const h = previous.history;
          if (JSON.stringify(h.current) === event.newValue) return previous;
          if (h.unreadable !== undefined || h.conflict || dirty) return { project, history: { ...h, conflict: incoming } };
          return { project, history: { current: incoming, past: [...h.past, h.current].slice(-40), future: [] } };
        });
      } catch { /* Ignore malformed changes from other windows. */ }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [project, notify]);
  const change = useCallback((fn: (doc: PlanningDocument) => PlanningDocument) => {
    setScope((previous) => {
      const h = previous.project === project ? previous.history : initial(project);
      if (h.unreadable !== undefined) return previous;
      const current = fn(h.current);
      if (current === h.current) return previous;
      return { project, history: { ...h, current: constrainPlanning(current), past: [...h.past, h.current].slice(-40), future: [] } };
    });
  }, [project]);
  /** Saves the current board as one undo step, before a drag that then changes it with `move`. */
  const checkpoint = useCallback(() => setScope((previous) => {
    if (previous.project !== project || previous.history.unreadable !== undefined) return previous;
    const h = previous.history;
    return { project, history: { ...h, past: [...h.past, h.current].slice(-40), future: [] } };
  }), [project]);
  /** A change that is not its own undo step (a drag in progress); call `checkpoint` once before it starts. */
  const move = useCallback((fn: (doc: PlanningDocument) => PlanningDocument) => setScope((previous) => {
    if (previous.project !== project || previous.history.unreadable !== undefined) return previous;
    const h = previous.history;
    const current = fn(h.current);
    return current === h.current ? previous : { project, history: { ...h, current: constrainPlanning(current) } };
  }), [project]);
  const travel = (back: boolean) => setScope((previous) => {
    if (previous.project !== project || previous.history.unreadable !== undefined) return previous;
    const h = previous.history, source = back ? h.past : h.future;
    const current = source.at(-1);
    if (!current) return previous;
    return { project, history: back ? { ...h, current, past: h.past.slice(0, -1), future: [...h.future, h.current] }
      : { ...h, current, past: [...h.past, h.current], future: h.future.slice(0, -1) } };
  });
  const resolveConflict = (useIncoming: boolean) => setScope((previous) => {
    if (previous.project !== project) return previous;
    const h = previous.history;
    if (!h.conflict) return previous;
    return { project, history: { ...h, unreadable: undefined, conflict: undefined,
      ...(useIncoming ? { current: h.conflict, past: [...h.past, h.current].slice(-40), future: [] } : {}) } };
  });
  const resetUnreadable = () => setScope({ project, history: { current: { version: 1, title: 'Untitled canvas', nodes: [] }, past: [], future: [] } });
  return { doc: history.current, change, checkpoint, move, undo: () => travel(true), redo: () => travel(false),
    canUndo: history.past.length > 0, canRedo: history.future.length > 0,
    saveState: history.unreadable !== undefined ? 'Saved data needs recovery' : history.conflict ? 'Choose a canvas version' : saveState,
    unreadable: history.unreadable, conflict: history.conflict, resolveConflict, resetUnreadable };
}
