import type { PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '../Icon.tsx';
import type { Point, Viewport } from './canvasLayout.ts';
import { SKETCH_LIBRARY, linkEnds, type PlanningNode, type SketchRect, type SketchVariant } from './planningBoard.ts';
import './sketch.css';

/** The drawing inside an architecture block. Boxy blocks are styled in CSS; these add the recognisable silhouette or icon. */
export function SketchGlyph({ variant }: { readonly variant: SketchVariant }) {
  switch (variant) {
    case 'client': return <svg className="sketch-icon sketch-icon-client" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="15" r="9" /><path d="M7 44c1-10 8-16 17-16s16 6 17 16Z" />
    </svg>;
    case 'loadbalancer': return <svg className="sketch-fill" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polygon points="50,2 98,50 50,98 2,50" vectorEffect="non-scaling-stroke" />
    </svg>;
    case 'database': return <svg className="sketch-fill" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <path d="M2 14 A48 12 0 0 1 98 14 V86 A48 12 0 0 1 2 86 Z" vectorEffect="non-scaling-stroke" />
      <path className="sketch-rim" d="M2 14 A48 12 0 0 0 98 14" vectorEffect="non-scaling-stroke" />
    </svg>;
    case 'external': return <svg className="sketch-fill" viewBox="0 0 100 64" preserveAspectRatio="none" aria-hidden="true">
      <path d="M24 60 C8 60 2 50 4 40 C6 30 16 26 22 28 C24 12 40 4 54 8 C64 2 80 8 82 22 C94 22 99 34 96 44 C94 54 86 60 76 60 Z" vectorEffect="non-scaling-stroke" />
    </svg>;
    case 'server': return <svg className="sketch-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01" /></svg>;
    case 'gateway': return <svg className="sketch-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V8l8-5 8 5v12M9 20v-6h6v6M2 20h20" /></svg>;
    case 'cache': return <svg className="sketch-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></svg>;
    case 'queue': return <svg className="sketch-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h3v12H4zM10.5 6h3v12h-3zM17 6h3v12h-3z" /></svg>;
    case 'storage': return <svg className="sketch-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7l9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4" /></svg>;
    default: return null;
  }
}

const toScreen = (viewport: Viewport, point: Point): Point => ({ x: point.x * viewport.zoom + viewport.panX, y: point.y * viewport.zoom + viewport.panY });
const PAD = 28;
const HEAD = 11;

/** A line with an arrowhead between two screen points, in its own small SVG so it never blocks the canvas around it. */
function ArrowSvg({ start, end, className, selected, onPointerDown, onDoubleClick, label }: {
  readonly start: Point; readonly end: Point; readonly className: string; readonly selected?: boolean; readonly label?: string;
  readonly onPointerDown?: (event: ReactPointerEvent) => void; readonly onDoubleClick?: () => void;
}) {
  const left = Math.min(start.x, end.x) - PAD, top = Math.min(start.y, end.y) - PAD;
  const a = { x: start.x - left, y: start.y - top }, b = { x: end.x - left, y: end.y - top };
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const wing = (offset: number) => `${b.x - HEAD * Math.cos(angle + offset)} ${b.y - HEAD * Math.sin(angle + offset)}`;
  const line = `M${a.x} ${a.y} L${b.x} ${b.y}`;
  return <svg className={`${className} ${selected ? 'sketch-link-selected' : ''}`} role="img" aria-label={label ? `Connection: ${label}` : 'Connection'}
    style={{ left, top, width: Math.abs(end.x - start.x) + PAD * 2, height: Math.abs(end.y - start.y) + PAD * 2 }}>
    {onPointerDown && <path d={line} className="sketch-link-hit" onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} />}
    <path d={line} className="sketch-link-line" />
    <path d={`M${wing(0.45)} L${b.x} ${b.y} L${wing(-0.45)}`} className="sketch-link-head" />
  </svg>;
}

/** A connection between two objects, drawn from edge to edge so it follows them as they move. Double-click edits its label. */
export function SketchLink({ link, from, to, viewport, selected, editing, onSelect, onEdit, onLabel, onDoneEditing }: {
  readonly link: PlanningNode; readonly from: SketchRect; readonly to: SketchRect; readonly viewport: Viewport;
  readonly selected: boolean; readonly editing: boolean;
  readonly onSelect: (event: ReactPointerEvent) => void; readonly onEdit: () => void;
  readonly onLabel: (text: string) => void; readonly onDoneEditing: () => void;
}) {
  const ends = linkEnds(from, to);
  const start = toScreen(viewport, ends.start), end = toScreen(viewport, ends.end);
  const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  return <>
    <ArrowSvg start={start} end={end} className="sketch-link" selected={selected} label={link.text} onPointerDown={onSelect} onDoubleClick={onEdit} />
    {editing
      ? <input className="sketch-link-input" autoFocus value={link.text} maxLength={200} aria-label="Connection label" placeholder="Label (e.g. HTTPS)"
        style={{ left: middle.x, top: middle.y }} onChange={(event) => onLabel(event.target.value)} onBlur={onDoneEditing}
        onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter' || event.key === 'Escape') onDoneEditing(); }} />
      : link.text.trim() && <span className="sketch-link-label" style={{ left: middle.x, top: middle.y, fontSize: Math.max(9, 12 * Math.min(1.4, viewport.zoom)) }}
        onPointerDown={onSelect} onDoubleClick={onEdit}>{link.text}</span>}
  </>;
}

/** The connection being drawn: from the source object towards the pointer. */
export function DraftLink({ from, pointer, viewport }: { readonly from: SketchRect; readonly pointer: Point; readonly viewport: Viewport }) {
  const target = { x: pointer.x, y: pointer.y, width: 0, height: 0 };
  const ends = linkEnds(from, target);
  return <ArrowSvg start={toScreen(viewport, ends.start)} end={toScreen(viewport, pointer)} className="sketch-link sketch-link-draft" />;
}

/** The component library: pick a block, then click the canvas to place it (or press Enter to place it in the centre). */
export function SketchLibrary({ armed, onPick, onTemplate, onClose }: {
  readonly armed?: SketchVariant; readonly onPick: (variant: SketchVariant) => void; readonly onTemplate: () => void; readonly onClose: () => void;
}) {
  return <section className="sketch-library" aria-label="Architecture components">
    <header><strong>Architecture</strong><button type="button" className="sketch-library-x" aria-label="Close components" onClick={onClose}><Icon name="close" size={13} /></button></header>
    <p>Pick a block, then click the canvas. Press <kbd>C</kbd> to connect blocks.</p>
    <div className="sketch-library-grid">
      {SKETCH_LIBRARY.map((entry) => <button type="button" key={entry.variant} aria-pressed={armed === entry.variant} title={entry.hint}
        className={`sketch-pick planning-color-${entry.color}`} onClick={() => onPick(entry.variant)}>
        <span className={`sketch-swatch sketch-${entry.variant}`}><SketchGlyph variant={entry.variant} /></span>
        <span>{entry.label}</span>
      </button>)}
    </div>
    <button type="button" className="sketch-template" onClick={onTemplate}><Icon name="grid" size={14} />Start from a layered web app</button>
  </section>;
}
