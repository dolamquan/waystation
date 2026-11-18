import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { request, type Agent, type PendingInterception } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { ARCHITECTURE_KINDS, validateArchitecture, type ArchitectureDocument, type ArchitectureEdge, type ArchitectureGraph, type ArchitectureKind, type ArchitectureNode, type ArchitectureOperation } from '../../../../shared/architecture.ts';
import './architecture.css';
import './agent-platform.css';
import './agent-evaluation.css';
import './architecture-ui.css';
import './architecture-canvas.css';
import './architecture-sections.css';
import './agent-lifecycle.css';
import './workflow-production.css';
import { SECTION_ICONS } from './ArchitectureUI.tsx';
import { AgentSecretsView } from './AgentSecrets.tsx';
import { AgentEvaluationView } from './AgentEvaluation.tsx';
import { AgentSandboxesView } from './CodeExecution.tsx';
import { BrainConnectionsPanel, NodeFields as AgentNodeFields } from './AgentConfiguration.tsx';
import type { BrainConnection } from '../../../../shared/agentBrains.ts';
import { ResourceFields } from './ResourceConfiguration.tsx';
import { AgentActivity } from './AgentActivity.tsx';
import { AgentPlatformView, type PlatformSection } from './AgentPlatform.tsx';
import { AppAccess } from './AppAccess.tsx';
import { AddToolDialog } from './AddToolDialog.tsx';
import { ToolPaletteHint } from './ToolPaletteHint.tsx';
import { ArchitectChat, type WorkflowSnapshot as Snapshot } from './ArchitectChat.tsx';
import { CanvasMinimap, ShortcutHelp, WorkflowChecks } from './CanvasOverlays.tsx';
import { draftCount } from './InspectorDraft.tsx';
import { WorkflowRunner } from './WorkflowRunner.tsx';
import { ApiArchitect } from './ApiArchitect.tsx';
import { EdgeFields, EdgePath, GraphFields, InspectorHeader, KINDS, nodeReady, nodeSubtitle } from './CanvasParts.tsx';
import { checkWorkflow, duplicateNode, findSteps, graphBounds, layoutWorkflow, neighbourhood, NODE_HEIGHT, NODE_WIDTH, GRID, type WorkflowIssue } from './workflowInsights.ts';

type Surface = 'design' | 'activity' | 'app-access' | 'evaluation' | 'sandboxes' | 'secrets' | PlatformSection;
/** Sections grouped by lifecycle stage: build an agent, test it, release it, then grant access. Routing keys are unchanged. */
const SURFACE_GROUPS: readonly { id: string; label: string; surfaces: readonly (readonly [Surface, string])[] }[] = [
  { id: 'build', label: 'Build', surfaces: [['design', 'Architecture design'], ['capabilities', 'Capabilities'], ['connections', 'Connections'], ['secrets', 'Secrets']] },
  { id: 'test', label: 'Test & evaluate', surfaces: [['activity', 'Agent activity'], ['evaluation', 'Evaluation'], ['sandboxes', 'Code execution']] },
  { id: 'release', label: 'Release', surfaces: [['agents', 'Agents'], ['environments', 'Environments']] },
  { id: 'access', label: 'Access', surfaces: [['app-access', 'App access']] },
];
/** Arrow keys, Home and End move focus across every section button, across group boundaries. */
const moveTabFocus = (e: ReactKeyboardEvent<HTMLElement>) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
};
type Camera = { x: number; y: number; scale: number };
type Panel = 'inspect' | 'architect';
const MIN_ZOOM = .2;
const MAX_ZOOM = 2;
const HALF_HEIGHT = NODE_HEIGHT / 2;
const enc = encodeURIComponent;
const graphUrl = (id: string) => `/api/architectures/${enc(id)}`;
const saved = (key: string) => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
const remember = (id: string) => { try { localStorage.setItem('waystation-architecture', id); } catch { /* optional preference */ } };
const snap = (value: number) => Math.round(value / GRID) * GRID;
const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input,textarea,select');

export function ArchitectureView({ agents, onOpenAgent, pending, hosted = false }: { readonly agents: readonly Agent[]; readonly onOpenAgent: (id: string) => void; readonly pending?: readonly PendingInterception[]; readonly hosted?: boolean }) {
  const groups = SURFACE_GROUPS.map(group => ({ ...group, surfaces: group.surfaces.filter(([value]) => !hosted || value !== 'app-access') })).filter(group => group.surfaces.length);
  const [documents, setDocuments] = useState<ArchitectureDocument[]>([]);
  const [surface, setSurface] = useState<Surface>('design');
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
  const [hovered, setHovered] = useState<string>();
  const [panel, setPanel] = useState<Panel>(hosted ? 'inspect' : 'architect');
  const [connect, setConnect] = useState(false);
  const [source, setSource] = useState<string>();
  const [camera, setCamera] = useState<Camera>({ x: 40, y: 80, scale: 1 });
  const [viewport, setViewport] = useState({ width: 800, height: 520 });
  const [dragged, setDragged] = useState<{ id: string; x: number; y: number }>();
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(-1);
  const stage = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const drag = useRef<{ id?: string; startX: number; startY: number; x: number; y: number; moved: boolean; scale: number } | undefined>(undefined);
  const [showConnections, setShowConnections] = useState(false);
  const [connections, setConnections] = useState<BrainConnection[]>([]);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const importFile = useRef<HTMLInputElement>(null);
  const [addToolFor, setAddToolFor] = useState<string>();
  const [toolNotice, setToolNotice] = useState<{ nodeId: string; text: string }>();
  /** Unsaved edits in the inspector's agent form; adding a tool saves the agent and would discard them. */
  const inspectorDirty = useRef(false);
  const onInspectorDirty = useCallback((dirty: boolean) => { inspectorDirty.current = dirty; }, []);
  const [toolHint, setToolHint] = useState(false);
  const [newToolRequest, setNewToolRequest] = useState(0);
  const doc = snapshot?.document;
  const [unsaved, setUnsaved] = useState(0);
  useEffect(() => {
    const update = () => setUnsaved(doc ? draftCount(doc.id, new Set([...doc.nodes.map(n => n.id), ...doc.edges.map(e => e.id), 'details'])) : 0);
    update(); window.addEventListener('architecture-drafts-changed', update);
    return () => window.removeEventListener('architecture-drafts-changed', update);
  }, [doc?.id, doc?.revision]);
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
    if (requestedNode.current && merged.document.nodes.some(n => n.id === requestedNode.current)) { setSelection(requestedNode.current); setPanel('inspect'); requestedNode.current = undefined; }
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
    current.current = undefined; setSnapshot(undefined); setSelection(undefined); setSource(undefined); setConnect(false); setSyncError(''); setError(''); setShowConnections(false); setQuery(''); remember(id);
    const poll = async () => {
      if (pending) return; pending = true;
      try { const next = await request<Snapshot>('GET', graphUrl(id)); if (active) { accept(next); setSyncError(''); } }
      catch (e) { if (active) setSyncError((e as Error).message); }
      finally { pending = false; }
    };
    void poll(); const timer = setInterval(() => { void poll(); }, 1200);
    return () => { active = false; clearInterval(timer); };
  }, [id, accept]);

  // The stage mounts only once a document is loaded, so these effects re-run on that transition.
  const hasDoc = !!doc;
  useEffect(() => {
    const el = stage.current; if (!el) return;
    const measure = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    measure(); const observer = new ResizeObserver(measure); observer.observe(el); return () => observer.disconnect();
  }, [hasDoc, surface]);
  // Ctrl/Cmd + wheel zooms at the pointer; a plain wheel pans. A non-passive listener stops the page from scrolling.
  useEffect(() => {
    const el = stage.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.target instanceof Element) || e.target.closest('.arch-minimap, .arch-checks-popover')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const box = el.getBoundingClientRect(); const px = e.clientX - box.left; const py = e.clientY - box.top;
        setCamera(c => { const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, c.scale * Math.exp(-e.deltaY * .0015))); return { scale, x: px - (px - c.x) * scale / c.scale, y: py - (py - c.y) * scale / c.scale }; });
      } else setCamera(c => ({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }));
    };
    el.addEventListener('wheel', onWheel, { passive: false }); return () => el.removeEventListener('wheel', onWheel);
  }, [hasDoc, surface]);

  const fit = useCallback(() => {
    const bounds = graphBounds(current.current?.document.nodes ?? []); const box = stage.current?.getBoundingClientRect();
    if (!bounds || !box) { setCamera({ x: 40, y: 80, scale: 1 }); return; }
    const width = bounds.maxX - bounds.minX; const height = bounds.maxY - bounds.minY;
    const scale = Math.max(MIN_ZOOM, Math.min(1.2, (box.width - 64) / width, (box.height - 140) / height));
    setCamera({ scale, x: (box.width - width * scale) / 2 - bounds.minX * scale, y: 32 + (box.height - 140 - height * scale) / 2 - bounds.minY * scale });
  }, []);
  const fitted = useRef('');
  useEffect(() => { if (doc && fitted.current !== doc.id) { fitted.current = doc.id; fit(); } }, [doc, fit]);
  useEffect(() => { if (surface === 'design' && hasDoc) fit(); }, [viewport.width, viewport.height, surface, hasDoc, fit]);
  const centerOn = useCallback((point: { x: number; y: number }) => {
    const box = stage.current?.getBoundingClientRect(); if (!box) return;
    setCamera(c => ({ ...c, x: box.width / 2 - point.x * c.scale, y: box.height / 2 - point.y * c.scale }));
  }, []);
  const focusNode = (nodeId: string) => {
    const node = current.current?.document.nodes.find(n => n.id === nodeId); if (!node) return;
    setSelection(nodeId); setPanel('inspect'); centerOn({ x: node.x + NODE_WIDTH / 2, y: node.y + HALF_HEIGHT });
  };

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
  const freeSpot = (origin: { x: number; y: number }) => {
    const existing = current.current?.document.nodes ?? [];
    const candidates = [{ x: 0, y: 0 }];
    for (let ring = 1; ring <= 15; ring++) for (let x = -ring; x <= ring; x++) for (let y = -ring; y <= ring; y++) if (Math.max(Math.abs(x), Math.abs(y)) === ring) candidates.push({ x: x * 260, y: y * 140 });
    return candidates.map(offset => ({ x: origin.x + offset.x, y: origin.y + offset.y })).find(p => existing.every(n => Math.abs(n.x - p.x) >= NODE_WIDTH + 40 || Math.abs(n.y - p.y) >= NODE_HEIGHT + 40)) ?? origin;
  };
  const add = (kind: ArchitectureKind, point?: { x: number; y: number }, canvasTool = false) => {
    // A Tool is something an agent uses: open Add tool for that agent instead of dropping an unconfigured JavaScript step.
    if (kind === 'tool' && !canvasTool) { requestTool(); return; }
    const bounds = stage.current?.getBoundingClientRect();
    const center = { x: ((bounds?.width ?? 600) / 2 - camera.x) / camera.scale - NODE_WIDTH / 2, y: ((bounds?.height ?? 500) / 2 - camera.y) / camera.scale - HALF_HEIGHT };
    const location = point ?? freeSpot(center);
    const node: ArchitectureNode = { id: crypto.randomUUID(), kind, name: KINDS[kind].name, description: '', x: snap(location.x), y: snap(location.y) };
    void edit([{ type: 'put_node', node }]).then(ok => {
      if (!ok) return;
      setSelection(node.id); setPanel('inspect');
      if (!point && bounds) setCamera(c => ({ ...c, x: Math.max(24 - node.x * c.scale, Math.min(c.x, bounds.width - 24 - (node.x + NODE_WIDTH) * c.scale)), y: Math.max(24 - node.y * c.scale, Math.min(c.y, bounds.height - 64 - (node.y + NODE_HEIGHT) * c.scale)) }));
    });
  };
  const choose = (node: ArchitectureNode) => {
    if (connect) {
      if (!source) { setSource(node.id); setSelection(node.id); }
      else if (source !== node.id) {
        void edit([{ type: 'put_edge', edge: { id: crypto.randomUUID(), source, target: node.id, label: '' } }]).then(ok => { if (ok) { setSource(undefined); setConnect(false); } });
      }
    } else { setSelection(node.id); setPanel('inspect'); }
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
    if (d.id) setDragged({ id: d.id, x: snap(d.x + dx / d.scale), y: snap(d.y + dy / d.scale) });
    else setCamera(c => ({ ...c, x: d.x + dx, y: d.y + dy }));
  };
  const end = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current; drag.current = undefined;
    if (d?.id && d.moved) {
      const node = current.current?.document.nodes.find(n => n.id === d.id);
      const x = snap(d.x + (e.clientX - d.startX) / d.scale); const y = snap(d.y + (e.clientY - d.startY) / d.scale);
      if (node) void edit([{ type: 'put_node', node: { ...node, x, y } }]).finally(() => setDragged(undefined));
      else setDragged(undefined);
    }
    if (d && !d.id && !d.moved) setSelection(undefined);
  };
  const cancelDrag = () => { drag.current = undefined; setDragged(undefined); };
  const zoom = (amount: number) => {
    const bounds = stage.current?.getBoundingClientRect();
    setCamera(c => { const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, c.scale * amount)); const x = (bounds?.width ?? 600) / 2; const y = (bounds?.height ?? 500) / 2; return { scale, x: x - (x - c.x) * scale / c.scale, y: y - (y - c.y) * scale / c.scale }; });
  };
  const selectedNode = doc?.nodes.find(n => n.id === selection);
  function requestTool() {
    const agentsInGraph = current.current?.document.nodes.filter(n => n.kind === 'agent') ?? [];
    const target = selectedNode?.kind === 'agent' ? selectedNode : agentsInGraph.length === 1 ? agentsInGraph[0] : undefined;
    if (target && target.id === selection && inspectorDirty.current) { setToolHint(false); setToolNotice({ nodeId: target.id, text: 'Save your changes to this agent first. Adding a tool saves the agent, so unsaved edits would be lost.' }); return; }
    if (target) { setToolHint(false); setToolNotice(undefined); setAddToolFor(target.id); } else setToolHint(true);
  }
  const toolTarget = doc?.nodes.find(n => n.id === addToolFor && n.kind === 'agent');
  const canvasToolsOf = (agentId: string) => { const linked = new Set(doc?.edges.flatMap(e => e.source === agentId ? [e.target] : e.target === agentId ? [e.source] : []) ?? []); return doc?.nodes.filter(n => n.kind === 'tool' && linked.has(n.id)) ?? []; };
  const latestRevision = useCallback(() => current.current?.document.revision ?? 0, []);
  const onToolAdded = useCallback((next: Snapshot, text: string) => { const nodeId = addToolFor; if (current.current?.document.id === next.document.id) accept(next); setAddToolFor(undefined); if (nodeId) { setToolNotice({ nodeId, text }); setSelection(nodeId); setPanel('inspect'); } }, [accept, addToolFor]);
  const closeToolDialog = useCallback(() => setAddToolFor(undefined), []);
  const selectedEdge = doc?.edges.find(e => e.id === selection);
  const remove = () => { if (selectedNode) void edit([{ type: 'remove_node', id: selectedNode.id }]).then(ok => { if (ok) setSelection(undefined); }); else if (selectedEdge) void edit([{ type: 'remove_edge', id: selectedEdge.id }]).then(ok => { if (ok) setSelection(undefined); }); };
  const duplicate = () => {
    if (!selectedNode) return;
    const copy = duplicateNode(selectedNode, crypto.randomUUID());
    const spot = freeSpot({ x: copy.x, y: copy.y });
    const placed = { ...copy, x: snap(spot.x), y: snap(spot.y) };
    void edit([{ type: 'put_node', node: placed }]).then(ok => { if (ok) { setSelection(placed.id); setPanel('inspect'); } });
  };
  const arrange = () => {
    const latest = current.current?.document; if (!latest?.nodes.length) return;
    const positions = layoutWorkflow(latest.nodes, latest.edges);
    const operations: ArchitectureOperation[] = latest.nodes.flatMap(n => { const p = positions.get(n.id); return p && (p.x !== n.x || p.y !== n.y) ? [{ type: 'put_node' as const, node: { ...n, x: p.x, y: p.y } }] : []; });
    if (!operations.length) { fit(); return; }
    void edit(operations).then(ok => { if (ok) requestAnimationFrame(fit); });
  };
  const exportGraph = () => {
    if (!doc) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(validateArchitecture(doc), null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${doc.title.replace(/[^a-z0-9_-]/gi, '-').slice(0, 60)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const nodes = doc?.nodes.map(n => dragged?.id === n.id ? { ...n, x: dragged.x, y: dragged.y } : n) ?? [];
  const issues = useMemo<WorkflowIssue[]>(() => doc ? checkWorkflow(doc) : [], [doc]);
  const issueByNode = useMemo(() => { const map = new Map<string, WorkflowIssue>(); for (const i of issues) if (i.nodeId && !map.has(i.nodeId) && i.severity !== 'info') map.set(i.nodeId, i); return map; }, [issues]);
  const focus = neighbourhood(doc?.edges ?? [], hovered ?? selection);
  const matches = doc ? findSteps(doc.nodes, query) : [];
  const matchIds = new Set(matches.map(n => n.id));
  const jumpToMatch = (step: number) => {
    if (!matches.length) return;
    const index = ((matchIndex < 0 && step > 0 ? -1 : matchIndex) + step + matches.length) % matches.length;
    setMatchIndex(index); focusNode(matches[index]!.id);
  };
  const onStageKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isTyping(e.target)) return;
    const mod = e.ctrlKey || e.metaKey; const key = e.key.toLowerCase();
    if (mod && key === 'z') { e.preventDefault(); history(e.shiftKey ? 'redo' : 'undo'); return; }
    if (mod && key === 'd') { e.preventDefault(); duplicate(); return; }
    if (mod || e.altKey) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
    else if (e.key === 'Escape') { setConnect(false); setSource(undefined); setSelection(undefined); }
    else if (key === 'c') { setConnect(c => !c); setSource(undefined); }
    else if (key === 'f') fit();
    else if (e.key === '/') { e.preventDefault(); findInput.current?.focus(); }
    else if (selectedNode && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && !connect) { e.preventDefault(); void edit([{ type: 'put_node', node: { ...selectedNode, x: selectedNode.x + (e.key === 'ArrowRight' ? GRID : e.key === 'ArrowLeft' ? -GRID : 0), y: selectedNode.y + (e.key === 'ArrowDown' ? GRID : e.key === 'ArrowUp' ? -GRID : 0) } }]); }
  };
  const toActivity = (runId: string) => { setActivityRunId(runId); setSurface('activity'); };
  const toDeployment = (deployedId: string) => { setDeploymentId(deployedId); setSurface('agents'); };
  const toDesign = (architectureId?: string, nodeId?: string) => {
    if (architectureId && nodeId) { if (architectureId === id) { setSelection(nodeId); setPanel('inspect'); } else { requestedNode.current = nodeId; setId(architectureId); } }
    setSurface('design');
  };
  const scopedProject = platformProject || doc?.project || project;
  const selectionLabel = selectedNode?.name ?? (selectedEdge ? 'Connection' : undefined);
  const architectBusy = !!snapshot?.agent && !['idle', 'stopped'].includes(snapshot.agent.status);

  const surfaceView = surface === 'app-access' ? <AppAccess project={scopedProject} documents={documents} onProject={setPlatformProject} onChanged={() => void loadList()} />
    : surface === 'activity' ? <AgentActivity documents={documents} project={scopedProject} onProject={setPlatformProject} initialRunId={activityRunId} onEdit={(architectureId, nodeId) => toDesign(architectureId, nodeId)} onOpenAgent={onOpenAgent} onDeployment={toDeployment} />
    : surface === 'secrets' ? <AgentSecretsView project={scopedProject} />
    : surface === 'evaluation' ? <AgentEvaluationView project={scopedProject} onProject={setPlatformProject} onActivity={toActivity} />
    : surface === 'sandboxes' ? <AgentSandboxesView project={scopedProject} onProject={setPlatformProject} onActivity={toActivity} />
    : surface !== 'design' ? <AgentPlatformView section={surface} project={scopedProject} documents={documents} onProject={setPlatformProject} initialDeploymentId={deploymentId} newToolRequest={surface === 'capabilities' ? newToolRequest : 0} onDesign={toDesign} onActivity={toActivity} onOpenAgent={onOpenAgent} />
    : undefined;

  return <section className="architecture" aria-label="Architecture workspace">
    <label className="arch-mobile-section-picker">Workspace section<select className="text-input" aria-label="Workspace section" value={surface} onChange={e => setSurface(e.target.value as Surface)}>{groups.map(group => <optgroup key={group.id} label={group.label}>{group.surfaces.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</optgroup>)}</select></label>
    <nav ref={sectionTabs} className="arch-surface-tabs" aria-label="Architecture sections" onKeyDown={moveTabFocus}>{groups.map(group => <div key={group.id} className="arch-surface-group" role="group" aria-labelledby={`arch-stage-${group.id}`}>
      <span className="arch-surface-group-label" id={`arch-stage-${group.id}`}>{group.label}</span>
      {group.surfaces.map(([value, label]) => <button key={value} className={surface === value ? 'selected' : ''} aria-current={surface === value ? 'page' : undefined} onClick={() => { if (value === 'activity') void loadList(); setNewToolRequest(0); setSurface(value); }}><Icon name={SECTION_ICONS[value]} size={16} />{label}</button>)}
    </div>)}</nav>
    {surfaceView ?? <>
    <div className="arch-toolbar">
      <label className="arch-document-picker">Workflow<select className="text-input" aria-label="Workflow" disabled={busy} value={id} onChange={e => setId(e.target.value)}>
        {!documents.length && <option value="">No workflows yet</option>}{documents.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
      </select></label>
      <button className="btn" disabled={busy} onClick={() => { setCreating(c => !c); if (doc) setProject(doc.project); }}><Icon name="plus" size={15} />New workflow</button>
      {doc && <><span className={`arch-save ${busy ? 'saving' : syncError ? 'offline' : unsaved ? 'unsaved' : ''}`} role="status"><span className="arch-save-dot" aria-hidden="true" />{busy ? 'Saving…' : syncError ? 'Connection interrupted' : unsaved ? `${unsaved} unsaved draft${unsaved === 1 ? '' : 's'} · saved graph r${doc.revision}` : `Saved · revision ${doc.revision}`}</span><button className="btn btn-ghost" aria-pressed={showConnections} onClick={() => setShowConnections(v => !v)}><Icon name="link" size={15} />LLM connections</button><button className="btn btn-ghost" onClick={exportGraph}><Icon name="arrow" size={15} />Export JSON</button></>}
    </div>
    {error && <div className="arch-error" role="alert">{error}<button className="btn btn-small" onClick={() => { setError(''); void loadList(); }}>Refresh workflows</button></div>}
    {syncError && <p className="arch-error" role="alert">{syncError} Reconnecting automatically.</p>}
    {doc && showConnections && <BrainConnectionsPanel key={doc.id} documentId={doc.id} project={doc.project} connections={connections} onChanged={() => setConnectionVersion(v => v + 1)} onClose={() => setShowConnections(false)} />}
    {(creating || (loaded && !documents.length)) && <form className="arch-create" onSubmit={e => { e.preventDefault(); void create(); }}>
      <div><span className="arch-create-mark" aria-hidden="true"><Icon name="git" size={20} /></span><h2>Start an agent architecture</h2><p>Define a single agent or connect a team of roles, tools, and decisions. Work through the design with your architect.</p></div>
      {!hosted && <label>Project folder<input className="text-input" required placeholder="Absolute path to your project" value={project} onChange={e => setProject(e.target.value)} /></label>}
      <label>Start with<select className="text-input" value={template} onChange={e => setTemplate(e.target.value)}><option value="starter">Agent with human review</option><option value="blank">Empty workflow</option></select></label>
      <div className="arch-actions"><button className="btn btn-go" disabled={busy || !project.trim()} type="submit">{busy ? 'Creating…' : 'Create workflow'}</button><button className="btn" type="button" disabled={busy || !project.trim()} onClick={() => importFile.current?.click()}>Import JSON</button>{doc && <button className="btn btn-ghost" type="button" onClick={() => setCreating(false)}>Cancel</button>}</div>
      <input ref={importFile} type="file" accept="application/json,.json" hidden onChange={async e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; try { if (file.size > 2_000_000) throw new Error('Choose a workflow JSON file under 2 MB.'); await create(validateArchitecture(JSON.parse(await file.text()))); } catch (e) { setError((e as Error).message); } }} />
    </form>}
    {!loaded && <p role="status">Loading workflows…</p>}
    {id && !doc && !syncError && <p role="status">Loading workflow…</p>}
    {doc && <>
      <WorkflowRunner key={doc.id} document={doc} unsaved={unsaved} onConfigure={focusNode} onOpenAgent={onOpenAgent} onActivity={toActivity} />
      <div className="arch-workspace">
        <aside className="arch-palette" aria-label="Workflow components"><h2>Components</h2><p>Drag onto the canvas or click to add.</p>
          {ARCHITECTURE_KINDS.map(kind => <button className={`arch-component arch-kind-${kind}`} key={kind} aria-label={KINDS[kind].name} disabled={busy} draggable={!busy} onDragStart={e => { e.dataTransfer.setData('application/waystation-node', kind); e.dataTransfer.effectAllowed = 'copy'; }} onClick={() => add(kind)} title={KINDS[kind].hint}><span className="arch-kind-tile"><Icon name={KINDS[kind].icon} size={16} /></span><span className="arch-component-text"><span>{KINDS[kind].name}</span><small>{KINDS[kind].hint}</small></span><Icon name="plus" size={12} /></button>)}
          {toolHint && <ToolPaletteHint agent={selectedNode?.kind === 'agent' ? selectedNode : undefined} busy={busy} onAddTool={id => { setToolHint(false); setToolNotice(undefined); setAddToolFor(id); }} onCanvasStep={() => { setToolHint(false); add('tool', undefined, true); }} onDismiss={() => setToolHint(false)} />}
          <p className="arch-design-note">Configure resources, connect them to an agent, then start a run.</p>
        </aside>
        <div className="arch-editor">
          <div className="arch-canvas-toolbar" role="toolbar" aria-label="Diagram tools">
            <button className={`btn btn-small ${connect ? 'arch-on' : ''}`} aria-pressed={connect} onClick={() => { setConnect(c => !c); setSource(undefined); }} disabled={busy} title="Connect steps (C)"><Icon name="link" size={14} />Connect</button>
            <span className="arch-tool-group">
              <button className="icon-btn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={busy || !snapshot.canUndo} onClick={() => history('undo')}><Icon name="undo" size={16} /></button>
              <button className="icon-btn" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={busy || !snapshot.canRedo} onClick={() => history('redo')}><Icon name="redo" size={16} /></button>
              <button className="icon-btn" title="Duplicate step (Ctrl+D)" aria-label="Duplicate selected step" disabled={busy || !selectedNode} onClick={duplicate}><Icon name="copy" size={16} /></button>
              <button className="icon-btn" title="Delete (Del)" aria-label="Delete selected element" disabled={busy || !selection || (!selectedNode && !selectedEdge)} onClick={remove}><Icon name="trash" size={16} /></button>
            </span>
            <button className="btn btn-small" disabled={busy || nodes.length < 2} onClick={arrange} title="Lay out steps left to right"><Icon name="grid" size={14} />Auto-arrange</button>
            <label className="arch-find"><Icon name="search" size={14} /><span className="arch-sr-only">Find a step</span><input ref={findInput} type="search" placeholder="Find step  /" value={query} onChange={e => { setQuery(e.target.value); setMatchIndex(-1); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); jumpToMatch(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { setQuery(''); stage.current?.focus(); } }} />{query.trim() && <small aria-live="polite">{matches.length ? `${Math.max(matchIndex, 0) + 1}/${matches.length}` : 'None'}</small>}</label>
            <span className="arch-toolbar-end">
              <span className="arch-step-count">{nodes.length} steps · {doc.edges.length} links</span>
              <WorkflowChecks issues={issues} onSelect={focusNode} />
              <ShortcutHelp />
            </span>
          </div>
          <div ref={stage} className={`arch-stage ${connect ? 'arch-connecting' : ''} ${focus.nodes.size ? 'arch-has-focus' : ''}`} role="region" aria-label="Workflow diagram" tabIndex={0}
            onPointerDown={e => { if (e.target === e.currentTarget || (e.target instanceof SVGElement && e.target.classList.contains('arch-connections'))) begin(e); }} onPointerMove={move} onPointerUp={end} onPointerCancel={cancelDrag}
            onDragOver={e => { if (e.dataTransfer.types.includes('application/waystation-node')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
            onDrop={e => { e.preventDefault(); const kind = e.dataTransfer.getData('application/waystation-node') as ArchitectureKind; if (!ARCHITECTURE_KINDS.includes(kind)) return; const b = e.currentTarget.getBoundingClientRect(); add(kind, { x: (e.clientX - b.left - camera.x) / camera.scale - NODE_WIDTH / 2, y: (e.clientY - b.top - camera.y) / camera.scale - HALF_HEIGHT }); }}
            onKeyDown={onStageKey}>
            <svg className="arch-connections" aria-label="Connections"><g transform={`translate(${camera.x},${camera.y}) scale(${camera.scale})`}>
              {doc.edges.map(edge => <EdgePath key={edge.id} edge={edge} nodes={nodes} selected={selection === edge.id} lit={focus.edges.has(edge.id)} onSelect={() => { setSelection(edge.id); setPanel('inspect'); }} />)}
            </g></svg>
            <div className="arch-nodes" style={{ transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.scale})` }}>
              {nodes.map(node => {
                const issue = issueByNode.get(node.id); const ready = nodeReady(node);
                const classes = ['arch-node', `arch-kind-${node.kind}`, selection === node.id && 'selected', source === node.id && 'arch-source', focus.nodes.has(node.id) && 'lit', matchIds.has(node.id) && 'arch-match', dragged?.id === node.id && 'dragging'].filter(Boolean).join(' ');
                return <div key={node.id} className={classes} style={{ left: node.x, top: node.y }} onPointerEnter={() => setHovered(node.id)} onPointerLeave={() => setHovered(h => h === node.id ? undefined : h)}>
                  <button className="arch-node-body" aria-label={`${node.name}, ${KINDS[node.kind].name}`} aria-pressed={selection === node.id} onPointerDown={e => begin(e, node)} onPointerMove={move} onPointerUp={end} onPointerCancel={cancelDrag} onClick={() => choose(node)}>
                    <span className="arch-kind-tile"><Icon name={KINDS[node.kind].icon} size={16} /></span>
                    <span className="arch-node-text"><span className="arch-node-kind">{KINDS[node.kind].name}<span className={`arch-node-state ${ready ? 'ready' : 'pending'}`} title={ready ? 'Configured' : 'Needs setup'} /></span><strong>{node.name}</strong><span className="arch-node-subtitle">{nodeSubtitle(node)}</span></span>
                  </button>
                  {issue && <span className={`arch-node-flag severity-${issue.severity}`} title={issue.message} role="img" aria-label={issue.message}><Icon name="alert" size={11} /></span>}
                  <span className="arch-port arch-port-in" aria-hidden="true" /><button className="arch-port arch-port-out" aria-label={`Connect from ${node.name}`} onClick={() => { setConnect(true); setSource(node.id); setSelection(node.id); }} />
                </div>;
              })}
            </div>
            {!nodes.length && <div className="arch-empty"><span className="arch-empty-mark"><Icon name="git" size={26} /></span><h3>Give your workflow a first step</h3><p>Add an input or an agent, or describe the workflow to your architect.</p><div className="arch-empty-actions"><button className="btn btn-small arch-kind-input" onClick={() => add('input')}><Icon name="arrow" size={14} />Add input</button><button className="btn btn-small arch-kind-agent" onClick={() => add('agent')}><Icon name="sparkle" size={14} />Add agent</button><button className="btn btn-small" onClick={() => setPanel('architect')}><Icon name="message" size={14} />Ask the architect</button></div></div>}
            <p className={`arch-canvas-hint ${connect ? 'active' : ''}`} role="status">{connect ? (source ? 'Choose the destination step · Esc to cancel' : 'Choose the source step, then its destination') : ''}</p>
            <CanvasMinimap nodes={nodes} edges={doc.edges} camera={camera} viewport={viewport} selection={selection} onCenter={centerOn} />
            <div className="arch-zoom"><button className="icon-btn" aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}><Icon name="minus" size={15} /></button><button className="arch-zoom-level" aria-label="Reset zoom to 100%" title="Reset zoom" onClick={() => zoom(1 / camera.scale)}>{Math.round(camera.scale * 100)}%</button><button className="icon-btn" aria-label="Zoom in" onClick={() => zoom(1.2)}><Icon name="plus" size={15} /></button><button className="icon-btn" aria-label="Fit workflow" title="Fit workflow (F)" onClick={fit}><Icon name="fit" size={16} /></button></div>
          </div>
        </div>
        <div className="arch-side">
          <div className="arch-side-tabs" role="tablist" aria-label="Side panel">
            <button role="tab" aria-selected={panel === 'inspect'} className={panel === 'inspect' ? 'selected' : ''} onClick={() => setPanel('inspect')}><Icon name="list" size={14} />Inspector{selectionLabel && <span className="arch-side-chip">{selectionLabel}</span>}</button>
            <button role="tab" aria-selected={panel === 'architect'} className={panel === 'architect' ? 'selected' : ''} onClick={() => setPanel('architect')}><Icon name="sparkle" size={14} />Architect{architectBusy && <span className="arch-pulse busy" role="img" aria-label="working" />}</button>
          </div>
          <div className="arch-inspector" role="tabpanel" aria-label="Inspector" hidden={panel !== 'inspect'}>
            {(selectedNode || selectedEdge) && <InspectorHeader node={selectedNode} edge={selectedEdge} nodes={doc.nodes} onClear={() => setSelection(undefined)} onFocus={focusNode} />}
            {selectedNode ? selectedNode.kind === 'agent' ? <AgentNodeFields key={JSON.stringify(selectedNode)} onDirtyChange={onInspectorDirty} node={selectedNode} busy={busy} documentId={doc.id} revision={doc.revision} project={doc.project} onDeployment={toDeployment} onLibrary={() => setSurface('capabilities')} connections={connections} onConnections={() => setShowConnections(true)} agents={agents} onOpenAgent={onOpenAgent} onActivity={toActivity} save={node => edit([{ type: 'put_node', node }])}
              tools={{ canvasTools: canvasToolsOf(selectedNode.id), notice: toolNotice?.nodeId === selectedNode.id ? toolNotice.text : undefined, onDismissNotice: () => setToolNotice(undefined), onAddTool: () => { setToolNotice(undefined); setAddToolFor(selectedNode.id); }, onSnapshot: next => { if (current.current?.document.id === next.document.id) accept(next); } }} /> : <ResourceFields key={JSON.stringify(selectedNode)} node={selectedNode} document={doc} busy={busy} save={(node, secrets) => mutate(`${graphUrl(doc.id)}/nodes/${encodeURIComponent(node.id)}/resource`, { node, secrets, expectedRevision: current.current?.document.revision })} />
              : selectedEdge ? <EdgeFields key={JSON.stringify(selectedEdge)} documentId={doc.id} sourceKind={doc.nodes.find(n => n.id === selectedEdge.source)?.kind} edge={selectedEdge} busy={busy} save={edge => edit([{ type: 'put_edge', edge }])} />
              : <GraphFields key={JSON.stringify([doc.id, doc.title, doc.description])} documentId={doc.id} graph={doc} busy={busy} issues={issues} onFocus={focusNode} save={(title, description) => edit([{ type: 'describe', title, description }])} />}
          </div>
          {hosted ? <ApiArchitect key={doc.id} document={doc} connections={connections} hidden={panel !== 'architect'} onSnapshot={accept} onConnections={() => setShowConnections(true)} /> : <ArchitectChat key={doc.id} pending={pending} snapshot={snapshot} selection={selection} selectionLabel={selectionLabel} hidden={panel !== 'architect'} onSnapshot={next => { if (current.current?.document.id === next.document.id) accept(next); }} onOpenAgent={onOpenAgent} />}
        </div>
      </div>
      {toolTarget && <AddToolDialog documentId={doc.id} project={doc.project} node={toolTarget} revision={latestRevision} onAdded={onToolAdded} onClose={closeToolDialog}
        onAdvanced={() => { setAddToolFor(undefined); setNewToolRequest(n => n + 1); setSurface('capabilities'); }} onManageConnections={() => { setAddToolFor(undefined); setShowConnections(true); }} />}
      <footer className="arch-footer"><span title={doc.project}><Icon name="folder" size={12} />{doc.project}</span><span>{doc.changedBy === 'operator' ? 'Last edit by you' : 'Last edit by agent'} · Undo available for 30 edits</span></footer>
    </>}
  </>}
  </section>;
}
