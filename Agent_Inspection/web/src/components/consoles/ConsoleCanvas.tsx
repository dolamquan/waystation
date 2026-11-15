import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { AgentEvent, ConsoleInfo, ConsoleKind } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import {
  bringToFront, clampRect, fitAll, freePlacement, loadCanvas, markUpgraded, moveRect, panViewport, reconcile, resizeRect, saveCanvas,
  screenToWorld, setViewport, tidyGrid, viewportFor, zoomAbout,
  DEFAULT_VIEWPORT, MAX_ZOOM, TILE_HEIGHT, TILE_WIDTH, type CanvasState, type Point, type Rect, type Viewport,
} from './canvasLayout.ts';
import { LocalTileBody, LocalTileHeader } from './CanvasLocalTile.tsx';
import { isTileKey, tileKey as localTileKey, tileLabel, tilesFor, type LocalTile } from './canvasTiles.ts';
import { OrchestratorPanel } from './OrchestratorPanel.tsx';
import { OrchestratorLinkLayer, orchestratorTone } from './OrchestratorLinkLayer.tsx';
import { orchestratorLinks } from './orchestratorLinks.ts';
import { OrchestratorConnectLayer } from './OrchestratorConnectLayer.tsx';
import { buildRoster, type Wired } from './orchestration.ts';
import { ALL_PROJECTS } from './ProjectStrip.tsx';
import { useCanvasTiles } from './useCanvasTiles.ts';
import type { CanvasReveal } from '../../../../shared/canvasReveal.ts';
import './consoleCanvas.css';
import { ConsoleHeader } from './ConsoleHeader.tsx';
import { BoardItemBody } from './BoardItemBody.tsx';
import { itemName, itemStatus, type BoardItem } from './boardItems.ts';
import { addGroup, groupFrame, type CanvasGroup } from './canvasGroups.ts';
import { keysInMarquee, marqueeRect, moveTogether } from './canvasMarquee.ts';
import { CanvasDock } from './CanvasDock.tsx';
import { HandoffDialog } from './HandoffDialog.tsx';
import { TeamLayer } from './TeamLayer.tsx';
import { ManagedTeamLayer } from './ManagedTeamLayer.tsx';
import type { ManagedTeamFrame } from './managedTeams.ts';
import { agentConsoles, sendTeamKeys } from './teamActions.ts';
import './teams.css';
import { usePlanningBoard } from './usePlanningBoard.ts';
import type { PlanningDocument } from './planningBoard.ts';

const NOTE_PREFIX = 'note:';
const noteKey = (id: string): string => NOTE_PREFIX + id;
const isNoteKey = (key: string): boolean => key.startsWith(NOTE_PREFIX);
const noteIdOf = (key: string): string => key.slice(NOTE_PREFIX.length);
import { PlanningLayer } from './PlanningLayer.tsx';
import { markRevealHandled, revealHandled } from './canvasReveals.ts';
import './canvasLive.css';

/*
 * Zoom decision: everything scales, like a map. Each tile's position and size are multiplied by the zoom, and so is
 * what is inside it: the title bar and agent feed through the CSS `zoom` property (set from --canvas-zoom), a terminal
 * through its font size. The stage is NOT CSS-transformed: xterm.js computes mouse selection from getBoundingClientRect
 * against unscaled cell sizes and FitAddon measures with offset sizes, so a transform breaks both. Scaling the font
 * instead keeps the same columns and rows in view at any zoom, so zooming does not reflow the program in the terminal.
 */

const SAVE_DELAY_MS = 300;
const KEY_STEP = 24;
const BUTTON_ZOOM = 1.2;
const WHEEL_SENSITIVITY = 0.0015;
const PINCH_SENSITIVITY = 0.01;

const DOT_SPACING = 28;
/** Orchestrator tiles are tall and narrow: a roster above a composer. */
const ORCHESTRATOR_WIDTH = 520;
const ORCHESTRATOR_HEIGHT = 720;
const MIN_DOT_STEP = 14;

/** Screen distance between backdrop dots. Far out, every other dot is dropped (repeatedly) so the grid never turns to noise. */
function dotStep(zoom: number): number {
  let step = DOT_SPACING * zoom;
  while (step < MIN_DOT_STEP) step *= 2;
  return step;
}

type Gesture =(dx: number, dy: number) => void;

/** Follows the pointer on the window until release, so a fast drag cannot outrun the element that started it. */
function trackPointer(start: ReactPointerEvent, apply: Gesture): void {
  const { clientX, clientY } = start;
  const move = (event: PointerEvent) => apply(event.clientX - clientX, event.clientY - clientY);
  // A browser tile's frame would swallow the pointer as soon as the drag passed over it; this switches frames off meanwhile.
  document.body.classList.add('canvas-dragging');
  const end = () => {
    document.body.classList.remove('canvas-dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

/** The canvas keeps its own geometry (persisted separately, keyed by item key); the board only says which items exist. */
export function ConsoleCanvas({
  projectKey, projectName, defaultCwd, items, itemsReady = true, allKeys, now, lastEvent, notify, onFocus, onClose, onDetails, onOpenAsTerminal, groups, onGroupsChange,
  onOpenConsole, onRename, onSpawnTeam, tileRequest, onTileRequestDone, canvasReveal, managedTeams = [], onOpenTeam,
}: {
  /** Waystation-run teams with members on this canvas, framed around their tiles. */
  readonly managedTeams?: readonly ManagedTeamFrame[];
  /** Opens a Waystation-run team's tasks, conversation and outputs. */
  readonly onOpenTeam?: (teamId: string) => void;
  readonly canvasReveal?: CanvasReveal;
  readonly itemsReady?: boolean;
  /** Teams drawn as frames around their tiles; owned (and saved) by the board. */
  readonly groups: readonly CanvasGroup[];
  readonly onGroupsChange: (next: readonly CanvasGroup[]) => void;
  /** Opens a console (agent or shell) for a tile; resolves with it, or undefined when it could not open (already reported). */
  readonly onOpenConsole: (kind: ConsoleKind, cwd: string, name?: string) => Promise<ConsoleInfo | undefined>;
  /** Renames a console or agent tile (local tiles rename themselves). */
  readonly onRename: (item: BoardItem, name: string) => Promise<void>;
  readonly onSpawnTeam: () => void;
  /** Bumped by the board's "New tile" button; the canvas makes a tile and calls onTileRequestDone. */
  readonly tileRequest: number;
  readonly onTileRequestDone: () => void;
  /** The project whose canvas this is: it owns its own pan and zoom. */
  readonly projectKey: string;
  /** Shown in the orchestrator and used to name its hub channel. */
  readonly projectName: string;
  /** Where a tile's new agent or console starts unless the operator picks another folder. */
  readonly defaultCwd: string;
  /** The visible project's items. */
  readonly items: readonly BoardItem[];
  /** Every live item key, so other projects keep their geometry while this one is shown. */
  readonly allKeys: readonly string[];
  readonly now: number;
  readonly lastEvent: AgentEvent | undefined;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
  readonly onFocus: (item: BoardItem) => void;
  readonly onClose: (item: BoardItem) => void;
  readonly onDetails: (agentId: string) => void;
  readonly onOpenAsTerminal: (agentId: string) => void;
}) {
  const [saved, setSaved] = useState<CanvasState>(() => loadCanvas());
  const [panning, setPanning] = useState(false);
  const [activeId, setActiveId] = useState<string>();
  /** Tiles shift-clicked for "Group"; only keys still on this canvas count. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  /** Selected planning objects (notes, text, shapes, images, drawings), by id; shared with the planning layer. */
  const [noteSelection, setNoteSelection] = useState<readonly string[]>([]);
  /** The selection box dragged across empty space, in stage pixels, while it is being drawn. */
  const [marquee, setMarquee] = useState<Rect>();
  /** Open handoff dialog, with the console it starts from. */
  const [handoff, setHandoff] = useState<{ readonly from?: string }>();
  /** The orchestrator tile in Connect mode: clicking agents and teams on the stage wires them to it. */
  const [connecting, setConnecting] = useState<string>();
  /** Blank tiles spawned from an orchestrator, by tile id: the console each becomes is wired to that orchestrator. */
  const spawnedFor = useRef<Record<string, string>>({});
  /** Where a tile that has not been placed yet should go: a new tile where it was asked for, a console where its tile was. */
  const [placements, setPlacements] = useState<Readonly<Record<string, Rect>>>({});
  const localTiles = useCanvasTiles(notify);
  const tilesHere = tilesFor(localTiles.tiles, projectKey, projectKey === ALL_PROJECTS);
  const stage = useRef<HTMLDivElement>(null);
  const planning = usePlanningBoard(projectKey, notify);
  /** Planning objects in world coordinates, keyed `note:<id>` so the selection box and group moves treat them like tiles. */
  const noteRects: Record<string, Rect> = Object.fromEntries(planning.doc.nodes.filter((node) => node.kind !== 'link').map((node) =>
    [noteKey(node.id), { x: node.x, y: node.y, width: node.width, height: node.height }]));
  // Each project has its own planning board, so its selection does not carry over.
  useEffect(() => { setNoteSelection([]); }, [projectKey]);
  const canvasKeys = [...allKeys, ...localTiles.tiles.map((tile) => localTileKey(tile.id))];
  const shownKeys = [...items.map((item) => item.key), ...tilesHere.map((tile) => localTileKey(tile.id))];
  const idsKey = `${projectKey}|${canvasKeys.join('|')}|${shownKeys.join('|')}`;
  const inventoryReady = itemsReady && localTiles.loaded;
  const scopeRef = useRef({ all: canvasKeys, shown: shownKeys, preferred: placements, ready: inventoryReady });
  scopeRef.current = { all: canvasKeys, shown: shownKeys, preferred: placements, ready: inventoryReady };
  const state = reconcile(saved, canvasKeys, shownKeys, placements, inventoryReady);
  const latestState = useRef(state); latestState.current = state;
  const viewport = viewportFor(state, projectKey);

  /** Always applies to geometry reconciled against the live console list, so a stale update cannot resurrect a closed tile. */
  const update = useCallback((change: (current: CanvasState) => CanvasState) => {
    setSaved((previous) => change(reconcile(previous, scopeRef.current.all, scopeRef.current.shown, scopeRef.current.preferred, scopeRef.current.ready)));
  }, []);
  /** Changes only this project's view; other projects keep theirs. */
  const changeView = useCallback((change: (view: Viewport) => Viewport) =>
    update((current) => setViewport(current, projectKey, change(viewportFor(current, projectKey)))), [update, projectKey]);

  useEffect(() => {
    const timer = setTimeout(() => saveCanvas(state), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
    // `state` is derived from `saved` and the console ids; keying on those avoids saving on every identical render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, idsKey, inventoryReady]);
  useEffect(() => {
    const flush = () => saveCanvas(latestState.current);
    window.addEventListener('pagehide', flush);
    return () => { flush(); window.removeEventListener('pagehide', flush); };
  }, []);

  const stageSize = () => {
    const box = stage.current?.getBoundingClientRect();
    return { width: box?.width ?? 0, height: box?.height ?? 0 };
  };

  /** Every shown tile as a spaced grid of full-size tiles, fitted to the stage. Team members stay next to each other, so a team's frame still wraps one block. */
  const tidied = (current: CanvasState): CanvasState => {
    const shown = scopeRef.current.shown.filter((id) => current.rects[id]);
    const teamed = [...new Set(groups.flatMap((group) => group.members.filter((id) => shown.includes(id))))];
    const ordered = [...teamed, ...shown.filter((id) => !teamed.includes(id))];
    const rects = tidyGrid(current.rects, ordered);
    return setViewport({ ...current, rects }, projectKey, fitAll(ordered.flatMap((id) => rects[id] ?? []), stageSize()));
  };

  // Migrate only save metadata. Opening the canvas must never tidy tiles or change a chosen viewport.
  useEffect(() => {
    update((current) => markUpgraded(current, projectKey));
    // Only when a project's canvas opens, not on every zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey, update]);
  const stageCenter = (): Point => ({ x: stageSize().width / 2, y: stageSize().height / 2 });
  const zoomBy = useCallback((factor: number, anchor: Point) =>
    changeView((view) => zoomAbout(view, factor, anchor)), [changeView]);

  // React attaches wheel listeners as passive, so preventing the page scroll needs a native, non-passive listener.
  useEffect(() => {
    const element = stage.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      // Plain wheel over any tile scrolls that tile (terminal scrollback or an agent's feed). Zooming from there
      // shrank the whole canvas to a sliver while the user only meant to read back.
      const overTile = event.target instanceof Element && event.target.closest('.canvas-tile, .planning-node, .planning-share, .planning-palette') !== null;
      if (overTile && !event.ctrlKey) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? PINCH_SENSITIVITY : WHEEL_SENSITIVITY));
      zoomBy(factor, { x: event.clientX - box.left, y: event.clientY - box.top });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  /** Space held down: a drag on empty space pans instead of drawing a selection box (as in design tools). */
  const spaceHeld = useRef(false);
  useEffect(() => {
    const typing = (target: EventTarget | null) => target instanceof Element
      && target.closest('.terminal-pane, .browser-page, input, textarea, select, [contenteditable="true"], [role="dialog"]') !== null;
    const down = (event: globalThis.KeyboardEvent) => {
      if (event.code !== 'Space' || typing(event.target)) return;
      spaceHeld.current = true;
      // Space on the canvas itself must not scroll the page.
      if (event.target === stage.current || event.target === document.body) event.preventDefault();
    };
    const up = (event: globalThis.KeyboardEvent) => { if (event.code === 'Space') spaceHeld.current = false; };
    const reset = () => { spaceHeld.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', reset);
    };
  }, []);

  /**
   * Like selecting icons on a desktop: drag a box across empty space and every tile it touches is selected.
   * A plain drag replaces the selection (so a plain click on empty space clears it); with Shift, Ctrl or Cmd it adds.
   */
  const startMarquee = (event: ReactPointerEvent) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box) return;
    event.preventDefault();
    const start = { x: event.clientX - box.left, y: event.clientY - box.top };
    const adding = event.shiftKey || event.ctrlKey || event.metaKey;
    const before: ReadonlySet<string> = adding ? selected : new Set();
    const notesBefore: readonly string[] = adding ? noteSelection : [];
    const view = viewport;
    // Every tile and every planning object (notes, text, shapes, images, drawings) can be selected to move together;
    // only the sessions among them can become a team.
    const rects = { ...state.rects, ...noteRects };
    const keys = [...shownKeys, ...Object.keys(noteRects)];
    setSelected(before);
    setNoteSelection(notesBefore);
    setMarquee(marqueeRect(start, 0, 0));
    trackPointer(event, (dx, dy) => {
      const rect = marqueeRect(start, dx, dy);
      setMarquee(rect);
      const hit = keysInMarquee(rect, view, rects, keys);
      setSelected(new Set([...before, ...hit.filter((key) => !isNoteKey(key))]));
      setNoteSelection([...new Set([...notesBefore, ...hit.filter(isNoteKey).map(noteIdOf)])]);
    });
    const end = () => {
      setMarquee(undefined);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  /** Drags the view; started by the pan tool, Space + drag, or a middle-button drag. */
  const startPan = (event: ReactPointerEvent) => {
    if (event.target !== event.currentTarget || (event.button !== 0 && event.button !== 1)) return;
    const origin = viewport;
    setPanning(true);
    event.preventDefault();
    trackPointer(event, (dx, dy) => changeView(() => panViewport(origin, dx, dy)));
    window.addEventListener('pointerup', () => setPanning(false), { once: true });
  };

  /** Empty space: left drag draws a selection box; Space + left drag or middle drag pans. */
  const startStageGesture = (event: ReactPointerEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.button === 1 || (event.button === 0 && spaceHeld.current)) { startPan(event); return; }
    if (event.button === 0) startMarquee(event);
  };

  const raise = (id: string) => {
    setActiveId(id);
    update((current) => ({ ...current, order: bringToFront(current.order, id) }));
  };
  const setRect = (id: string, change: (rect: Rect) => Rect) =>
    update((current) => (current.rects[id] ? { ...current, rects: { ...current.rects, [id]: change(current.rects[id]) } } : current));

  const toggleSelected = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  /** Where every selected tile and planning object starts, keyed as tiles are (`note:<id>` for planning objects). */
  const selectionOrigins = (): Record<string, Rect> => ({
    ...Object.fromEntries(shownKeys.flatMap((key) => (selected.has(key) && state.rects[key] ? [[key, state.rects[key]!]] : []))),
    ...Object.fromEntries(noteSelection.flatMap((id) => (noteRects[noteKey(id)] ? [[noteKey(id), noteRects[noteKey(id)]!]] : []))),
  });
  /** Moves the selection from `origins` by (dx, dy) world pixels, tiles and planning objects as one block. */
  const moveSelection = (origins: Readonly<Record<string, Rect>>, dx: number, dy: number, record: boolean) => {
    const moved = moveTogether(origins, dx, dy);
    update((current) => ({ ...current, rects: { ...current.rects,
      ...Object.fromEntries(Object.entries(moved).filter(([key]) => !isNoteKey(key) && current.rects[key])) } }));
    const notes = (doc: PlanningDocument): PlanningDocument => ({ ...doc, nodes: doc.nodes.map((node) => {
      const to = moved[noteKey(node.id)];
      return to ? { ...node, x: to.x, y: to.y } : node;
    }) });
    if (Object.keys(moved).some(isNoteKey)) (record ? planning.change : planning.move)(notes);
  };
  /** Carries the whole selection with the pointer, keeping its arrangement; one undo step for the planning objects. */
  const dragSelection = (event: ReactPointerEvent) => {
    const origins = selectionOrigins();
    event.preventDefault();
    if (Object.keys(origins).some(isNoteKey)) planning.checkpoint();
    trackPointer(event, (dx, dy) => moveSelection(origins, dx / viewport.zoom, dy / viewport.zoom, false));
  };
  const selectionSize = shownKeys.filter((key) => selected.has(key)).length + noteSelection.length;
  const clearSelection = () => { setSelected(new Set()); setNoteSelection([]); };
  const startDrag = (event: ReactPointerEvent, id: string) => {
    // Buttons act, and a name being edited takes the pointer for its text; neither starts a drag.
    if (event.button !== 0 || (event.target as Element).closest('button, input')) return;
    if (event.shiftKey) { event.preventDefault(); toggleSelected(id); return; }
    const origin = state.rects[id];
    if (!origin) return;
    event.preventDefault();
    // Dragging any selected tile carries the whole selection.
    if (selected.has(id) && selectionSize > 1) { dragSelection(event); return; }
    // Dragging a tile outside the selection is a plain move of that tile, and drops the selection.
    if (selectionSize > 0) clearSelection();
    trackPointer(event, (dx, dy) => setRect(id, () => moveRect(origin, dx / viewport.zoom, dy / viewport.zoom)));
  };
  /** A drag on a planning object: the canvas carries it when tiles are selected with it; otherwise the planning layer moves it. */
  const dragFromNote = (event: ReactPointerEvent, id: string): boolean => {
    if (!noteSelection.includes(id)) { if (selected.size > 0) setSelected(new Set()); return false; }
    if (!shownKeys.some((key) => selected.has(key))) return false;
    dragSelection(event);
    return true;
  };
  const startResize = (event: ReactPointerEvent, id: string) => {
    const origin = state.rects[id];
    if (event.button !== 0 || !origin) return;
    event.preventDefault();
    event.stopPropagation();
    trackPointer(event, (dx, dy) => setRect(id, () => resizeRect(origin, dx / viewport.zoom, dy / viewport.zoom)));
  };

  const tileKey = (event: KeyboardEvent, id: string) => {
    if (event.target !== event.currentTarget) return;
    const arrows: Record<string, readonly [number, number]> = {
      ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP],
    };
    const delta = arrows[event.key];
    if (!delta) return;
    event.preventDefault();
    if (!event.shiftKey && selected.has(id) && selectionSize > 1) { moveSelection(selectionOrigins(), delta[0], delta[1], true); return; }
    setRect(id, (rect) => (event.shiftKey ? resizeRect(rect, delta[0], delta[1]) : moveRect(rect, delta[0], delta[1])));
  };
  const stageKey = (event: KeyboardEvent) => {
    const target = event.target as Element;
    if (target.closest('.terminal-pane, .browser-page') || target.closest('input, textarea, select, [role="dialog"]')) return; // typing into a page or terminal is not a zoom command
    if (event.key === '+' || event.key === '=') zoomBy(BUTTON_ZOOM, stageCenter());
    else if (event.key === '-' || event.key === '_') zoomBy(1 / BUTTON_ZOOM, stageCenter());
    else if (event.key === '0') changeView(() => DEFAULT_VIEWPORT);
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      setSelected(new Set(shownKeys.filter((key) => state.rects[key])));
      setNoteSelection(planning.doc.nodes.map((node) => node.id));
    }
    else if (event.key === 'Escape' && selectionSize > 0) clearSelection();
    else return;
    event.preventDefault();
  };

  const fit = () => update((current) => {
    const size = stageSize();
    const left = size.width < 600 ? 40 : 100;
    const fitted = fitAll([...scopeRef.current.shown.flatMap((id) => current.rects[id] ?? []), ...planning.doc.nodes.filter((node) => node.kind !== 'link')],
      { width: Math.max(1, size.width - left), height: Math.max(1, size.height - 80) });
    return setViewport(current, projectKey, { ...fitted, panX: fitted.panX + left, panY: fitted.panY + 80 });
  });
  const showRect = (rect: Rect) => update((current) => setViewport(current, projectKey, fitAll([rect], stageSize())));
  /** Fills the stage with one tile, zooming in past 100% if there is room: the quick way to read a single session. */
  const zoomToTile = (id: string) => update((current) => {
    const rect = current.rects[id];
    return rect ? setViewport(current, projectKey, fitAll([rect], stageSize(), MAX_ZOOM)) : current;
  });
  const revealed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!canvasReveal || canvasReveal.project !== projectKey || revealed.current === canvasReveal.requestId || revealHandled(canvasReveal.requestId)) return;
    const id = localTileKey(canvasReveal.id);
    if (!shownKeys.includes(id)) return; // Wait for the daemon's tile list to arrive.
    revealed.current = canvasReveal.requestId;
    markRevealHandled(canvasReveal.requestId);
    setActiveId(id); zoomToTile(id);
    // Geometry is reconciled with the latest tile list by update().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasReveal, projectKey, idsKey]);
  const tidy = () => update(tidied);

  /**
   * A blank tile: centred on `at` (a world point, from a double-click), or in the first free grid slot and brought into
   * view (from the New tile button). It asks what it should become.
   */
  const newTile = (at?: Point, kind: 'blank' | 'orchestrator' = 'blank'): string => {
    const occupied = scopeRef.current.shown.flatMap((id) => state.rects[id] ?? []);
    const width = kind === 'orchestrator' ? ORCHESTRATOR_WIDTH : TILE_WIDTH;
    const height = kind === 'orchestrator' ? ORCHESTRATOR_HEIGHT : TILE_HEIGHT;
    const slot = at ? { x: at.x - width / 2, y: at.y - height / 4 } : freePlacement(occupied);
    const rect = clampRect({ x: slot.x, y: slot.y, width, height });
    const name = kind === 'orchestrator' ? `Orchestrator ${orchestratorsHere.length + 1}` : undefined;
    const id = localTiles.create(projectKey, { kind, name });
    const key = localTileKey(id);
    setPlacements((current) => ({ ...current, [key]: rect }));
    setActiveId(key);
    if (!at) showRect(rect);
    return id;
  };
  /** What an orchestrator tile has wired; a team that was ungrouped no longer counts. */
  const wiredOf = (tile: LocalTile): Wired => ({
    teams: (tile.teams ?? []).filter((id) => groups.some((group) => group.id === id)), agents: tile.agents ?? [],
  });
  /** A blank tile beside the orchestrator; the agent it becomes is wired to it. */
  const spawnFor = (orchestrator: LocalTile) => {
    const rect = state.rects[localTileKey(orchestrator.id)];
    const at = rect ? { x: rect.x + rect.width + 48 + TILE_WIDTH / 2, y: rect.y + TILE_HEIGHT / 4 } : undefined;
    spawnedFor.current = { ...spawnedFor.current, [newTile(at)]: orchestrator.id };
  };
  // The board's New tile button asks through a counter, so a remount never makes a second tile.
  useEffect(() => {
    if (tileRequest === 0) return;
    newTile();
    onTileRequestDone();
    // Only a new request counts; newTile reads the current render's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileRequest]);
  /** The tile becomes a console: the console takes the tile's place on the canvas once the daemon lists it. */
  const openFromTile = async (id: string, kind: ConsoleKind, cwd: string, name?: string): Promise<boolean> => {
    const rect = state.rects[localTileKey(id)];
    const keepTile = localTiles.tiles.some(tile => tile.id === id && tile.kind === 'worktree');
    const opened = await onOpenConsole(kind, cwd, name);
    if (!opened) return false;
    if (rect) setPlacements((current) => ({ ...current, [`console:${opened.id}`]: keepTile ? { ...rect, x: rect.x + rect.width + 32 } : rect }));
    if (!keepTile) localTiles.remove(id);
    setActiveId(`console:${opened.id}`);
    const { [id]: orchestratorId, ...rest } = spawnedFor.current;
    spawnedFor.current = rest;
    const orchestrator = localTiles.tiles.find((tile) => tile.id === orchestratorId && tile.kind === 'orchestrator');
    if (orchestrator) {
      const wired = wiredOf(orchestrator);
      localTiles.setWiring(orchestrator.id, { ...wired, agents: [...wired.agents, `console:${opened.id}`] });
    }
    return true;
  };
  const tileAt = (event: ReactMouseEvent) => {
    if (event.target !== event.currentTarget || !stage.current) return;
    const box = stage.current.getBoundingClientRect();
    newTile(screenToWorld(viewport, { x: event.clientX - box.left, y: event.clientY - box.top }));
  };

  const selectedHere = shownKeys.filter((key) => selected.has(key));
  /** Orchestrator tiles here; each directs only the teams and agents wired to it with Connect. */
  const orchestratorsHere = tilesHere.filter((tile) => tile.kind === 'orchestrator');
  const framesHere = groups.flatMap((group) => {
    if (!group.members.some((key) => shownKeys.includes(key))) return [];
    const box = groupFrame(group, state.rects);
    return box ? [{ id: group.id, frame: box }] : [];
  });
  const links = orchestratorLinks(orchestratorsHere.map((tile) => ({ key: localTileKey(tile.id), ...wiredOf(tile) })), framesHere, state.rects);
  const connectingTile = orchestratorsHere.find((tile) => tile.id === connecting);
  /** In Connect mode: every agent tile on the stage, and every team frame with an agent in it. */
  const connectTargets = () => {
    const roster = buildRoster(items, groups, {}, now);
    const agents = [...roster.teams.flatMap((team) => team.members), ...roster.solos]
      .flatMap((agent) => (state.rects[agent.key] && shownKeys.includes(agent.key) ? [{ id: agent.key, name: agent.name, rect: state.rects[agent.key]! }] : []));
    const teams = framesHere.flatMap((frame) => {
      const team = roster.teams.find((candidate) => candidate.id === frame.id);
      return team ? [{ id: team.id, name: team.name, rect: frame.frame }] : [];
    });
    return { agents, teams };
  };
  /** Only sessions can form a team; selected canvas-only tiles (notes, browsers, orchestrators) are left out of it. */
  const selectedSessions = selectedHere.filter((key) => !isTileKey(key));
  const groupSelected = () => {
    if (selectedSessions.length < 2) return;
    const id = globalThis.crypto?.randomUUID?.() ?? `team-${Date.now()}`;
    onGroupsChange(addGroup(groups, { id, name: `Team ${groups.length + 1}`, members: selectedSessions, arranged: true }));
    setSelected(new Set());
  };
  const agentsHere = agentConsoles(items);
  const runningHere = items.flatMap((item) => (item.console?.state === 'running' ? [item.console] : []));
  const percent = Math.round(viewport.zoom * 100);
  /** A tile on the stage: title bar (drag, double-click to zoom, Shift-click to select), body, resize grip. */
  const frame = (key: string, name: string, header: ReactNode, body: ReactNode, tone?: string, status?: string) => {
    const rect = state.rects[key];
    if (!rect) return null;
    const tileClass = ['console-tile', 'canvas-tile', key === activeId && 'canvas-tile-on', selected.has(key) && 'canvas-tile-selected',
      tone && 'canvas-tile-orchestrator'].filter(Boolean).join(' ');
    return <article key={key} className={tileClass} data-status={status} onPointerDownCapture={() => raise(key)}
      style={{ ...(tone ? { '--orch-tone': tone } as CSSProperties : {}),
        left: rect.x * viewport.zoom + viewport.panX, top: rect.y * viewport.zoom + viewport.panY,
        width: rect.width * viewport.zoom, height: rect.height * viewport.zoom, zIndex: state.order.indexOf(key) + 1,
      }}>
      <div className="canvas-drag" tabIndex={0} onPointerDown={(event) => startDrag(event, key)} onKeyDown={(event) => tileKey(event, key)}
        onDoubleClick={(event) => { if (!(event.target as Element).closest('button')) zoomToTile(key); }}
        role="group" aria-label={`${name} title bar. Double-click zooms to it, arrow keys move it, Shift with arrows resizes it, Shift-click selects it. Dragging a selected tile moves every selected tile.`}
        aria-pressed={selected.has(key)}>
        {header}
      </div>
      {body}
      <button className="canvas-resize" aria-label={`Resize ${name}`} title="Drag to resize"
        onPointerDown={(event) => startResize(event, key)} onKeyDown={(event) => tileKey(event, key)} />
    </article>;
  };
  const backdrop = {
    '--canvas-zoom': viewport.zoom,
    backgroundSize: `${dotStep(viewport.zoom)}px ${dotStep(viewport.zoom)}px`,
    backgroundPosition: `${viewport.panX}px ${viewport.panY}px`,
  } as CSSProperties;

  return <div className="console-canvas" onKeyDown={stageKey}>
    <div className={panning ? 'canvas-stage canvas-stage-panning' : 'canvas-stage'} ref={stage} style={backdrop}
      onPointerDown={startStageGesture} onDoubleClick={tileAt} tabIndex={0}
      // A middle-button press would otherwise start the browser's autoscroll instead of panning.
      onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
      role="region" aria-label="Interactive canvas. Plan with notes, images and drawings beside your agents. Drag across empty space to select tiles, hold Space and drag (or drag with the middle button) to pan, and scroll to zoom.">
      <OrchestratorLinkLayer links={links} viewport={viewport} />
      {connectingTile && <OrchestratorConnectLayer name={tileLabel(connectingTile)} tone={orchestratorTone(orchestratorsHere.indexOf(connectingTile))}
        wired={wiredOf(connectingTile)} {...connectTargets()} viewport={viewport}
        onChange={(wired) => localTiles.setWiring(connectingTile.id, wired)} onDone={() => setConnecting(undefined)} />}
      <TeamLayer ready={inventoryReady} groups={groups} onGroupsChange={onGroupsChange} items={items} rects={state.rects} viewport={viewport} update={update}
        showRect={showRect} trackPointer={trackPointer} notify={notify} onHandoff={(from) => setHandoff({ from })} />
      {onOpenTeam && <ManagedTeamLayer teams={managedTeams} rects={state.rects} viewport={viewport} update={update} trackPointer={trackPointer} onOpenTeam={onOpenTeam} />}
      {items.map((item) => { const status = itemStatus(item, now); return frame(item.key, itemName(item),
        <ConsoleHeader item={item} status={status} focused={false} onFocus={() => onFocus(item)} onClose={() => onClose(item)}
          onDetails={onDetails} onOpenAsTerminal={onOpenAsTerminal} onRename={onRename} />,
        <BoardItemBody item={item} lastEvent={lastEvent} notify={notify} scale={viewport.zoom} />, undefined, status); })}
      {tilesHere.map((tile) => {
        const orchestratorIndex = orchestratorsHere.indexOf(tile);
        const body = tile.kind === 'orchestrator'
          ? <OrchestratorPanel tile={tile} items={items} groups={groups} projectKey={projectKey} now={now} notify={notify}
            onShow={zoomToTile} wired={wiredOf(tile)} onWiringChange={(wired) => localTiles.setWiring(tile.id, wired)}
            connecting={connecting === tile.id} onConnect={() => setConnecting((current) => (current === tile.id ? undefined : tile.id))}
            onSpawn={() => spawnFor(tile)} />
          : <LocalTileBody tile={tile} defaultCwd={defaultCwd} onOpenConsole={(kind, cwd, name) => openFromTile(tile.id, kind, cwd, name)}
            onShowPage={(url, name) => localTiles.showPage(tile.id, url, name)} onShowFile={(root, path, name) => localTiles.showFile(tile.id, root, path, name)}
            onOrchestrate={(name) => localTiles.orchestrate(tile.id, name)} onWorktree={(root, path, name) => localTiles.showWorktree(tile.id, root, path, name)} />;
        return frame(localTileKey(tile.id), tileLabel(tile),
          <LocalTileHeader tile={tile} onClose={() => localTiles.remove(tile.id)} onRename={(name) => localTiles.rename(tile.id, name)} />,
          body, orchestratorIndex >= 0 ? orchestratorTone(orchestratorIndex) : undefined);
      })}
      <PlanningLayer key={projectKey} board={planning} viewport={viewport} stage={stage} items={items} hasLocalTiles={tilesHere.length > 0} notify={notify}
        onNewConsole={() => newTile()} onPan={startPan} trackPointer={trackPointer}
        selected={noteSelection} setSelected={setNoteSelection} onDragSelection={dragFromNote}
        occupied={[...items.map((item) => item.key), ...tilesHere.map((tile) => localTileKey(tile.id))].flatMap((key) => state.rects[key] ?? [])} onShow={showRect} />
      {marquee && <div className="canvas-marquee" aria-hidden="true"
        style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
    </div>
    {<span className="canvas-hint">V select · N note · P draw · drag empty space (or Ctrl+A) to select tiles, then drag one to move them all · Space-drag or middle-drag to pan · scroll to zoom · double-click for a new tile</span>}
    <CanvasDock selectedCount={selectionSize} sessionCount={selectedSessions.length} agentCount={agentsHere.length} onNewTile={() => newTile()} onSpawnTeam={onSpawnTeam}
      onNewOrchestrator={() => newTile(undefined, 'orchestrator')}
      onGroup={groupSelected} onClearSelection={clearSelection}
      onPauseAll={() => void sendTeamKeys(agentsHere, 'pause', notify)} onResumeAll={() => void sendTeamKeys(agentsHere, 'resume', notify)}
      onHandoff={() => setHandoff({})} />
    {handoff && <HandoffDialog from={runningHere} to={agentsHere} initialFrom={handoff.from} notify={notify} onClose={() => setHandoff(undefined)} />}
    <div className="canvas-tools" role="group" aria-label="Canvas view">
      <button onClick={() => zoomBy(1 / BUTTON_ZOOM, stageCenter())} aria-label="Zoom out" title="Zoom out (-)">−</button>
      <span className="canvas-zoom" aria-live="polite">{percent}%</span>
      <button onClick={() => zoomBy(BUTTON_ZOOM, stageCenter())} aria-label="Zoom in" title="Zoom in (+)">+</button>
      <button onClick={() => changeView(() => DEFAULT_VIEWPORT)} aria-label="Reset view to 100%" title="Reset view (0)">1:1</button>
      <button onClick={fit} aria-label="Fit entire canvas" title="Fit ideas and sessions"><Icon name="fit" size={15} /></button>
      <button onClick={tidy} aria-label="Tidy sessions into a grid" title="Tidy: lay every session out as a spaced grid of full-size tiles"><Icon name="grid" size={15} /></button>
    </div>
  </div>;
}
