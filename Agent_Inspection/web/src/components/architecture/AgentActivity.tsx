import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArchitectureDocument } from '../../../../shared/architecture.ts';
import { ACTIVE_AGENT_RUNS, type AgentRun } from '../../../../shared/agentRuns.ts';
import { request } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { StatusBadge } from './ArchitectureUI.tsx';
import { RunQualityActions } from './AgentEvaluation.tsx';
import { MessageText } from '../ActivityFeed.tsx';
import { ToolTrajectory } from './AgentTools.tsx';
import { AgentActivityDashboard, type RunDrill } from './AgentActivityDashboard.tsx';
import { folder } from '../../stationOffices.ts';

export const RUN_STATUS: Record<AgentRun['status'], string> = { queued: 'Queued', running: 'Running', waiting_approval: 'Needs approval', succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' };
const activeRun = (run: AgentRun) => ACTIVE_AGENT_RUNS.includes(run.status);
const runUrl = (id: string) => `/api/agent-runs/${encodeURIComponent(id)}`;

export function AgentRunPanel({ run, onRun, onOpenAgent, compact = false }: { run: AgentRun; onRun: (run: AgentRun) => void; onOpenAgent: (id: string) => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [repeat, setRepeat] = useState(false); const [acknowledge, setAcknowledge] = useState(false);
  const uncertain = run.steps?.some(s => s.status === 'uncertain' || s.status === 'running') ?? false;
  const action = async (name: string, body?: unknown) => {
    setBusy(true); setError('');
    try { const next = await request<{ run: AgentRun }>('POST', `${runUrl(run.id)}/${name}`, body); onRun(next.run); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const download = async (index?: number) => {
    setBusy(true); setError('');
    try {
      let content: string; let name: string;
      if (index !== undefined) { const artifact = await request<{ path: string; content: string }>('GET', `${runUrl(run.id)}/artifacts/${index}`); content = artifact.content; name = artifact.path.split(/[\\/]/).at(-1)!; }
      else { const events = []; let after = 0; for (;;) { const page = await request<{ events: AgentRun['events'] }>('GET', `${runUrl(run.id)}/trace?after=${after}`); if (!page.events.length) break; events.push(...page.events); after = page.events.at(-1)!.seq; if (page.events.length < 200) break; } content = JSON.stringify({ ...run, events }, null, 2); name = `agent-trace-${run.id}.json`; }
      const url = URL.createObjectURL(new Blob([content], { type: 'application/octet-stream' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const duration = Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - (run.startedAt ?? run.createdAt)) / 1000));
  return <section className="agent-run-panel" aria-label="Agent run details">
    <header><div><h3>{run.agentName}</h3><p>{run.architectureTitle} · revision {run.revision} · {run.provider} · {run.model}</p></div><span className={`agent-run-status status-${run.status}`} role="status">{RUN_STATUS[run.status]}</span></header>
    <div className="agent-run-facts"><span>{duration}s elapsed</span><span>{run.usage.inputTokens.toLocaleString()} input tokens</span><span>{run.usage.outputTokens.toLocaleString()} output tokens</span><span>{run.usage.toolCalls} tool calls</span>{run.deploymentVersion && <span>Deployment v{run.deploymentVersion} · {run.source}</span>}</div>
    <div className="arch-actions"><button className="btn btn-small" disabled={busy} onClick={() => { void download(); }}>Download trace</button>{run.artifacts?.map((artifact, index) => <button className="btn btn-small" disabled={busy} key={artifact.path} title={artifact.path} onClick={() => { void download(index); }}>Download artifact {index + 1}</button>)}</div>
    <div className="arch-actions">{activeRun(run) ? <button className="btn btn-small" disabled={busy} onClick={() => { void action('cancel'); }}>Cancel run</button> : <>{!!run.steps?.length && run.status !== 'succeeded' && <button className="btn btn-go btn-small" disabled={busy || uncertain && !acknowledge} onClick={() => { void action('resume', { allowUncertainReplay: acknowledge }); }}>Resume unfinished steps</button>}<button className="btn btn-small" disabled={busy} aria-expanded={repeat} onClick={() => setRepeat(v => !v)}><Icon name="refresh" size={14} />Start a fresh attempt…</button></>}{run.agentId && <button className="btn btn-small" onClick={() => onOpenAgent(run.agentId!)}>Session details</button>}</div>
    {!activeRun(run) && uncertain && <label className="arch-replay-warning"><input type="checkbox" checked={acknowledge} onChange={e => setAcknowledge(e.target.checked)} />An unfinished step may have changed external state. I reviewed its trace and accept repeating that step. Completed steps will be reused.</label>}
    {repeat && <div className="arch-draft-notice"><p>A fresh attempt repeats every model request, tool call and delivery from the saved revision. Previously completed actions may happen again.</p><button className="btn btn-small" disabled={busy} onClick={() => { void action('retry'); }}>Run the saved revision again</button><button className="btn btn-small btn-ghost" onClick={() => setRepeat(false)}>Keep this run</button></div>}
    <RunQualityActions run={run} onUpdated={() => { void request<{ run: AgentRun }>('GET', runUrl(run.id)).then(next => onRun(next.run), e => setError(e.message)); }} />
    {run.pending && <div className="agent-run-approval"><h4>{run.pending.title}</h4><pre>{run.pending.detail}</pre><p>Decision expires {new Date(run.pending.expiresAt).toLocaleTimeString()}.</p><div className="arch-actions"><button className="btn btn-go btn-small" disabled={busy} onClick={() => { void action('decision', { pendingId: run.pending!.id, allow: true }); }}>Approve</button><button className="btn btn-small" disabled={busy} onClick={() => { void action('decision', { pendingId: run.pending!.id, allow: false }); }}>Reject</button></div></div>}
    {run.status === 'waiting_approval' && !run.pending && <p className="agent-run-notice">Open Session details to review the coding runtime's pending tool call.</p>}
    {run.error && <p className="arch-error" role="alert">{run.error}</p>}{error && <p className="arch-error" role="alert">{error}</p>}
    {!compact && <details className="agent-run-input"><summary>Task</summary><div><MessageText text={run.input} /></div></details>}
    {run.output && <div className="arch-test-output" aria-label="Agent run response" aria-live="polite"><MessageText text={run.output} /></div>}
    {!!run.toolCalls?.length && <ToolTrajectory calls={run.toolCalls} />}
    {!!run.steps?.length && <section className="arch-workflow-steps" aria-label="Workflow execution steps"><h4>Workflow steps</h4><ol>{run.steps.map(step => <li key={step.id}><strong>{step.name}</strong><span>{step.kind} · {step.status}</span>{step.error && <p>{step.error}</p>}</li>)}</ol></section>}
    <details className="agent-run-events" open={!compact}><summary>Activity · {run.events.length} events</summary><ol>{run.events.map(event => <li key={event.seq}><time>{new Date(event.ts).toLocaleTimeString()}</time><span className={`agent-event-kind kind-${event.kind}`}>{event.kind}</span><div><strong>{event.message}</strong>{event.detail && <pre>{event.detail}</pre>}</div></li>)}</ol></details>
  </section>;
}

/** Whether a run falls inside a dashboard drill-down: same project folder, then each chosen dimension. */
function inDrill(run: AgentRun, drill: RunDrill | undefined): boolean {
  if (!drill) return true;
  const key = folder(drill.project)?.key;
  if (!key || folder(run.project)?.key !== key) return false;
  if (drill.agentKey && `${run.architectureId}:${run.nodeId}` !== drill.agentKey) return false;
  if (drill.source && (run.source ?? 'chat') !== drill.source) return false;
  if (drill.model !== undefined && run.model !== drill.model) return false;
  if ((drill.from !== undefined && run.createdAt < drill.from) || (drill.to !== undefined && run.createdAt >= drill.to)) return false;
  if (!drill.status) return true;
  return drill.status === 'other' ? run.status === 'interrupted' || activeRun(run) : run.status === drill.status;
}

export function AgentActivity({ documents, project = '', onProject, initialRunId, onEdit, onOpenAgent, onDeployment }: { documents: ArchitectureDocument[]; project?: string; onProject?: (project: string) => void; initialRunId?: string; onEdit: (architectureId: string, nodeId: string) => void; onOpenAgent: (id: string) => void; onDeployment?: (id: string) => void }) {
  const [tab, setTab] = useState<'overview' | 'runs'>(initialRunId ? 'runs' : 'overview'); const [drill, setDrill] = useState<RunDrill>();
  const panelRef = useRef<HTMLDivElement>(null); const [revealRun, setRevealRun] = useState(false);
  const [runs, setRuns] = useState<AgentRun[]>([]); const [selectedId, setSelectedId] = useState(initialRunId ?? ''); const [selected, setSelected] = useState<AgentRun>();
  const [error, setError] = useState(''); const [actionError, setActionError] = useState(''); const [loaded, setLoaded] = useState(false); const [filter, setFilter] = useState('all'); const [query, setQuery] = useState(''); const [architecture, setArchitecture] = useState('all');
  const [launching, setLaunching] = useState<{ architectureId: string; nodeId: string }>(); const [task, setTask] = useState(''); const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    try { const next = await request<{ runs: AgentRun[] }>('GET', '/api/agent-runs'); setRuns(next.runs); setError(''); setLoaded(true); }
    catch (e) { setError((e as Error).message); setLoaded(true); }
  }, []);
  useEffect(() => { let pending = false; const refresh = async () => { if (pending) return; pending = true; await reload(); pending = false; }; void refresh(); const timer = setInterval(() => { void refresh(); }, 1500); return () => clearInterval(timer); }, [reload]);
  useEffect(() => {
    if (!selectedId) return;
    let active = true; let pending = false;
    const load = async () => { if (pending) return; pending = true; try { const next = await request<{ run: AgentRun }>('GET', runUrl(selectedId)); if (active) setSelected(next.run); } catch (e) { if (active) setError((e as Error).message); } finally { pending = false; } };
    void load(); const timer = setInterval(() => { void load(); }, 1200); return () => { active = false; clearInterval(timer); };
  }, [selectedId]);
  const agents = documents.flatMap(doc => doc.nodes.filter(n => n.kind === 'agent').map(node => ({ doc, node })));
  const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  const displayedAgents = agents.filter(({ doc, node }) => (architecture === 'all' || doc.id === architecture) && matches(`${node.name} ${doc.title} ${doc.project}`));
  const shown = runs.filter(run => (architecture === 'all' || run.architectureId === architecture) && matches(`${run.agentName} ${run.architectureTitle} ${run.project} ${run.error ?? ''}`) && (filter === 'all' || filter === 'active' ? filter === 'all' || activeRun(run) : run.status === filter) && inDrill(run, drill));
  const start = async () => {
    const doc = documents.find(d => d.id === launching?.architectureId); if (!doc || !launching || !task.trim()) return;
    setBusy(true); setActionError('');
    try { const result = await request<{ run: AgentRun }>('POST', `/api/architectures/${encodeURIComponent(doc.id)}/nodes/${encodeURIComponent(launching.nodeId)}/run`, { text: task, expectedRevision: doc.revision }); setSelectedId(result.run.id); setSelected(result.run); setLaunching(undefined); setTask(''); await reload(); }
    catch (e) { setActionError((e as Error).message); } finally { setBusy(false); }
  };
  const changed = (run: AgentRun) => { setSelectedId(run.id); setSelected(run); void reload(); };
  const openDrill = (next: RunDrill) => { setDrill(next); setFilter('all'); setTab('runs'); };
  const openRun = (id: string) => { setSelectedId(id); setTab('runs'); setRevealRun(true); };
  useEffect(() => {
    if (!revealRun || selected?.id !== selectedId || !panelRef.current) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    panelRef.current.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' }); setRevealRun(false);
  }, [revealRun, selected, selectedId]);
  return <section className="agent-activity" aria-label="Agent activity dashboard">
    <header className="agent-activity-heading"><div><h2>Agent activity</h2><p>{tab === 'overview' ? 'Run health for this project: outcomes, latency, estimated cost and tool errors over time.' : 'Manage configured agents and follow their runs across every architecture.'}</p></div>{tab === 'runs' && <button className="btn btn-small" onClick={() => { void reload(); }}><Icon name="refresh" size={14} />Refresh activity</button>}</header>
    <nav className="platform-detail-tabs" aria-label="Agent activity views">{([['overview', 'Overview'], ['runs', 'Runs']] as const).map(([value, label]) => <button key={value} className={tab === value ? 'selected' : ''} aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}>{label}</button>)}</nav>
    {tab === 'overview' ? <AgentActivityDashboard project={project} onProject={onProject} onDrill={openDrill} onOpenRun={openRun} /> : <>
    <div className="agent-activity-filters"><label>Search<input className="text-input" placeholder="Agent, architecture, or error" value={query} onChange={e => setQuery(e.target.value)} /></label><label>Architecture<select className="text-input" value={architecture} onChange={e => setArchitecture(e.target.value)}><option value="all">All architectures</option>{documents.map(doc => <option value={doc.id} key={doc.id}>{doc.title}</option>)}</select></label></div>
    {drill && <div className="agent-activity-drill" role="status"><span>{drill.label}<button type="button" aria-label="Clear the overview filter" onClick={() => setDrill(undefined)}><Icon name="close" size={12} /></button></span><small>From the overview · searches the latest 500 runs</small></div>}
    {error && <p className="arch-error" role="alert">{error}</p>}{actionError && <p className="arch-error" role="alert">{actionError}</p>}
    <section className="agent-activity-agents"><h3>Configured agents <span>{displayedAgents.length}</span></h3>{!displayedAgents.length ? <p className="agent-run-notice">Add an agent to an architecture, configure its brain, and save it to start running tasks.</p> : <div className="agent-table-scroll"><table><thead><tr><th>Agent</th><th>Architecture</th><th>Brain</th><th>Latest run</th><th><span className="arch-sr-only">Actions</span></th></tr></thead><tbody>{displayedAgents.map(({ doc, node }) => {
      const last = runs.find(r => r.architectureId === doc.id && r.nodeId === node.id);
      const resources = doc.nodes.filter(n => ['tool', 'memory'].includes(n.kind) && doc.edges.some(e => (e.source === node.id && e.target === n.id) || (e.target === node.id && e.source === n.id)));
      return <tr key={`${doc.id}:${node.id}`}><td><strong>{node.name}</strong><small>{resources.filter(n => n.config).length} graph resources{node.capabilities?.length ? ` · ${node.capabilities.length} capabilities` : ''}{resources.some(n => !n.config) ? ' · setup incomplete' : ''}</small></td><td>{doc.title}</td><td>{node.runtime ? node.runtime.kind === 'api' ? 'LLM API' : node.provider || 'Claude' : <StatusBadge tone="warning">Needs setup</StatusBadge>}</td><td>{last ? <button className={`agent-run-status status-${last.status}`} onClick={() => setSelectedId(last.id)}>{RUN_STATUS[last.status]}</button> : <span className="agent-activity-none">No runs yet</span>}</td><td><div className="arch-actions"><button className="btn btn-small" disabled={!node.runtime || !!last && activeRun(last)} onClick={() => { setLaunching({ architectureId: doc.id, nodeId: node.id }); setTask(''); }}>Run agent</button><button className="btn btn-small" onClick={() => onEdit(doc.id, node.id)}>Configure</button></div></td></tr>;
    })}</tbody></table></div>}</section>
    {launching && <form className="agent-activity-launch" onSubmit={e => { e.preventDefault(); void start(); }}><h3>Run {documents.find(d => d.id === launching.architectureId)?.nodes.find(n => n.id === launching.nodeId)?.name}</h3><label>Task<textarea className="text-input" aria-label="Agent task" required maxLength={12000} rows={3} value={task} onChange={e => setTask(e.target.value)} /></label><p>Uses the saved agent, connected tools and memory, and configured output destinations.</p><div className="arch-actions"><button className="btn btn-go btn-small" disabled={busy || !task.trim()}>{busy ? 'Starting…' : 'Start run'}</button><button className="btn btn-small" type="button" onClick={() => setLaunching(undefined)}>Cancel</button></div></form>}
    <section className="agent-activity-history"><h3>Run history</h3><div className="agent-run-filter-tabs" role="group" aria-label="Filter runs">{[['all', 'All runs'], ['active', 'Active'], ['waiting_approval', 'Needs approval'], ['succeeded', 'Completed'], ['failed', 'Failed'], ['cancelled', 'Cancelled'], ['interrupted', 'Interrupted']].map(([id, name]) => { const count = runs.filter(r => id === 'all' || (id === 'active' ? activeRun(r) : r.status === id)).length; return <button className={filter === id ? 'selected' : ''} data-status={id} data-empty={count === 0 || undefined} aria-pressed={filter === id} key={id} onClick={() => setFilter(id)}>{name}<span>{count}</span></button>; })}</div>
      <p className="platform-table-hint">Scroll the table horizontally to reach all columns and actions.</p>
      {!loaded ? <p role="status">Loading runs…</p> : !shown.length ? <p className="agent-run-notice">No runs match this view.</p> : <div className="agent-table-scroll"><table><thead><tr><th>Run</th><th>Status</th><th>Started</th><th>Usage</th><th><span className="arch-sr-only">Open run</span></th></tr></thead><tbody>{shown.map(run => <tr key={run.id} className={selectedId === run.id ? 'selected' : ''}><td><strong>{run.agentName}</strong><small>{run.architectureTitle} · r{run.revision}{run.deploymentVersion ? ` · v${run.deploymentVersion}` : ' · draft test'}</small>{run.deploymentId && onDeployment && <button className="platform-inline-action" onClick={() => onDeployment(run.deploymentId!)}>Open deployed agent</button>}</td><td><span className={`agent-run-status status-${run.status}`}>{RUN_STATUS[run.status]}</span></td><td>{new Date(run.createdAt).toLocaleString()}</td><td>{(run.usage.inputTokens + run.usage.outputTokens).toLocaleString()} tokens · {run.usage.toolCalls} tools</td><td><button className="btn btn-small" onClick={() => setSelectedId(run.id)}>View activity</button></td></tr>)}</tbody></table></div>}
    </section>
    <div ref={panelRef}>{selected && selected.id === selectedId && <AgentRunPanel key={selected.id} run={selected} onRun={changed} onOpenAgent={onOpenAgent} />}</div>
    </>}
  </section>;
}
