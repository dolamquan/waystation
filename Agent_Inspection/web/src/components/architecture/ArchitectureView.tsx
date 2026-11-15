import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { api, request, type Agent, type AgentEvent } from '../../api.ts';
import { useProviders } from '../../useProviders.ts';
import { Icon } from '../Icon.tsx';
import { ModelPicker } from '../ModelPicker.tsx';
import { AgentConversation } from '../AgentConversation.tsx';
import { ARCHITECTURE_KINDS, validateArchitecture, type ArchitectureDocument, type ArchitectureEdge, type ArchitectureGraph, type ArchitectureKind, type ArchitectureNode, type ArchitectureOperation, type ArchitectureSnapshot } from '../../../../shared/architecture.ts';
import './architecture.css';
import './agent-platform.css';
import './agent-evaluation.css';
import './architecture-ui.css';
import { AgentSecretsView } from './AgentSecrets.tsx';
import { AgentEvaluationView, AgentSandboxesView } from './AgentEvaluation.tsx';
import { BrainConnectionsPanel, NodeFields as AgentNodeFields } from './AgentConfiguration.tsx';
import type { BrainConnection } from '../../../../shared/agentBrains.ts';
import { ResourceFields } from './ResourceConfiguration.tsx';
import { AgentActivity } from './AgentActivity.tsx';
import { AgentPlatformView, type PlatformSection } from './AgentPlatform.tsx';
import { resourceSummary } from '../../../../shared/agentResources.ts';
import { AppAccess } from './AppAccess.tsx';

const KINDS: Record<ArchitectureKind, { name: string; icon: Parameters<typeof Icon>[0]['name']; hint: string }> = {
  input: { name: 'Input', icon: 'arrow', hint: 'A request or event' }, agent: { name: 'Agent', icon: 'sparkle', hint: 'A role and instructions' },
  router: { name: 'Router', icon: 'git', hint: 'Conditions and branches' }, tool: { name: 'Tool', icon: 'terminal', hint: 'An external capability' },
  memory: { name: 'Memory', icon: 'book', hint: 'Shared context or state' }, approval: { name: 'Approval', icon: 'shield', hint: 'A human decision' },
  output: { name: 'Output', icon: 'check', hint: 'The workflow result' },
};
type Snapshot = ArchitectureSnapshot & { agent?: Agent; events?: AgentEvent[] };
type Camera = { x: number; y: number; scale: number };
const enc = encodeURIComponent;
const graphUrl = (id: string) => `/api/architectures/${enc(id)}`;
const saved = (key: string) => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
const remember = (id: string) => { try { localStorage.setItem('waystation-architecture', id); } catch { /* optional preference */ } };

export function ArchitectureView({ agents, onOpenAgent }: { readonly agents: readonly Agent[]; readonly onOpenAgent: (id: string) => void }) {
  const [documents, setDocuments] = useState<ArchitectureDocument[]>([]);
  const [surface, setSurface] = useState<'design' | 'activity' | 'app-access' | 'evaluation' | 'sandboxes' | 'secrets' | PlatformSection>('design');
  const sectionTabs = useRef<HTMLElement>(null);
  useEffect(() => {
    const tabs = sectionTabs.current; if (!tabs) return;
    const reveal = () => { const selected = tabs.querySelector<HTMLElement>('[aria-current="page"]'); if (!selected) return; const left = selected.getBoundingClientRect().left - tabs.getBoundingClientRect().left + tabs.scrollLeft; tabs.scrollLeft = Math.max(0, left - (tabs.clientWidth - selected.offsetWidth) / 2); };
    reveal(); const observer = new ResizeObserver(reveal); observer.observe(tabs); return () => observer.disconnect();
  }, [surface]);

  const [deploymentId, setDeploymentId] = useState<string>();
  const [platformProject, setPlatformProject] = useState('');
  const [activityRunId, setActivityRunId] = useState<string>();
  const requestedNode = useRef<string | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const current = useRef<Snapshot | undefined>(undefined);
  const [id, setId] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [creating, setCreating] = useState(false);
  const [project, setProject] = useState(() => saved('waystation-console-cwd') || agents.find(a => a.cwd)?.cwd || '');
  const [template, setTemplate] = useState('starter');
  const [selection, setSelection] = useState<string>();
  const [connect, setConnect] = useState(false);
  const [source, setSource] = useState<string>();
  const [camera, setCamera] = useState<Camera>({ x: 40, y: 80, scale: 1 });
  const [dragged, setDragged] = useState<{ id: string; x: number; y: number }>();
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id?: string; startX: number; startY: number; x: number; y: number; moved: boolean; scale: number } | undefined>(undefined);
  const providers = useProviders();
  const [vendor, setVendor] = useState('claude');
  const [model, setModel] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [showConnections, setShowConnections] = useState(false);
  const [connections, setConnections] = useState<BrainConnection[]>([]);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [chatError, setChatError] = useState('');
  const importFile = useRef<HTMLInputElement>(null);
  const doc = snapshot?.document;
  useEffect(() => {
    if (!doc?.id) { setConnections([]); return; }
    let active = true;
    void request<{ connections: BrainConnection[] }>('GET', `${graphUrl(doc.id)}/connections`).then(next => { if (active) setConnections(next.connections); }, e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [doc?.id, connectionVersion]);

  const accept = useCallback((next: Snapshot) => {
    if (current.current && current.current.document.id === next.document.id && current.current.document.revision > next.document.revision) return;
    const merged = { ...current.current, ...next };
    current.current = merged; setSnapshot(merged);
    if (requestedNode.current && merged.document.nodes.some(n => n.id === requestedNode.current)) { setSelection(requestedNode.current); requestedNode.current = undefined; }
    setDocuments(list => list.map(d => d.id === next.document.id ? next.document : d));
  }, []);
  const loadList = useCallback(async () => {
    try {
      const result = await request<{ documents: ArchitectureDocument[] }>('GET', '/api/architectures');
      setDocuments(result.documents); setError('');
      const preferred = saved('waystation-architecture');
      setId(value => value || result.documents.find(d => d.id === preferred)?.id || result.documents[0]?.id || '');
      setLoaded(true);
    } catch (e) { setError((e as Error).message); setLoaded(true); }
  }, []);
  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => {
    if (!id) return;
    let active = true; let pending = false;
    current.current = undefined; setSnapshot(undefined); setSelection(undefined); setSource(undefined); setConnect(false); setChatError(''); setSyncError(''); setError(''); setShowConnections(false); setText(''); remember(id);
    const poll = async () => {
      if (pending) return; pending = true;
      try { const next = await request<Snapshot>('GET', graphUrl(id)); if (active) { accept(next); setSyncError(''); } }
      catch (e) { if (active) setSyncError((e as Error).message); }
      finally { pending = false; }
    };
    void poll(); const timer = setInterval(() => { void poll(); }, 1200);
    return () => { active = false; clearInterval(timer); };
  }, [id, accept]);

  const fit = useCallback(() => {
    const nodes = current.current?.document.nodes; const bounds = stage.current?.getBoundingClientRect();
    if (!nodes?.length || !bounds) { setCamera({ x: 40, y: 80, scale: 1 }); return; }
    const minX = Math.min(...nodes.map(n => n.x)); const minY = Math.min(...nodes.map(n => n.y));
    const width = Math.max(...nodes.map(n => n.x + 180)) - minX; const height = Math.max(...nodes.map(n => n.y + 86)) - minY;
    const scale = Math.max(.2, Math.min(1.2, (bounds.width - 64) / width, (bounds.height - 140) / height));
    setCamera({ scale, x: (bounds.width - width * scale) / 2 - minX * scale, y: 32 + (bounds.height - 140 - height * scale) / 2 - minY * scale });
  }, []);
  const fitted = useRef('');
  useEffect(() => { if (doc && fitted.current !== doc.id) { fitted.current = doc.id; fit(); } }, [doc, fit]);

  const mutate = async (path: string, body: unknown) => {
    if (locked.current) return false;
    locked.current = true; setBusy(true); setError('');
    try {
      const next = await request<Snapshot>('POST', path, body);
      if (current.current?.document.id === next.document.id) accept(next);
      return true;
    } catch (e) { setError((e as Error).message); return false; }
    finally { locked.current = false; setBusy(false); }
  };
  const edit = (operations: ArchitectureOperation[]) => {
    const latest = current.current?.document;
    return latest ? mutate(graphUrl(latest.id), { expectedRevision: latest.revision, operations }) : Promise.resolve(false);
  };
  const history = (direction: 'undo' | 'redo') => {
    const latest = current.current?.document;
    if (latest) void mutate(`${graphUrl(latest.id)}/history`, { direction, expectedRevision: latest.revision });
  };
  const create = async (graph?: ArchitectureGraph) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const next = await request<Snapshot>('POST', '/api/architectures', { project: project.trim(), graph: graph ?? (template === 'starter' ? 'starter' : undefined) });
      setDocuments(list => [...list, next.document]); setCreating(false); setId(next.document.id);
    } catch (e) { setError((e as Error).message); }
    finally { locked.current = false; setBusy(false); }
  };
  const add = (kind: ArchitectureKind, point?: { x: number; y: number }) => {
    const bounds = stage.current?.getBoundingClientRect();
    let location = point ?? { x: ((bounds?.width ?? 600) / 2 - camera.x) / camera.scale - 90, y: ((bounds?.height ?? 500) / 2 - camera.y) / camera.scale - 43 };
    if (!point) {
      const origin = location; const existing = current.current?.document.nodes ?? [];
      const candidates = [{ x: 0, y: 0 }];
      for (let ring = 1; ring <= 15; ring++) for (let x = -ring; x <= ring; x++) for (let y = -ring; y <= ring; y++) if (Math.max(Math.abs(x), Math.abs(y)) === ring) candidates.push({ x: x * 240, y: y * 140 });
      const free = candidates.map(offset => ({ x: origin.x + offset.x, y: origin.y + offset.y })).find(p => existing.every(n => Math.abs(n.x - p.x) >= 220 || Math.abs(n.y - p.y) >= 126));
      if (free) location = free;
    }
    const node: ArchitectureNode = { id: crypto.randomUUID(), kind, name: KINDS[kind].name, description: '', x: Math.round(location.x / 20) * 20, y: Math.round(location.y / 20) * 20 };
    void edit([{ type: 'put_node', node }]).then(ok => {
      if (!ok) return;
      setSelection(node.id);
      if (!point && bounds) setCamera(c => ({ ...c, x: Math.max(24 - node.x * c.scale, Math.min(c.x, bounds.width - 24 - (node.x + 180) * c.scale)), y: Math.max(24 - node.y * c.scale, Math.min(c.y, bounds.height - 64 - (node.y + 86) * c.scale)) }));
    });
  };
  const choose = (node: ArchitectureNode) => {
    if (connect) {
      if (!source) { setSource(node.id); setSelection(node.id); }
      else if (source !== node.id) {
        void edit([{ type: 'put_edge', edge: { id: crypto.randomUUID(), source, target: node.id, label: '' } }]).then(ok => { if (ok) { setSource(undefined); setConnect(false); } });
      }
    } else setSelection(node.id);
  };
  const begin = (e: ReactPointerEvent<HTMLElement>, node?: ArchitectureNode) => {
    if (e.button !== 0 || busy || (node && connect)) return;
    e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: node?.id, startX: e.clientX, startY: e.clientY, x: node?.x ?? camera.x, y: node?.y ?? camera.y, moved: false, scale: camera.scale };
    if (node) setSelection(node.id);
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.startX; const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) < 4 && !d.moved) return;
    d.moved = true;
    if (d.id) setDragged({ id: d.id, x: Math.round((d.x + dx / d.scale) / 20) * 20, y: Math.round((d.y + dy / d.scale) / 20) * 20 });
    else setCamera(c => ({ ...c, x: d.x + dx, y: d.y + dy }));
  };
  const end = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current; drag.current = undefined;
    if (d?.id && d.moved) {
      const node = current.current?.document.nodes.find(n => n.id === d.id);
      const x = Math.round((d.x + (e.clientX - d.startX) / d.scale) / 20) * 20; const y = Math.round((d.y + (e.clientY - d.startY) / d.scale) / 20) * 20;
      if (node) void edit([{ type: 'put_node', node: { ...node, x, y } }]).finally(() => setDragged(undefined));
      else setDragged(undefined);
    }
    if (d && !d.id && !d.moved) setSelection(undefined);
  };
  const zoom = (amount: number) => {
    const bounds = stage.current?.getBoundingClientRect();
    setCamera(c => { const scale = Math.max(.2, Math.min(2, c.scale * amount)); const x = (bounds?.width ?? 600) / 2; const y = (bounds?.height ?? 500) / 2; return { scale, x: x - (x - c.x) * scale / c.scale, y: y - (y - c.y) * scale / c.scale }; });
  };
  const selectedNode = doc?.nodes.find(n => n.id === selection);
  const selectedEdge = doc?.edges.find(e => e.id === selection);
  const remove = () => { if (selectedNode) void edit([{ type: 'remove_node', id: selectedNode.id }]).then(ok => { if (ok) setSelection(undefined); }); else if (selectedEdge) void edit([{ type: 'remove_edge', id: selectedEdge.id }]).then(ok => { if (ok) setSelection(undefined); }); };
  const send = async () => {
    if (!doc || !text.trim() || sending) return;
    setSending(true); setChatError('');
    try {
      await request('POST', `${graphUrl(doc.id)}/chat`, { text, vendor, model: model || undefined, selection }); setText('');
      const next = await request<Snapshot>('GET', graphUrl(doc.id));
      if (current.current?.document.id === next.document.id) accept(next);
    } catch (e) { setChatError((e as Error).message); }
    finally { setSending(false); }
  };
  const exportGraph = () => {
    if (!doc) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(validateArchitecture(doc), null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${doc.title.replace(/[^a-z0-9_-]/gi, '-').slice(0, 60)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const nodes = doc?.nodes.map(n => dragged?.id === n.id ? { ...n, x: dragged.x, y: dragged.y } : n) ?? [];
  const active = snapshot?.agent && !['idle', 'stopped'].includes(snapshot.agent.status);

  return <section className="architecture" aria-label="Architecture workspace">
    <nav ref={sectionTabs} className="arch-surface-tabs" aria-label="Architecture sections">{([['design', 'Architecture design', 'git'], ['agents', 'Agents', 'sparkle'], ['capabilities', 'Capabilities', 'terminal'], ['connections', 'Connections', 'link'], ['app-access', 'App access', 'shield'], ['environments', 'Environments', 'book'], ['secrets', 'Secrets', 'shield'], ['sandboxes', 'Sandboxes', 'terminal'], ['evaluation', 'Evaluation', 'check'], ['activity', 'Agent activity', 'activity']] as const).map(([value, label, icon]) => <button key={value} className={surface === value ? 'selected' : ''} aria-current={surface === value ? 'page' : undefined} onClick={() => { if (value === 'activity') void loadList(); setSurface(value); }}><Icon name={icon} size={16} />{label}</button>)}</nav>
    {surface === 'app-access' ? <AppAccess project={platformProject || doc?.project || project} documents={documents} onProject={setPlatformProject} onChanged={() => void loadList()} /> : surface === 'activity' ? <AgentActivity documents={documents} initialRunId={activityRunId} onEdit={(architectureId, nodeId) => { if (architectureId === id) setSelection(nodeId); else { requestedNode.current = nodeId; setId(architectureId); } setSurface('design'); }} onOpenAgent={onOpenAgent} onDeployment={deployedId => { setDeploymentId(deployedId); setSurface('agents'); }} /> : surface === 'secrets' ? <AgentSecretsView project={platformProject || doc?.project || project} /> : surface === 'evaluation' ? <AgentEvaluationView project={platformProject || doc?.project || project} onProject={setPlatformProject} onActivity={runId => { setActivityRunId(runId); setSurface('activity'); }} /> : surface === 'sandboxes' ? <AgentSandboxesView project={platformProject || doc?.project || project} onProject={setPlatformProject} /> : surface !== 'design' ? <AgentPlatformView section={surface} project={platformProject || doc?.project || project} documents={documents} onProject={setPlatformProject} initialDeploymentId={deploymentId} onDesign={(architectureId, nodeId) => { if (architectureId && nodeId) { if (architectureId === id) setSelection(nodeId); else { requestedNode.current = nodeId; setId(architectureId); } } setSurface('design'); }} onActivity={runId => { setActivityRunId(runId); setSurface('activity'); }} onOpenAgent={onOpenAgent} /> : <>
    <div className="arch-toolbar">
      <label className="arch-document-picker">Workflow<select className="text-input" aria-label="Workflow" disabled={busy || sending} value={id} onChange={e => setId(e.target.value)}>
        {!documents.length && <option value="">No workflows yet</option>}{documents.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
      </select></label>
      <button className="btn" disabled={busy} onClick={() => { setCreating(c => !c); if (doc) setProject(doc.project); }}><Icon name="plus" size={15} />New workflow</button>
      {doc && <><span className="arch-save" role="status">{busy ? 'Saving…' : syncError ? 'Connection interrupted' : `Saved · revision ${doc.revision}`}</span><button className="btn btn-ghost" aria-pressed={showConnections} onClick={() => setShowConnections(v => !v)}><Icon name="link" size={15} />LLM connections</button><button className="btn btn-ghost" onClick={exportGraph}><Icon name="arrow" size={15} />Export JSON</button></>}
    </div>
    {error && <div className="arch-error" role="alert">{error}<button className="btn btn-small" onClick={() => { setError(''); void loadList(); }}>Refresh workflows</button></div>}
    {syncError && <p className="arch-error" role="alert">{syncError} Reconnecting automatically.</p>}
    {doc && showConnections && <BrainConnectionsPanel key={doc.id} documentId={doc.id} project={doc.project} connections={connections} onChanged={() => setConnectionVersion(v => v + 1)} onClose={() => setShowConnections(false)} />}
    {(creating || (loaded && !documents.length)) && <form className="arch-create" onSubmit={e => { e.preventDefault(); void create(); }}>
      <div><h2>Start an agent architecture</h2><p>Define a single agent or connect a team of roles, tools, and decisions. Work through the design with your architect.</p></div>
      <label>Project folder<input className="text-input" required placeholder="Absolute path to your project" value={project} onChange={e => setProject(e.target.value)} /></label>
      <label>Start with<select className="text-input" value={template} onChange={e => setTemplate(e.target.value)}><option value="starter">Builder → reviewer example</option><option value="blank">Empty workflow</option></select></label>
      <div className="arch-actions"><button className="btn btn-go" disabled={busy || !project.trim()} type="submit">{busy ? 'Creating…' : 'Create workflow'}</button><button className="btn" type="button" disabled={busy || !project.trim()} onClick={() => importFile.current?.click()}>Import JSON</button>{doc && <button className="btn btn-ghost" type="button" onClick={() => setCreating(false)}>Cancel</button>}</div>
      <input ref={importFile} type="file" accept="application/json,.json" hidden onChange={async e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; try { if (file.size > 2_000_000) throw new Error('Choose a workflow JSON file under 2 MB.'); await create(validateArchitecture(JSON.parse(await file.text()))); } catch (e) { setError((e as Error).message); } }} />
    </form>}
    {!loaded && <p role="status">Loading workflows…</p>}
    {id && !doc && !syncError && <p role="status">Loading workflow…</p>}
    {doc && <>
      <div className="arch-workspace">
        <aside className="arch-palette" aria-label="Workflow components"><h2>Components</h2><p>Drag onto the canvas, or click to add.</p>
          {ARCHITECTURE_KINDS.map(kind => <button className={`arch-component arch-kind-${kind}`} key={kind} disabled={busy} draggable={!busy} onDragStart={e => { e.dataTransfer.setData('application/waystation-node', kind); e.dataTransfer.effectAllowed = 'copy'; }} onClick={() => add(kind)} title={KINDS[kind].hint}><Icon name={KINDS[kind].icon} size={17} /><span>{KINDS[kind].name}</span><Icon name="plus" size={12} /></button>)}
          <p className="arch-design-note">Configure resources, connect them to an agent, then start a run.</p>
        </aside>
        <div className="arch-editor">
          <div className="arch-canvas-toolbar" role="toolbar" aria-label="Diagram tools">
            <button className={`btn btn-small ${connect ? 'arch-on' : ''}`} aria-pressed={connect} onClick={() => { setConnect(c => !c); setSource(undefined); }} disabled={busy}><Icon name="link" size={14} />Connect</button>
            <button className="icon-btn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={busy || !snapshot.canUndo} onClick={() => history('undo')}><Icon name="undo" size={16} /></button>
            <button className="icon-btn" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={busy || !snapshot.canRedo} onClick={() => history('redo')}><Icon name="redo" size={16} /></button>
            <button className="icon-btn" aria-label="Delete selected element" disabled={busy || !selection || (!selectedNode && !selectedEdge)} onClick={remove}><Icon name="trash" size={16} /></button>
            <span>{nodes.length} steps · {doc.edges.length} connections</span>
          </div>
          <div ref={stage} className={`arch-stage ${connect ? 'arch-connecting' : ''}`} role="region" aria-label="Workflow diagram" tabIndex={0}
            onPointerDown={e => { if (e.target === e.currentTarget || (e.target instanceof SVGElement && e.target.classList.contains('arch-connections'))) begin(e); }} onPointerMove={move} onPointerUp={end} onPointerCancel={() => { drag.current = undefined; setDragged(undefined); }}
            onDragOver={e => { if (e.dataTransfer.types.includes('application/waystation-node')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
            onDrop={e => { e.preventDefault(); const kind = e.dataTransfer.getData('application/waystation-node') as ArchitectureKind; if (!ARCHITECTURE_KINDS.includes(kind)) return; const b = e.currentTarget.getBoundingClientRect(); add(kind, { x: (e.clientX - b.left - camera.x) / camera.scale - 90, y: (e.clientY - b.top - camera.y) / camera.scale - 43 }); }}
            onKeyDown={e => {
              if ((e.target as HTMLElement).closest('input,textarea,select')) return;
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); history(e.shiftKey ? 'redo' : 'undo'); }
              if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
              if (e.key === 'Escape') { setConnect(false); setSource(undefined); setSelection(undefined); }
              if (selectedNode && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && !connect) { e.preventDefault(); void edit([{ type: 'put_node', node: { ...selectedNode, x: selectedNode.x + (e.key === 'ArrowRight' ? 20 : e.key === 'ArrowLeft' ? -20 : 0), y: selectedNode.y + (e.key === 'ArrowDown' ? 20 : e.key === 'ArrowUp' ? -20 : 0) } }]); }
            }}>
            <svg className="arch-connections" aria-label="Connections"><defs><marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor" /></marker></defs><g transform={`translate(${camera.x},${camera.y}) scale(${camera.scale})`}>
              {doc.edges.map(edge => {
                const a = nodes.find(n => n.id === edge.source); const b = nodes.find(n => n.id === edge.target); if (!a || !b) return null;
                const x1 = a.x + 180; const y1 = a.y + 43; const x2 = b.x; const y2 = b.y + 43; const bend = Math.max(50, Math.abs(x2 - x1) / 2);
                const path = `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
                return <g key={edge.id} className={`arch-edge ${selection === edge.id ? 'selected' : ''}`} role="button" tabIndex={0} aria-label={`Connection from ${a.name} to ${b.name}${edge.label ? `: ${edge.label}` : ''}`} onPointerDown={e => e.stopPropagation()} onClick={() => setSelection(edge.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelection(edge.id); } }}><path className="arch-edge-hit" d={path} /><path className="arch-edge-line" d={path} markerEnd="url(#arch-arrow)" />{edge.label && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 14} textAnchor="middle">{edge.label}</text>}</g>;
              })}
            </g></svg>
            <div className="arch-nodes" style={{ transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.scale})` }}>
              {nodes.map(node => <div key={node.id} className={`arch-node arch-kind-${node.kind} ${selection === node.id ? 'selected' : ''} ${source === node.id ? 'arch-source' : ''}`} style={{ left: node.x, top: node.y }}>
                <button className="arch-node-body" aria-label={`${node.name}, ${KINDS[node.kind].name}`} aria-pressed={selection === node.id} onPointerDown={e => begin(e, node)} onPointerMove={move} onPointerUp={end} onPointerCancel={() => { drag.current = undefined; setDragged(undefined); }} onClick={() => choose(node)}>
                  <span className="arch-node-kind"><Icon name={KINDS[node.kind].icon} size={15} />{KINDS[node.kind].name}</span><strong>{node.name}</strong><span className="arch-node-subtitle">{node.kind !== 'agent' ? node.config ? resourceSummary(node.config) : 'Needs configuration' : node.model || (node.runtime?.kind === 'api' ? 'LLM API brain' : node.provider) || (node.description ? node.description : 'Add instructions')}</span>
                </button>
                <span className="arch-port arch-port-in" aria-hidden="true" /><button className="arch-port arch-port-out" aria-label={`Connect from ${node.name}`} onClick={() => { setConnect(true); setSource(node.id); setSelection(node.id); }} />
              </div>)}
            </div>
            {!nodes.length && <div className="arch-empty"><Icon name="git" size={28} /><h3>Give your workflow a first step</h3><p>Add an input or an agent from Components, or describe the workflow in chat.</p></div>}
            <p className="arch-canvas-hint" role="status">{connect ? (source ? 'Choose the destination step. Esc to cancel.' : 'Choose the source step, then its destination.') : 'Drag steps to move · Drag the background to pan'}</p>
            <div className="arch-zoom"><button className="icon-btn" aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}><Icon name="minus" size={15} /></button><span>{Math.round(camera.scale * 100)}%</span><button className="icon-btn" aria-label="Zoom in" onClick={() => zoom(1.2)}><Icon name="plus" size={15} /></button><button className="icon-btn" aria-label="Fit workflow" onClick={fit}><Icon name="fit" size={16} /></button></div>
          </div>
          <div className="arch-inspector">
            {selectedNode ? selectedNode.kind === 'agent' ? <AgentNodeFields key={JSON.stringify(selectedNode)} node={selectedNode} busy={busy} documentId={doc.id} revision={doc.revision} project={doc.project} onDeployment={deployedId => { setDeploymentId(deployedId); setSurface('agents'); }} onLibrary={() => setSurface('capabilities')} connections={connections} onConnections={() => setShowConnections(true)} agents={agents} onOpenAgent={onOpenAgent} onActivity={runId => { setActivityRunId(runId); setSurface('activity'); }} save={node => edit([{ type: 'put_node', node }])} /> : <ResourceFields key={JSON.stringify(selectedNode)} node={selectedNode} document={doc} busy={busy} save={(node, secrets) => mutate(`${graphUrl(doc.id)}/nodes/${encodeURIComponent(node.id)}/resource`, { node, secrets, expectedRevision: current.current?.document.revision })} />
              : selectedEdge ? <EdgeFields key={JSON.stringify(selectedEdge)} edge={selectedEdge} busy={busy} save={edge => edit([{ type: 'put_edge', edge }])} />
              : <GraphFields key={JSON.stringify([doc.id, doc.title, doc.description])} graph={doc} busy={busy} save={(title, description) => edit([{ type: 'describe', title, description }])} />}
          </div>
        </div>
        <aside className="arch-chat" aria-label="Workflow architect chat">
          <header><div><Icon name="sparkle" size={18} /><h2>Workflow architect</h2></div><p>Shares your diagram. Can discuss and edit it.</p></header>
          <div className="arch-chat-context"><span className="connection-dot live" />{selection ? `Selected: ${selectedNode?.name || 'connection'}` : 'Full workflow context'}<span>r{doc.revision}</span></div>
          {snapshot.agentId ? <AgentConversation name="Architect" events={(snapshot.events ?? []).map((e, seq) => ({ ...e, seq }))} now={Date.now()} active loading={false} status={active ? 'Working with your workflow…' : snapshot.agent?.status === 'stopped' || !snapshot.agent ? 'Session ended. Send a message to start a new architect session.' : 'Ready for your next question.'} onRetry={() => undefined} />
            : <div className="arch-chat-intro"><h3>Think through the flow together</h3><p>Ask about handoffs, failure paths, or a missing step. Your architect reads the current diagram before making changes.</p>{['Add a human approval before the final response', 'Where could this workflow fail?', 'Add a shared memory for the agents'].map(prompt => <button key={prompt} onClick={() => setText(prompt)}>{prompt}<Icon name="arrow" size={14} /></button>)}</div>}
          <form className="arch-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
            {chatError && <p className="arch-error" role="alert">{chatError}</p>}
            {!snapshot.agent || snapshot.agent.status === 'stopped' ? <div className="arch-provider"><select className="text-input" aria-label="Architect provider" value={vendor} onChange={e => { setVendor(e.target.value); setModel(''); }}>{providers.providers.map(p => <option value={p.id} key={p.id} disabled={p.available === false}>{p.label}{p.available === false ? ' (unavailable)' : ''}</option>)}</select><ModelPicker key={vendor} vendor={vendor} value={model} onChange={setModel} /></div> : <div className="arch-session"><span>{snapshot.agent.vendor} · {snapshot.agent.status}</span><button type="button" onClick={() => onOpenAgent(snapshot.agentId!)}>Session details</button></div>}
            <label htmlFor="arch-message">Message your architect</label><textarea id="arch-message" className="text-input" value={text} maxLength={12000} onChange={e => setText(e.target.value)} placeholder="Describe a workflow, ask a question, or request a change…" rows={3} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
            <div className="arch-compose-footer"><small>Changes appear here. Undo any edit.</small>{active && <button type="button" className="btn btn-small" onClick={() => { void api.interrupt(snapshot.agentId!).catch(e => setChatError(e.message)); }}>Interrupt</button>}<button className="btn btn-go" disabled={sending || !text.trim() || !!active} type="submit"><Icon name="send" size={15} />{sending ? 'Sending…' : 'Send'}</button></div>
          </form>
        </aside>
      </div>
      <footer className="arch-footer"><span title={doc.project}>{doc.project}</span><span>{doc.changedBy === 'operator' ? 'Last edit by you' : 'Last edit by agent'} · Undo available for 30 edits</span></footer>
    </>}
  </>}
  </section>;
}

function EdgeFields({ edge, busy, save }: { edge: ArchitectureEdge; busy: boolean; save: (edge: ArchitectureEdge) => Promise<boolean> }) {
  const [label, setLabel] = useState(edge.label);
  return <form className="arch-fields" onSubmit={e => { e.preventDefault(); void save({ ...edge, label }); }}><h3>Connection</h3><label className="arch-instructions">Handoff or condition<input className="text-input" maxLength={200} value={label} placeholder="e.g. Approved, Needs revision, Context" onChange={e => setLabel(e.target.value)} /></label><button className="btn btn-small" disabled={busy || label === edge.label}>Save connection</button></form>;
}
function GraphFields({ graph, busy, save }: { graph: ArchitectureGraph; busy: boolean; save: (title: string, description: string) => Promise<boolean> }) {
  const [title, setTitle] = useState(graph.title); const [description, setDescription] = useState(graph.description);
  return <form className="arch-fields" onSubmit={e => { e.preventDefault(); void save(title, description); }}><h3>Workflow details</h3><label>Title<input className="text-input" required maxLength={100} value={title} onChange={e => setTitle(e.target.value)} /></label><label className="arch-instructions">Goal<textarea aria-label="Goal" className="text-input" rows={2} maxLength={8000} value={description} placeholder="What should this workflow accomplish?" onChange={e => setDescription(e.target.value)} /></label><button className="btn btn-small" disabled={busy || (title === graph.title && description === graph.description)}>Save details</button></form>;
}
