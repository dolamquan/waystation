import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ArchitectureEdge, ArchitectureNode } from '../../../../shared/architecture.ts';
import { Icon } from '../Icon.tsx';
import { graphBounds, NODE_HEIGHT, NODE_WIDTH, type WorkflowIssue } from './workflowInsights.ts';

type Camera = { readonly x: number; readonly y: number; readonly scale: number };
const MAP_WIDTH = 180;
const MAP_HEIGHT = 112;
const MAP_PADDING = 120;

type MinimapProps = {
  readonly nodes: readonly ArchitectureNode[];
  readonly edges: readonly ArchitectureEdge[];
  readonly camera: Camera;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly selection?: string;
  readonly onCenter: (point: { x: number; y: number }) => void;
};

/** Overview of the whole graph with the visible area outlined. Click or drag to move the view. */
export function CanvasMinimap({ nodes, edges, camera, viewport, selection, onCenter }: MinimapProps) {
  const bounds = graphBounds(nodes);
  if (!bounds) return null;
  const view = { x: -camera.x / camera.scale, y: -camera.y / camera.scale, w: viewport.width / camera.scale, h: viewport.height / camera.scale };
  const minX = Math.min(bounds.minX, view.x) - MAP_PADDING; const minY = Math.min(bounds.minY, view.y) - MAP_PADDING;
  const width = Math.max(bounds.maxX, view.x + view.w) + MAP_PADDING - minX; const height = Math.max(bounds.maxY, view.y + view.h) + MAP_PADDING - minY;
  const scale = Math.min(MAP_WIDTH / width, MAP_HEIGHT / height);
  const toCanvas = (e: ReactPointerEvent<SVGSVGElement>) => { const box = e.currentTarget.getBoundingClientRect(); return { x: minX + (e.clientX - box.left) / scale, y: minY + (e.clientY - box.top) / scale }; };
  const center = (e: ReactPointerEvent<SVGSVGElement>) => onCenter(toCanvas(e));
  const byId = new Map(nodes.map(n => [n.id, n]));
  return <svg className="arch-minimap" role="img" aria-label="Workflow overview" width={MAP_WIDTH} height={MAP_HEIGHT} viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
    onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); center(e); }}
    onPointerMove={e => { if (e.buttons === 1) center(e); }}>
    <g transform={`scale(${scale}) translate(${-minX},${-minY})`}>
      {edges.map(edge => { const a = byId.get(edge.source); const b = byId.get(edge.target); return a && b ? <line key={edge.id} x1={a.x + NODE_WIDTH} y1={a.y + NODE_HEIGHT / 2} x2={b.x} y2={b.y + NODE_HEIGHT / 2} className="arch-minimap-edge" /> : null; })}
      {nodes.map(n => <rect key={n.id} className={`arch-minimap-node arch-kind-${n.kind} ${selection === n.id ? 'selected' : ''}`} x={n.x} y={n.y} width={NODE_WIDTH} height={NODE_HEIGHT} rx={16} />)}
      <rect className="arch-minimap-view" x={view.x} y={view.y} width={view.w} height={view.h} rx={12} />
    </g>
  </svg>;
}

const SEVERITY_ICON = { error: 'alert', warning: 'alert', info: 'info' } as const;

type ChecksProps = { readonly issues: readonly WorkflowIssue[]; readonly onSelect: (nodeId: string) => void };

/** A toolbar button that opens the design checks list. */
export function WorkflowChecks({ issues, onSelect }: ChecksProps) {
  const [open, setOpen] = useState(false);
  const worst = issues.find(i => i.severity !== 'info')?.severity;
  const tone = worst === 'error' ? 'error' : worst === 'warning' ? 'warning' : 'ok';
  const label = issues.length ? `${issues.length} check${issues.length === 1 ? '' : 's'}` : 'Looks good';
  return <div className="arch-checks">
    <button type="button" className={`btn btn-small arch-checks-trigger tone-${tone}`} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(v => !v)}><Icon name={tone === 'ok' ? 'check' : 'alert'} size={14} />{label}</button>
    {open && <div className="arch-checks-popover" role="dialog" aria-label="Workflow checks" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}>
      <header><strong>Design checks</strong><button type="button" className="icon-btn" aria-label="Close checks" onClick={() => setOpen(false)}><Icon name="close" size={14} /></button></header>
      {issues.length
        ? <ul>{issues.map(issue => <li key={issue.id} className={`severity-${issue.severity}`}><Icon name={SEVERITY_ICON[issue.severity]} size={14} />{issue.nodeId
          ? <button type="button" onClick={() => { onSelect(issue.nodeId!); setOpen(false); }}>{issue.message}</button>
          : <span>{issue.message}</span>}</li>)}</ul>
        : <p className="arch-checks-ok"><Icon name="check" size={16} />Every step is connected and configured.</p>}
      <small>Checks guide the design. They never block saving.</small>
    </div>}
  </div>;
}

const SHORTCUTS = [
  ['Ctrl / ⌘ + Z', 'Undo'], ['Ctrl / ⌘ + Shift + Z', 'Redo'], ['Ctrl / ⌘ + D', 'Duplicate step'], ['Delete', 'Remove selection'],
  ['Arrow keys', 'Nudge step'], ['C', 'Toggle connect mode'], ['F', 'Fit workflow'], ['/', 'Find a step'], ['Ctrl / ⌘ + wheel', 'Zoom at pointer'], ['Esc', 'Clear selection'],
] as const;

/** Keyboard reference. */
export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  return <div className="arch-checks">
    <button type="button" className="icon-btn" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" aria-expanded={open} onClick={() => setOpen(v => !v)}><Icon name="info" size={16} /></button>
    {open && <div className="arch-checks-popover arch-shortcuts" role="dialog" aria-label="Keyboard shortcuts" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}>
      <header><strong>Shortcuts</strong><button type="button" className="icon-btn" aria-label="Close shortcuts" onClick={() => setOpen(false)}><Icon name="close" size={14} /></button></header>
      <dl>{SHORTCUTS.map(([keys, action]) => <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{action}</dd></div>)}</dl>
      <small>Shortcuts work while the diagram has focus.</small>
    </div>}
  </div>;
}
