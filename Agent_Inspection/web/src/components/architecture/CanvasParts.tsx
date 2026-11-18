import { ARCHITECTURE_KINDS, type ArchitectureEdge, type ArchitectureGraph, type ArchitectureKind, type ArchitectureNode } from '../../../../shared/architecture.ts';
import { resourceSummary } from '../../../../shared/agentResources.ts';
import { Icon } from '../Icon.tsx';
import { NODE_HEIGHT, NODE_WIDTH, type WorkflowIssue } from './workflowInsights.ts';
import { DraftNotice, useInspectorDraft } from './InspectorDraft.tsx';

export const KINDS: Record<ArchitectureKind, { name: string; icon: Parameters<typeof Icon>[0]['name']; hint: string }> = {
  input: { name: 'Input', icon: 'arrow', hint: 'A request or event' }, agent: { name: 'Agent', icon: 'sparkle', hint: 'A role and instructions' },
  router: { name: 'Router', icon: 'git', hint: 'Conditions and branches' }, tool: { name: 'Tool', icon: 'terminal', hint: 'An external capability' },
  memory: { name: 'Memory', icon: 'book', hint: 'Shared context or state' }, approval: { name: 'Approval', icon: 'shield', hint: 'A human decision' },
  output: { name: 'Output', icon: 'check', hint: 'The workflow result' },
};
const LABEL_SUGGESTIONS = ['Approved', 'Needs revision', 'Context', 'Escalate'];
const LABEL_MAX = 28;
const CHAR_WIDTH = 6.2;

export const nodeSubtitle = (node: ArchitectureNode): string => node.kind !== 'agent'
  ? node.config ? resourceSummary(node.config) : 'Needs configuration'
  : node.model || (node.runtime?.kind === 'api' ? 'LLM API brain' : node.provider) || (node.description ? node.description : 'Add instructions');
export const nodeReady = (node: ArchitectureNode): boolean => node.kind === 'agent' ? !!node.runtime && !!node.description.trim() : !!node.config;

type EdgePathProps = { readonly edge: ArchitectureEdge; readonly nodes: readonly ArchitectureNode[]; readonly selected: boolean; readonly lit: boolean; readonly onSelect: () => void };

/** One connection: a wide hit area, the line, an animated flow overlay, an arrowhead and an optional label pill. */
export function EdgePath({ edge, nodes, selected, lit, onSelect }: EdgePathProps) {
  const a = nodes.find(n => n.id === edge.source); const b = nodes.find(n => n.id === edge.target);
  if (!a || !b) return null;
  const x1 = a.x + NODE_WIDTH; const y1 = a.y + NODE_HEIGHT / 2; const x2 = b.x - 2; const y2 = b.y + NODE_HEIGHT / 2;
  const bend = Math.max(60, Math.abs(x2 - x1) / 2);
  const path = `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
  // Fit the pill into the gap between the two steps; very tight gaps show the label on hover/selection only (via aria + inspector).
  const gap = Math.abs(x2 - x1) - 12;
  const maxChars = Math.min(LABEL_MAX, Math.floor((gap - 20) / CHAR_WIDTH));
  const displayLabel = edge.outcome ? `${edge.outcome === 'approved' ? 'Approved' : 'Rejected'}${edge.label ? ` · ${edge.label}` : ''}` : edge.label;
  const text = maxChars < 3 ? '' : displayLabel.length > maxChars ? `${displayLabel.slice(0, maxChars - 1)}…` : displayLabel;
  const labelWidth = text.length * CHAR_WIDTH + 20;
  return <g className={`arch-edge arch-kind-${a.kind} ${selected ? 'selected' : ''} ${lit ? 'lit' : ''}`} role="button" tabIndex={0} aria-label={`Connection from ${a.name} to ${b.name}${edge.label ? `: ${edge.label}` : ''}`} onPointerDown={e => e.stopPropagation()} onClick={onSelect} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}>
    <path className="arch-edge-hit" d={path} />
    <path className="arch-edge-line" d={path} />
    <path className="arch-edge-flow" d={path} />
    <path className="arch-edge-head" d={`M${x2 - 9},${y2 - 5} L${x2},${y2} L${x2 - 9},${y2 + 5} Z`} />
    {text && <g className="arch-edge-label" transform={`translate(${(x1 + x2) / 2},${(y1 + y2) / 2})`}><rect x={-labelWidth / 2} y={-11} width={labelWidth} height={22} rx={11} /><text y={4} textAnchor="middle">{text}</text></g>}
  </g>;
}

type InspectorHeaderProps = { readonly node?: ArchitectureNode; readonly edge?: ArchitectureEdge; readonly nodes: readonly ArchitectureNode[]; readonly onClear: () => void; readonly onFocus: (id: string) => void };

export function InspectorHeader({ node, edge, nodes, onClear, onFocus }: InspectorHeaderProps) {
  const from = edge && nodes.find(n => n.id === edge.source); const to = edge && nodes.find(n => n.id === edge.target);
  const kind = node?.kind ?? from?.kind ?? 'agent';
  return <header className={`arch-inspector-head arch-kind-${kind}`}>
    <span className="arch-kind-tile"><Icon name={node ? KINDS[node.kind].icon : 'link'} size={18} /></span>
    <div>{node
      ? <><small>{KINDS[node.kind].name} · {nodeReady(node) ? 'Configured' : 'Needs setup'}</small><strong>{node.name}</strong></>
      : <><small>Connection</small><strong className="arch-edge-route">{from && <button type="button" onClick={() => onFocus(from.id)}>{from.name}</button>}<Icon name="arrow" size={12} />{to && <button type="button" onClick={() => onFocus(to.id)}>{to.name}</button>}</strong></>}</div>
    <button type="button" className="icon-btn" aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClear}><Icon name="close" size={14} /></button>
  </header>;
}

export function EdgeFields({ edge, documentId, sourceKind, busy, save }: { readonly edge: ArchitectureEdge; documentId: string; sourceKind?: ArchitectureKind; readonly busy: boolean; readonly save: (edge: ArchitectureEdge) => Promise<boolean> }) {
  const local = useInspectorDraft(`${documentId}:${edge.id}`, edge); const { draft, setDraft } = local;
  return <form className="arch-fields" onSubmit={e => { e.preventDefault(); if (!local.conflict) void save(draft).then(ok => { if (ok) local.commit(); }); }}>
    <h3>Connection</h3><DraftNotice {...local} />
    <label className="arch-instructions">Connection label<input className="text-input" maxLength={200} value={draft.label} placeholder="Describe this connection" onChange={e => setDraft({ ...draft, label: e.target.value })} /></label>
    {sourceKind === 'approval' ? <label>Follow this connection when<select className="text-input" aria-label="Approval outcome" value={draft.outcome ?? 'approved'} onChange={e => setDraft({ ...draft, outcome: e.target.value as 'approved' | 'rejected' })}><option value="approved">Approved</option><option value="rejected">Rejected or expired</option></select></label> : <p className="arch-field-note">{sourceKind === 'router' ? 'Routing rules on the Router select the destination. This label is a description.' : 'Agent connections pass the response to the next agent. Tool and memory connections attach resources. Labels describe connections; they do not define conditions.'}</p>}
    <div className="arch-suggestions" role="group" aria-label="Suggested labels">{LABEL_SUGGESTIONS.map(s => <button key={s} type="button" aria-pressed={draft.label === s} onClick={() => setDraft({ ...draft, label: s })}>{s}</button>)}</div>
    <button className="btn btn-small" disabled={busy || local.conflict || !local.dirty}>Save connection</button>
  </form>;
}

type GraphFieldsProps = { readonly graph: ArchitectureGraph; documentId: string; readonly busy: boolean; readonly issues: readonly WorkflowIssue[]; readonly onFocus: (id: string) => void; readonly save: (title: string, description: string) => Promise<boolean> };

/** Workflow overview (readiness, composition, top issues) and the title/goal form. */
export function GraphFields({ graph, documentId, busy, issues, onFocus, save }: GraphFieldsProps) {
  const local = useInspectorDraft(`${documentId}:details`, { title: graph.title, description: graph.description });
  const { title, description } = local.draft;
  const ready = graph.nodes.filter(nodeReady).length;
  const progress = graph.nodes.length ? Math.round(ready / graph.nodes.length * 100) : 0;
  const nodeIssues = issues.filter(i => i.nodeId).slice(0, 4);
  return <>
    <div className="arch-overview">
      <div className="arch-overview-progress"><div><small>Configured steps</small><strong>{ready} of {graph.nodes.length}</strong></div><span className="arch-meter" role="meter" aria-label="Configured steps" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></span></div>
      <ul className="arch-overview-kinds">{ARCHITECTURE_KINDS.map(kind => { const count = graph.nodes.filter(n => n.kind === kind).length; return count ? <li key={kind} className={`arch-kind-${kind}`}><span className="arch-kind-tile"><Icon name={KINDS[kind].icon} size={13} /></span>{KINDS[kind].name}<b>{count}</b></li> : null; })}</ul>
      {!!nodeIssues.length && <ul className="arch-overview-issues">{nodeIssues.map(i => <li key={i.id} className={`severity-${i.severity}`}><button type="button" onClick={() => onFocus(i.nodeId!)}><Icon name={i.severity === 'info' ? 'info' : 'alert'} size={13} />{i.message}</button></li>)}</ul>}
    </div>
    <form className="arch-fields" onSubmit={e => { e.preventDefault(); if (!local.conflict) void save(title, description).then(ok => { if (ok) local.commit(); }); }}>
      <h3>Workflow details</h3>
      <DraftNotice {...local} />
      <label>Title<input className="text-input" required maxLength={100} value={title} onChange={e => local.setDraft({ ...local.draft, title: e.target.value })} /></label>
      <label className="arch-instructions">Goal<textarea aria-label="Goal" className="text-input" rows={3} maxLength={8000} value={description} placeholder="What should this workflow accomplish?" onChange={e => local.setDraft({ ...local.draft, description: e.target.value })} /></label>
      <button className="btn btn-small" disabled={busy || local.conflict || !local.dirty}>Save details</button>
    </form>
  </>;
}
