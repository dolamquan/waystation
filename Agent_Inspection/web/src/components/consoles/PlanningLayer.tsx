import { useEffect, useRef, useState, type CSSProperties, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { api, request } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { Confirm, Modal } from '../Modal.tsx';
import { itemName, type BoardItem } from './boardItems.ts';
import { screenToWorld, type Point, type Rect, type Viewport } from './canvasLayout.ts';
import { COLORS, componentNode, contains, createPlanningNode, drawingNode, layeredTemplate, linkNode, newNodeId, objectAt, objectName, parsePlanning, planningBrief, sketchEntry, withoutDanglingLinks, type NoteColor, type PlanningNode, type SketchVariant } from './planningBoard.ts';
import { DraftLink, SketchGlyph, SketchLibrary, SketchLink } from './SketchParts.tsx';
import type { usePlanningBoard } from './usePlanningBoard.ts';
import './planningCanvas.css';
import { downloadPlanningImage, renderPlanningImage } from './planningExport.ts';

type Tool = 'select' | 'pan' | 'note' | 'text' | 'shape' | 'draw' | 'arrow' | 'connect' | 'component';
type Board = ReturnType<typeof usePlanningBoard>;
const TOOLS: readonly { id: Tool; label: string; key: string; path: string }[] = [
  { id: 'select', label: 'Select', key: 'V', path: 'm5 3 14 9-7 2-3 7L5 3Z' },
  { id: 'pan', label: 'Hand', key: 'H', path: 'M8 12V6a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v7-4a2 2 0 0 1 4 0v8c0 4-3 7-7 7h-1c-2 0-4-1-5-3l-4-6a2 2 0 0 1 3-2l2 2' },
  { id: 'note', label: 'Sticky note', key: 'N', path: 'M4 3h16v12l-5 6H4V3Zm16 12h-5v6M8 8h8M8 12h6' },
  { id: 'text', label: 'Text', key: 'T', path: 'M4 6V3h16v3M12 3v18M8 21h8' },
  { id: 'shape', label: 'Shape', key: 'R', path: 'M4 4h16v16H4z' },
  { id: 'draw', label: 'Pen', key: 'P', path: 'm4 16-1 5 5-1L21 7l-4-4L4 16ZM14 6l4 4' },
  { id: 'arrow', label: 'Arrow', key: 'A', path: 'M4 20 20 4M9 4h11v11' },
  { id: 'connect', label: 'Connect blocks', key: 'C', path: 'M3 4h6v5H3zM15 15h6v5h-6zM9 6.5h3a2 2 0 0 1 2 2v7.5M11.5 13.5 14 16l2.5-2.5' },
];
/** Smallest size a block can be resized to: components can be small (a service row), notes keep room for text. */
const minWidth = (node: PlanningNode): number => (node.kind === 'component' ? 40 : 100);
const minHeight = (node: PlanningNode): number => (node.kind === 'component' ? 30 : 70);
const INK: Record<NoteColor, string> = { sand: '#ebcf89', mint: '#9ad7bb', rose: '#e5a6b9', blue: '#a7cafa' };
const editable = (target: EventTarget | null): boolean => target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable], .terminal-pane, .browser-page, [role="dialog"]'));

function download(name: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function AgentIdeaDialog({ nodes, board, items, notify, onClose, onNewConsole }: {
  nodes: readonly PlanningNode[]; board: Board; items: readonly BoardItem[];
  notify: (text: string, kind?: 'ok' | 'error') => void; onClose: () => void; onNewConsole: () => void;
}) {
  const eligible = items.filter((item) => item.console ? item.console.kind !== 'shell' && item.console.state === 'running' : item.agent?.canInstruct && item.agent.status !== 'stopped');
  const [target, setTarget] = useState(eligible[0]?.key ?? '');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = eligible.find((item) => item.key === target);
  const brief = `${task.trim()}\n\nThe following is a snapshot of the human's planning canvas. Use it as context for this task.\n\n${planningBrief(board.doc, nodes)}`;
  const tooLong = brief.length > (chosen?.console ? 24_000 : 8_000);
  const send = async () => {
    if (!chosen || !task.trim() || busy || tooLong) return;
    setBusy(true);
    try {
      const text = brief;
      const images = chosen.console ? [] : [{ data: (await renderPlanningImage(board.doc, nodes)).split(',')[1]! }];
      const result = chosen.console
        ? await request<{ message: string }>('POST', `/api/consoles/${encodeURIComponent(chosen.console.id)}/idea`, { text })
        : await api.instruct(chosen.agent!.id, text, images);
      notify(result.message || `Idea sent to ${itemName(chosen)}.`);
      onClose();
    } catch (error) { notify((error as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  return <Modal title="Work on this idea with an agent" onClose={onClose}>
    <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <div className="modal-body planning-agent-form">
        <p>{nodes.length} canvas object{nodes.length === 1 ? '' : 's'} will be included as context. Agent replies appear in their session beside your board.</p>
        {eligible.length ? <label>Agent<select className="text-input" value={target} onChange={(event) => setTarget(event.target.value)}>{eligible.map((item) => <option key={item.key} value={item.key}>{itemName(item)}</option>)}</select></label>
          : <p>No agent here can receive a task yet. Open an agent console to begin.</p>}
        <label>What should they do?<textarea autoFocus className="text-input" rows={4} maxLength={4000} value={task} onChange={(event) => setTask(event.target.value)} placeholder="Explore this idea, turn it into a plan, or build a first version…" /></label>
        <details><summary>Review the context</summary><pre>{planningBrief(board.doc, nodes)}</pre></details>
        {tooLong && <p role="alert">This idea has too much text for this agent. Close this panel and select fewer objects, or shorten your instruction.</p>}
        {chosen?.console && nodes.some((node) => node.kind === 'image') && <p>Terminal agents receive image descriptions. Choose a connected agent session to attach the actual images.</p>}
      </div>
      <footer className="modal-foot"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        {eligible.length ? <button type="submit" className="btn btn-go" disabled={busy || !chosen || !task.trim() || tooLong}>{busy ? 'Sending…' : 'Send idea'}</button>
          : <button type="button" className="btn btn-go" onClick={() => { onClose(); onNewConsole(); }}>Open agent console</button>}
      </footer>
    </form>
  </Modal>;
}

/** Human-authored objects share the agents' world coordinates, but never participate in console reconciliation. */
export function PlanningLayer({ board, viewport, stage, items, hasLocalTiles = false, notify, onNewConsole, onPan, trackPointer, selected, setSelected, onDragSelection, occupied = [], onShow }: {
  /** Where session and canvas tiles sit, so a template lands in free space; onShow then brings it into view. */
  occupied?: readonly Rect[]; onShow?: (rect: Rect) => void;
  board: Board; viewport: Viewport; stage: React.RefObject<HTMLDivElement | null>; items: readonly BoardItem[]; hasLocalTiles?: boolean;
  notify: (text: string, kind?: 'ok' | 'error') => void; onNewConsole: () => void;
  onPan: (event: ReactPointerEvent) => void;
  trackPointer: (event: ReactPointerEvent, apply: (dx: number, dy: number) => void) => void;
  /** Selected object ids. Owned by the canvas, so its selection box and Ctrl+A select notes alongside tiles. */
  selected: readonly string[];
  setSelected: Dispatch<SetStateAction<readonly string[]>>;
  /** Lets the canvas carry a drag started on a selected object, when tiles are selected too; true when it took the drag. */
  onDragSelection?: (event: ReactPointerEvent, id: string) => boolean;
}) {
  const [tool, setTool] = useState<Tool>('select');
  const [color, setColor] = useState<NoteColor>('sand');
  const [draft, setDraft] = useState<PlanningNode>();
  const [ask, setAsk] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [replacing, setReplacing] = useState(false);
  /** The architecture block armed for placing, the open component library, a connection being drawn, and a label being edited. */
  const [variant, setVariant] = useState<SketchVariant>();
  const [library, setLibrary] = useState(false);
  const [linkFrom, setLinkFrom] = useState<string>();
  const [linkPointer, setLinkPointer] = useState<Point>();
  const [editing, setEditing] = useState<string>();
  const imageInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const gesture = useRef<{ nodes: readonly PlanningNode[]; next: readonly PlanningNode[] } | undefined>(undefined);
  const [preview, setPreview] = useState<readonly PlanningNode[]>([]);
  const { doc, change } = board;
  const selectedNodes = doc.nodes.filter((node) => selected.includes(node.id));
  const docRef = useRef(doc); docRef.current = doc;
  const toolRef = useRef(tool); toolRef.current = tool;
  const world = (clientX: number, clientY: number): Point => {
    const box = stage.current?.getBoundingClientRect();
    return screenToWorld(viewport, { x: clientX - (box?.left ?? 0), y: clientY - (box?.top ?? 0) });
  };
  const center = (): Point => {
    const box = stage.current?.getBoundingClientRect();
    return screenToWorld(viewport, { x: (box?.width ?? 800) / 2 - 130 * viewport.zoom, y: (box?.height ?? 600) / 2 - 110 * viewport.zoom });
  };
  const patch = (id: string, update: Partial<PlanningNode>) => change((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, ...update } : node) }));
  const add = (node: PlanningNode) => {
    if (docRef.current.nodes.length >= 500) { notify('This board has 500 objects. Export it and start a new board, or remove some objects.', 'error'); return; }
    change((current) => ({ ...current, nodes: [...current.nodes, node] })); setSelected([node.id]);
  };
  const remove = () => { change((current) => ({ ...current, nodes: withoutDanglingLinks(current.nodes.filter((node) => !selected.includes(node.id))) })); setSelected([]); };
  const duplicate = () => {
    if (doc.nodes.length + selectedNodes.length > 500) { notify('A board can contain at most 500 objects.', 'error'); return; }
    // Connections are copied when both of their ends are; they then join the copies.
    const ids = new Map(selectedNodes.filter((node) => node.kind !== 'link').map((node) => [node.id, newNodeId()]));
    const copies = selectedNodes.filter((node) => node.kind !== 'link').map((node) => ({ ...node, id: ids.get(node.id)!, x: node.x + 28, y: node.y + 28 }));
    const links = doc.nodes.filter((node) => node.kind === 'link' && ids.has(node.from!) && ids.has(node.to!))
      .map((node) => ({ ...node, id: newNodeId(), from: ids.get(node.from!)!, to: ids.get(node.to!)! }));
    change((current) => ({ ...current, nodes: [...current.nodes, ...copies, ...links] })); setSelected(copies.map((node) => node.id));
  };

  /** The visible canvas centre, in world coordinates. */
  const middle = (): Point => { const corner = center(); return { x: corner.x + 130, y: corner.y + 110 }; };
  const connect = (from: string, to: string) => {
    setLinkFrom(undefined); setLinkPointer(undefined);
    if (docRef.current.nodes.some((node) => node.kind === 'link' && node.from === from && node.to === to)) { notify('Those blocks are already connected.'); return; }
    add(linkNode(from, to));
  };
  const placeTemplate = () => {
    const taken = [...occupied, ...docRef.current.nodes.filter((node) => node.kind !== 'link')];
    const below = taken.length ? { x: Math.min(...taken.map((r) => r.x)), y: Math.max(...taken.map((r) => r.y + r.height)) + 120 } : { x: middle().x - 600, y: middle().y - 230 };
    const nodes = layeredTemplate(below);
    if (docRef.current.nodes.length + nodes.length > 500) { notify('This board is too full for the template. Remove some objects first.', 'error'); return; }
    change((current) => ({ ...current, nodes: [...current.nodes, ...nodes] }));
    setSelected(nodes.map((node) => node.id)); setLibrary(false); setTool('select');
    onShow?.({ x: below.x - 40, y: below.y - 40, width: 1340, height: 560 });
    notify('Added a layered web app. Double-click a block to rename it; press C to connect blocks.');
  };
  /** Dragging a layer or stack carries the blocks inside it. */
  const withContents = (list: readonly PlanningNode[]): readonly PlanningNode[] => {
    const ids = new Set(list.map((node) => node.id));
    const frames = list.filter((node) => node.kind === 'component' && (node.variant === 'layer' || node.variant === 'stack'));
    if (!frames.length) return list;
    return [...list, ...docRef.current.nodes.filter((node) => node.kind !== 'link' && !ids.has(node.id) && frames.some((frame) => contains(frame, node)))];
  };
  const live = (id: string | undefined): PlanningNode | undefined => (id === undefined ? undefined : preview.find((node) => node.id === id) ?? doc.nodes.find((node) => node.id === id));

  // Draw/create on empty space only. Existing terminals retain their pointer and keyboard interaction.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const clear = (event: PointerEvent) => {
      if (event.target === element && toolRef.current === 'select') setSelected([]);
    };
    element.addEventListener('pointerdown', clear);
    return () => element.removeEventListener('pointerdown', clear);
  }, [stage]);

  useEffect(() => {
    const root = stage.current?.closest('.console-canvas');
    const key = (event: KeyboardEvent) => {
      if (!root?.contains(event.target as Node) || editable(event.target)) return;
      const modified = event.ctrlKey || event.metaKey;
      if (event.key === 'Enter' && tool === 'component' && variant) { event.preventDefault(); add(componentNode(variant, middle())); setTool('select'); return; }
      if (event.key === 'Enter' && (tool === 'note' || tool === 'text' || tool === 'shape')) {
        event.preventDefault(); add(createPlanningNode(tool, center(), color)); setTool('select'); return;
      }
      if (modified && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? board.redo() : board.undo(); }
      else if (modified && event.key.toLowerCase() === 'y') { event.preventDefault(); board.redo(); }
      else if (modified && event.key.toLowerCase() === 'd' && selectedNodes.length) { event.preventDefault(); duplicate(); }
      else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedNodes.length) { event.preventDefault(); remove(); }
      else if (event.key === 'Escape') { setSelected([]); setTool('select'); setSharing(false); setLibrary(false); setLinkFrom(undefined); setLinkPointer(undefined); }
      else if (!modified && !event.altKey && event.key.toLowerCase() === 'l') { event.preventDefault(); setLibrary((open) => !open); }
      else if (!modified && !event.altKey) {
        const next = TOOLS.find((entry) => entry.key.toLowerCase() === event.key.toLowerCase());
        if (next) { event.preventDefault(); setTool(next.id); }
      }
    };
    root?.addEventListener('keydown', key as EventListener);
    return () => root?.removeEventListener('keydown', key as EventListener);
  });

  const createAt = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || tool === 'select' || tool === 'pan') return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = world(event.clientX, event.clientY);
    if (tool === 'component') { if (variant) add(componentNode(variant, point)); setTool('select'); return; }
    if (tool === 'connect') {
      const hit = objectAt(docRef.current.nodes, point);
      if (!hit) { setLinkFrom(undefined); setLinkPointer(undefined); return; }
      if (linkFrom && hit.id !== linkFrom) { connect(linkFrom, hit.id); return; }
      setSelected([]); setLinkFrom(hit.id); setLinkPointer(point); return;
    }
    if (tool !== 'draw' && tool !== 'arrow') { add(createPlanningNode(tool, point, color)); setTool('select'); return; }
    setSelected([]);
    setDraft(drawingNode(tool, [point, point], color));
  };
  const drawMove = (event: ReactPointerEvent) => {
    if (tool === 'connect') { if (linkFrom) setLinkPointer(world(event.clientX, event.clientY)); return; }
    if (!draft) return;
    const point = world(event.clientX, event.clientY);
    const points = draft.points!.map((p) => ({ x: p.x + draft.x, y: p.y + draft.y }));
    if (draft.kind === 'arrow') points.splice(1, points.length - 1, point);
    else if (points.length < 5000 && Math.hypot(point.x - points.at(-1)!.x, point.y - points.at(-1)!.y) > 1 / viewport.zoom) points.push(point);
    setDraft({ ...drawingNode(draft.kind as 'draw' | 'arrow', points, color), id: draft.id });
  };
  const finishDrawing = () => {
    if (tool === 'connect') {
      // Released over another block: that is the target. Released where it started: wait for a click on the target.
      const hit = linkFrom && linkPointer ? objectAt(docRef.current.nodes, linkPointer) : undefined;
      if (linkFrom && hit && hit.id !== linkFrom) connect(linkFrom, hit.id);
      return;
    }
    if (!draft) return;
    if (draft.width > 3 || draft.height > 3) add(draft);
    setDraft(undefined);
  };
  const startMove = (event: ReactPointerEvent, node: PlanningNode, resize = false) => {
    if (event.button !== 0 || (!resize && (event.target as Element).closest('button, textarea, input'))) return;
    event.preventDefault(); event.stopPropagation();
    if (event.shiftKey && !resize) { setSelected((current) => current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id]); return; }
    if (!resize && onDragSelection?.(event, node.id)) return;
    const picked = !resize && selected.includes(node.id) ? selectedNodes : [node];
    const moving = resize ? picked : withContents(picked);
    if (resize || !selected.includes(node.id)) setSelected([node.id]);
    gesture.current = { nodes: moving, next: moving };
    trackPointer(event, (dx, dy) => {
      const next = moving.map((origin) => resize ? { ...origin, width: Math.min(2000, Math.max(minWidth(origin), origin.width + dx / viewport.zoom)), height: Math.min(2000, Math.max(minHeight(origin), origin.height + dy / viewport.zoom)) }
        : { ...origin, x: Math.min(10_000, Math.max(-10_000, origin.x + dx / viewport.zoom)), y: Math.min(10_000, Math.max(-10_000, origin.y + dy / viewport.zoom)) });
      if (gesture.current) gesture.current.next = next;
      setPreview(next);
    });
    const finish = () => {
      window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish);
      const next = gesture.current; gesture.current = undefined; setPreview([]);
      if (next && next.next !== next.nodes) change((current) => ({ ...current, nodes: current.nodes.map((entry) => next.next.find((moved) => moved.id === entry.id) ?? entry) }));
    };
    window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
  };

  const importBoard = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 12_000_000) throw new Error('Choose a canvas file smaller than 12 MB.');
      const imported = parsePlanning(JSON.parse(await file.text()));
      if (doc.nodes.length + imported.nodes.length > 500) throw new Error('The combined board would exceed 500 objects.');
      const ids = new Map(imported.nodes.map((node) => [node.id, newNodeId()]));
      const nodes = imported.nodes.map((node) => ({ ...node, id: ids.get(node.id)!, ...(node.kind === 'link' ? { from: ids.get(node.from!)!, to: ids.get(node.to!)! } : {}) }));
      change((current) => ({ ...current, title: current.nodes.length ? current.title : imported.title, nodes: [...current.nodes, ...nodes] }));
      setSelected(nodes.map((node) => node.id)); notify(`Imported ${nodes.length} objects. Use Fit all to see the board.`);
      setSharing(false);
    } catch (error) { notify((error as Error).message, 'error'); }
  };
  const addImage = async (file?: File) => {
    if (!file) return;
    try {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 2_000_000) throw new Error('Choose a PNG, JPEG, WebP or GIF image under 2 MB.');
      const src = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read that image. Try another file.')); reader.readAsDataURL(file); });
      const image = new Image(); image.src = src; await image.decode();
      add({ ...createPlanningNode('image', center(), color), text: file.name, src, height: Math.min(600, Math.max(120, 360 * image.naturalHeight / image.naturalWidth)) + 38 });
      setTool('select');
    } catch (error) { notify((error as Error).message, 'error'); }
  };
  useEffect(() => {
    const element = stage.current;
    const drop = (event: DragEvent) => { event.preventDefault(); if (event.dataTransfer?.files[0]) void addImage(event.dataTransfer.files[0]); };
    const over = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
    element?.addEventListener('drop', drop); element?.addEventListener('dragover', over);
    return () => { element?.removeEventListener('drop', drop); element?.removeEventListener('dragover', over); };
  });
  useEffect(() => {
    const root = stage.current?.closest('.console-canvas');
    const paste = (event: ClipboardEvent) => {
      if (editable(event.target) || !event.clipboardData) return;
      const image = [...event.clipboardData.items].find((item) => item.type.startsWith('image/'))?.getAsFile();
      if (image) { event.preventDefault(); void addImage(image); }
      else {
        const text = event.clipboardData.getData('text/plain').trim();
        if (text) { event.preventDefault(); add({ ...createPlanningNode('note', center(), color), text: text.slice(0, 12000) }); }
      }
    };
    root?.addEventListener('paste', paste as EventListener);
    return () => root?.removeEventListener('paste', paste as EventListener);
  });

  const stroke = (node: PlanningNode, temporary = false) => {
    const path = node.points!.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ');
    const last = node.points!.at(-1)!, first = node.points![0]!;
    const angle = Math.atan2(last.y - first.y, last.x - first.x);
    const wing = (offset: number) => `${last.x - 15 * Math.cos(angle + offset)} ${last.y - 15 * Math.sin(angle + offset)}`;
    return <svg key={node.id} className={`planning-stroke ${selected.includes(node.id) ? 'planning-stroke-selected' : ''}`} role="img" tabIndex={temporary ? undefined : 0} aria-label={node.kind === 'arrow' ? 'Canvas arrow' : 'Canvas drawing'}
      onFocus={temporary ? undefined : () => setSelected([node.id])}
      onKeyDown={(event) => {
        const step: Record<string, Point> = { ArrowLeft: { x: -10, y: 0 }, ArrowRight: { x: 10, y: 0 }, ArrowUp: { x: 0, y: -10 }, ArrowDown: { x: 0, y: 10 } };
        const delta = step[event.key]; if (delta && !temporary) { event.preventDefault(); patch(node.id, { x: node.x + delta.x, y: node.y + delta.y }); }
      }}
      style={{ left: node.x * viewport.zoom + viewport.panX, top: node.y * viewport.zoom + viewport.panY, width: Math.max(1, node.width * viewport.zoom), height: Math.max(1, node.height * viewport.zoom), color: INK[node.color] }}
      viewBox={`0 0 ${node.width} ${node.height}`} preserveAspectRatio="none">
      <path d={path} fill="none" stroke="transparent" strokeWidth={18 / viewport.zoom} className={temporary ? '' : 'planning-stroke-hit'} onPointerDown={temporary ? undefined : (event) => startMove(event, node)} />
      <path d={path} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {node.kind === 'arrow' && <path d={`M${wing(0.5)} L${last.x} ${last.y} L${wing(-0.5)}`} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>;
  };
  const resizeKeys = (node: PlanningNode) => (event: React.KeyboardEvent) => {
    const deltas: Record<string, Point> = { ArrowLeft: { x: -10, y: 0 }, ArrowRight: { x: 10, y: 0 }, ArrowUp: { x: 0, y: -10 }, ArrowDown: { x: 0, y: 10 } };
    const delta = deltas[event.key]; if (delta) { event.preventDefault(); event.stopPropagation(); patch(node.id, { width: Math.max(minWidth(node), node.width + delta.x), height: Math.max(minHeight(node), node.height + delta.y) }); }
  };
  /** An architecture block: its silhouette, its label (double-click or Enter to rename) and a resize grip. */
  const renderComponent = (node: PlanningNode, index: number) => {
    const entry = sketchEntry(node.variant!);
    const isSelected = selected.includes(node.id);
    // Layers sit behind everything (even session tiles); stacks behind the blocks placed on them.
    const zIndex = node.variant === 'layer' ? 1 : node.variant === 'stack' ? 60 + index : isSelected ? 500 : 100 + index;
    const style = { left: node.x * viewport.zoom + viewport.panX, top: node.y * viewport.zoom + viewport.panY,
      width: node.width, height: node.height, transform: `scale(${viewport.zoom})`, zIndex } as CSSProperties;
    return <article key={node.id} style={style} tabIndex={0} aria-label={`${entry.label}: ${objectName(node)}`}
      className={`planning-node planning-component sketch-${node.variant} planning-color-${node.color} ${isSelected ? 'planning-node-selected' : ''} ${linkFrom === node.id ? 'sketch-link-source' : ''}`}
      onFocus={() => { if (!selected.includes(node.id)) setSelected([node.id]); }} onPointerDown={(event) => startMove(event, node)}
      onDoubleClick={(event) => { if (!(event.target as Element).closest('button')) setEditing(node.id); }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); setEditing(node.id); return; }
        const delta: Record<string, Point> = { ArrowLeft: { x: -10, y: 0 }, ArrowRight: { x: 10, y: 0 }, ArrowUp: { x: 0, y: -10 }, ArrowDown: { x: 0, y: 10 } };
        const step = delta[event.key]; if (step) {
          event.preventDefault(); patch(node.id, event.shiftKey ? { width: Math.max(minWidth(node), node.width + step.x), height: Math.max(minHeight(node), node.height + step.y) } : { x: node.x + step.x, y: node.y + step.y });
        }
      }}>
      <SketchGlyph variant={node.variant!} />
      {editing === node.id
        ? <textarea className="sketch-label-input" autoFocus rows={1} maxLength={500} aria-label={`${entry.label} label`} value={node.text}
          onChange={(event) => patch(node.id, { text: event.target.value })} onBlur={() => setEditing(undefined)} onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => { if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) { event.preventDefault(); setEditing(undefined); (event.currentTarget.closest('article') as HTMLElement | null)?.focus(); } }} />
        : <span className="sketch-label">{node.text || entry.label}</span>}
      <button className="planning-node-resize" aria-label={`Resize ${objectName(node)}`} title="Drag or use arrow keys to resize" onPointerDown={(event) => startMove(event, node, true)} onKeyDown={resizeKeys(node)}><Icon name="expand" size={12} /></button>
    </article>;
  };
  const renderLink = (link: PlanningNode) => {
    const from = live(link.from), to = live(link.to);
    if (!from || !to) return null;
    return <SketchLink key={link.id} link={link} from={from} to={to} viewport={viewport} selected={selected.includes(link.id)} editing={editing === link.id}
      onSelect={(event) => { event.preventDefault(); event.stopPropagation(); setSelected((current) => (event.shiftKey ? (current.includes(link.id) ? current.filter((id) => id !== link.id) : [...current, link.id]) : [link.id])); }}
      onEdit={() => { setSelected([link.id]); setEditing(link.id); }} onLabel={(text) => patch(link.id, { text })} onDoneEditing={() => setEditing(undefined)} />;
  };
  const renderNode = (original: PlanningNode, index: number) => {
    const node = preview.find((entry) => entry.id === original.id) ?? original;
    if (node.kind === 'link') return null;
    if (node.kind === 'component') return renderComponent(node, index);
    if (node.kind === 'draw' || node.kind === 'arrow') return stroke(node);
    const style = { left: node.x * viewport.zoom + viewport.panX, top: node.y * viewport.zoom + viewport.panY,
      width: node.width, height: node.height, transform: `scale(${viewport.zoom})`, zIndex: selected.includes(node.id) ? 500 : 100 + index } as CSSProperties;
    return <article key={node.id} className={`planning-node planning-${node.kind} planning-color-${node.color} ${selected.includes(node.id) ? 'planning-node-selected' : ''}`}
      style={style} aria-label={`${node.kind === 'note' ? 'Sticky note' : node.kind} object`} tabIndex={0}
      onFocus={() => { if (!selected.includes(node.id)) setSelected([node.id]); }} onPointerDown={(event) => startMove(event, node)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const delta: Record<string, Point> = { ArrowLeft: { x: -10, y: 0 }, ArrowRight: { x: 10, y: 0 }, ArrowUp: { x: 0, y: -10 }, ArrowDown: { x: 0, y: 10 } };
        const step = delta[event.key]; if (step) {
          event.preventDefault(); patch(node.id, event.shiftKey ? { width: Math.max(minWidth(node), node.width + step.x), height: Math.max(minHeight(node), node.height + step.y) } : { x: node.x + step.x, y: node.y + step.y });
        }
      }}>
      <header className="planning-node-handle"><span>{node.kind === 'note' ? 'Idea' : node.kind === 'image' ? 'Reference' : node.kind === 'shape' ? 'Shape' : 'Text'}</span><svg className="planning-handle-dots" width="13" height="16" viewBox="0 0 13 16" fill="currentColor" aria-hidden="true"><circle cx="4" cy="4" r="1" /><circle cx="9" cy="4" r="1" /><circle cx="4" cy="8" r="1" /><circle cx="9" cy="8" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="9" cy="12" r="1" /></svg></header>
      {node.kind === 'image' ? <><img draggable={false} src={node.src} alt={node.text || 'Canvas reference'} /><input className="planning-image-caption" aria-label="Image description" placeholder="Describe this reference" maxLength={12000} value={node.text} onChange={(event) => patch(node.id, { text: event.target.value })} /></>
        : <textarea aria-label={node.kind === 'note' ? 'Note text' : node.kind === 'shape' ? 'Shape text' : 'Canvas text'} placeholder={node.kind === 'note' ? 'What are you thinking?' : node.kind === 'shape' ? 'Add a label…' : 'Write something…'} value={node.text} maxLength={12000} onChange={(event) => patch(node.id, { text: event.target.value })} spellCheck />}
      <button className="planning-node-resize" aria-label={`Resize ${node.kind}`} title="Drag or use arrow keys to resize" onPointerDown={(event) => startMove(event, node, true)} onKeyDown={(event) => {
        const deltas: Record<string, Point> = { ArrowLeft: { x: -10, y: 0 }, ArrowRight: { x: 10, y: 0 }, ArrowUp: { x: 0, y: -10 }, ArrowDown: { x: 0, y: 10 } };
        const delta = deltas[event.key]; if (delta) { event.preventDefault(); event.stopPropagation(); patch(node.id, { width: Math.max(minWidth(node), node.width + delta.x), height: Math.max(minHeight(node), node.height + delta.y) }); }
      }}><Icon name="expand" size={12} /></button>
    </article>;
  };
  return <>
    {(board.unreadable !== undefined || board.conflict) && <section className="planning-recovery" role="alert">
      <strong>{board.unreadable !== undefined ? 'This saved board could not be opened.' : 'Another window changed this board.'}</strong>
      <p>{board.unreadable !== undefined ? 'Your saved data is preserved. Download it before replacing this board.' : 'Your work is kept here. Choose which version to keep, or export a copy of yours first.'}</p>
      {board.unreadable !== undefined ? <><button type="button" onClick={() => download('canvas-recovery.json', board.unreadable!, 'application/json')}>Download saved data</button><button type="button" onClick={() => setReplacing(true)}>Start a new board</button></>
        : <><button type="button" onClick={() => download('my-canvas-copy.waystation.json', JSON.stringify(doc), 'application/json')}>Export my copy</button><button type="button" onClick={() => board.resolveConflict(false)}>Keep my version</button><button type="button" onClick={() => board.resolveConflict(true)}>Use other version</button></>}
    </section>}
    <div className="planning-world">
      {doc.nodes.map(renderNode)}
      {doc.nodes.filter((node) => node.kind === 'link').map(renderLink)}
      {draft && stroke(draft, true)}
      {tool === 'connect' && linkFrom && linkPointer && live(linkFrom) && <DraftLink from={live(linkFrom)!} pointer={linkPointer} viewport={viewport} />}
    </div>
    {tool === 'connect' && <p className="sketch-hint" role="status">{linkFrom ? 'Now click (or drag to) the block it connects to. Esc to stop.' : 'Click a block, then the block it connects to. Esc to stop.'}</p>}
    {tool === 'component' && variant && <p className="sketch-hint" role="status">Click the canvas to place {sketchEntry(variant).label.toLowerCase()}. Enter places it in the centre.</p>}
    {tool !== 'select' && <svg className={`planning-create-surface ${tool === 'pan' ? 'planning-pan-surface' : ''}`} aria-label={`${tool} tool: click or draw on the canvas`} onPointerDown={tool === 'pan' ? onPan : createAt} onPointerMove={drawMove} onPointerUp={finishDrawing} onPointerCancel={() => setDraft(undefined)} />}
    <div className="planning-heading">
      <input aria-label="Canvas name" value={doc.title} maxLength={120} onChange={(event) => change((current) => ({ ...current, title: event.target.value }))} onBlur={() => { if (!doc.title.trim()) change((current) => ({ ...current, title: 'Untitled canvas' })); }} />
      <span role="status" className={board.saveState === 'Not saved' ? 'planning-save-error' : ''}>{board.saveState}{board.saveState === 'Not saved' ? ' · Export a copy to keep your work' : ' · Your ideas + your agents'}</span>
    </div>
    <div className="planning-top-actions">
      <button type="button" aria-label="Undo canvas change" title="Undo (Ctrl+Z)" disabled={!board.canUndo} onClick={board.undo}><svg viewBox="0 0 24 24"><path d="M4 10h10a6 6 0 0 1 0 12M4 10l6-6M4 10l6 6" /></svg></button>
      <button type="button" aria-label="Redo canvas change" title="Redo (Ctrl+Shift+Z)" disabled={!board.canRedo} onClick={board.redo}><svg viewBox="0 0 24 24"><path d="M20 10H10a6 6 0 0 0 0 12M20 10l-6-6M20 10l-6 6" /></svg></button>
      <button type="button" aria-expanded={sharing} onClick={() => setSharing(!sharing)}><Icon name="crew" size={15} />Share board</button>
    </div>
    {sharing && <section className="planning-share" aria-label="Share board">
      <h3>Bring someone into the idea</h3><p>Export an editable board for a collaborator. They can import it into their own canvas and send a copy back.</p>
      <button type="button" onClick={() => download(`${doc.title.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80) || 'canvas'}.waystation.json`, JSON.stringify(doc, null, 2), 'application/json')}><Icon name="copy" size={15} />Export editable board</button>
      <button type="button" onClick={() => importInput.current?.click()}><Icon name="folder" size={15} />Import a board</button>
      <button type="button" onClick={() => download('canvas-brief.md', planningBrief(doc, doc.nodes), 'text/markdown')}><Icon name="book" size={15} />Export as a brief</button>
      <button type="button" disabled={exporting || !doc.nodes.length} onClick={() => {
        setExporting(true); void renderPlanningImage(doc, doc.nodes).then((data) => downloadPlanningImage(doc.title, data)).catch((error) => notify((error as Error).message, 'error')).finally(() => setExporting(false));
      }}><Icon name="image" size={15} />{exporting ? 'Preparing image…' : 'Export as an image'}</button>
      <p className="planning-share-note">Shared files include your notes, drawings and images. Live remote invitations are not connected yet.</p>
    </section>}
    <div className="planning-palette" role="toolbar" aria-label="Whiteboard tools">
      {TOOLS.map((entry) => <button type="button" key={entry.id} aria-label={`${entry.label} (${entry.key})`} aria-pressed={tool === entry.id} title={`${entry.label} (${entry.key})${['note', 'text', 'shape'].includes(entry.id) ? ' · Press Enter to place in the center' : ''}`} onClick={() => { setTool(entry.id); stage.current?.focus(); }}><svg viewBox="0 0 24 24"><path d={entry.path} /></svg></button>)}
      <button type="button" aria-label="Architecture components (L)" aria-pressed={library || tool === 'component'} title="Architecture components (L)" onClick={() => setLibrary((open) => !open)}><svg viewBox="0 0 24 24"><path d="M4 4h6v5H4zM14 4h6v5h-6zM9 15h6v5H9zM7 9v3h10V9M12 12v3" /></svg></button>
      <span className="planning-divider" />
      <button type="button" aria-label="Add image" title="Upload an image, or drop one on the board" onClick={() => imageInput.current?.click()}><Icon name="image" size={19} /></button>
    </div>
    {library && <SketchLibrary armed={tool === 'component' ? variant : undefined} onTemplate={placeTemplate} onClose={() => setLibrary(false)}
      onPick={(next) => { setVariant(next); setTool('component'); setSelected([]); stage.current?.focus(); }} />}
    <div className="planning-options" role="group" aria-label="Object colors">
      {COLORS.map((entry) => <button type="button" key={entry} className={`planning-swatch planning-color-${entry}`} aria-label={`${entry} color`} aria-pressed={selectedNodes.length ? selectedNodes.every((node) => node.color === entry) : color === entry} onClick={() => {
        setColor(entry); if (selectedNodes.length) change((current) => ({ ...current, nodes: current.nodes.map((node) => selected.includes(node.id) ? { ...node, color: entry } : node) }));
      }} />)}
    </div>
    {selectedNodes.length > 0 && <div className="planning-selection" role="toolbar" aria-label="Selected objects">
      <span>{selectedNodes.length} selected</span><button type="button" onClick={() => setAsk(true)}><Icon name="sparkle" size={15} />Ask an agent</button>
      <button type="button" aria-label="Duplicate selected objects" title="Duplicate (Ctrl+D)" onClick={duplicate}><Icon name="copy" size={15} /></button>
      <button type="button" aria-label="Delete selected objects" title="Delete" onClick={remove}><Icon name="trash" size={15} /></button>
      <button type="button" aria-label="Deselect objects" onClick={() => setSelected([])}><Icon name="close" size={14} /></button>
    </div>}
    {doc.nodes.length === 0 && items.length === 0 && !hasLocalTiles && <div className="planning-empty"><Icon name="cursor" size={28} /><h2>A little space for your next big idea.</h2><p>Sketch a thought, collect references, or plan something together. Bring agents in whenever you’re ready.</p><button type="button" onClick={() => { add(createPlanningNode('note', center(), color)); setTool('select'); }}><Icon name="plus" size={15} />Start with a note</button><small>Use the tools on the left, or drop an image anywhere.</small></div>}
    {doc.nodes.length > 0 && selectedNodes.length === 0 && <button className="planning-ask-board" type="button" onClick={() => setAsk(true)}><Icon name="sparkle" size={15} />Ask an agent about this board</button>}
    <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden aria-label="Upload canvas image" onChange={(event) => { void addImage(event.target.files?.[0]); event.target.value = ''; }} />
    <input ref={importInput} type="file" accept=".json,.waystation.json" hidden aria-label="Import canvas file" onChange={(event) => { void importBoard(event.target.files?.[0]); event.target.value = ''; }} />
    {ask && createPortal(<AgentIdeaDialog board={board} nodes={selectedNodes.length ? selectedNodes : doc.nodes} items={items} notify={notify} onClose={() => setAsk(false)} onNewConsole={onNewConsole} />, document.body)}
    {replacing && createPortal(<Confirm title="Replace the unreadable board?" body={<p>This replaces the saved data with a new empty board. Use Download saved data first if you want to keep a recovery copy.</p>} confirmLabel="Replace board" onClose={() => setReplacing(false)} onConfirm={board.resetUnreadable} />, document.body)}
  </>;
}
