import { useEffect, useState } from 'react';
import type { ArchitectureDocument } from '../../../../shared/architecture.ts';
import { ACTIVE_AGENT_RUNS, type AgentRun } from '../../../../shared/agentRuns.ts';
import { request } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { AgentRunPanel, RUN_STATUS } from './AgentActivity.tsx';

export function WorkflowRunner({ document: doc, unsaved, onConfigure, onOpenAgent, onActivity }: { document: ArchitectureDocument; unsaved: number; onConfigure: (id: string) => void; onOpenAgent: (id: string) => void; onActivity: (id: string) => void }) {
  const agents = doc.nodes.filter(n => n.kind === 'agent');
  const initial = agents.find(n => doc.edges.some(e => e.target === n.id && doc.nodes.some(input => input.id === e.source && input.kind === 'input'))) ?? agents[0];
  const [entry, setEntry] = useState(initial?.id ?? ''); const [task, setTask] = useState(''); const [run, setRun] = useState<AgentRun>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!agents.some(n => n.id === entry)) setEntry(initial?.id ?? ''); }, [doc.revision, entry, initial?.id]);
  useEffect(() => {
    if (!run || !ACTIVE_AGENT_RUNS.includes(run.status)) return;
    let alive = true;
    const poll = () => request<{ run: AgentRun }>('GET', `/api/agent-runs/${encodeURIComponent(run.id)}`).then(next => { if (alive) setRun(next.run); }, e => { if (alive) setError(e.message); });
    const timer = setInterval(() => { void poll(); }, 1200); return () => { alive = false; clearInterval(timer); };
  }, [run?.id, run?.status]);
  const reachable = new Set<string>(); const visit = (id: string) => { if (reachable.has(id)) return; reachable.add(id); const node = doc.nodes.find(n => n.id === id); if (node?.kind !== 'output') for (const edge of doc.edges.filter(e => e.source === id)) if (!['tool', 'memory'].includes(doc.nodes.find(n => n.id === edge.target)?.kind ?? '')) visit(edge.target); }; if (entry) visit(entry);
  const missing = agents.find(n => reachable.has(n.id) && (!n.runtime || !n.description.trim()));
  const start = async () => {
    if (busy || !task.trim() || unsaved) return;
    setBusy(true); setError('');
    try { const next = await request<{ run: AgentRun }>('POST', `/api/architectures/${encodeURIComponent(doc.id)}/run`, { text: task, entryNodeId: entry, expectedRevision: doc.revision }); setRun(next.run); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section className="arch-workflow-runner" aria-label="Run workflow"><div><h2>Run your workflow</h2><p>Agent links execute handoffs. Routers choose branches; approvals pause for a decision. Each step is recorded.</p></div>
    {missing ? <div className="arch-actions"><button className="btn btn-go" onClick={() => onConfigure(missing.id)}>Configure {missing.name}<Icon name="arrow" size={14} /></button><small>Save a brain and instructions for each agent before running.</small></div> : <form onSubmit={e => { e.preventDefault(); void start(); }}>
      {agents.length > 1 && <label>Start from<select className="text-input" value={entry} onChange={e => setEntry(e.target.value)}>{agents.map(n => <option value={n.id} key={n.id}>{n.name}</option>)}</select></label>}
      <label className="arch-workflow-task">Workflow task<textarea className="text-input" rows={2} required maxLength={12000} value={task} onChange={e => setTask(e.target.value)} placeholder="What should this workflow accomplish?" /></label>
      <button className="btn btn-go" disabled={busy || !entry || !!unsaved || !task.trim() || !!run && ACTIVE_AGENT_RUNS.includes(run.status)}><Icon name="play" size={15} />{busy ? 'Starting…' : 'Run workflow'}</button>
      {!!unsaved && <p role="status">Save or discard your {unsaved} configuration draft{unsaved === 1 ? '' : 's'} first.</p>}
    </form>}
    {error && <p className="arch-error" role="alert">{error}</p>}
    {run && <details className="arch-latest-run" open={run.status !== 'succeeded'}><summary>Latest run · {RUN_STATUS[run.status]} · {run.steps?.filter(s => s.status === 'succeeded').length ?? 0} completed steps</summary><button className="btn btn-small" onClick={() => onActivity(run.id)}>Open full run activity</button><AgentRunPanel compact run={run} onRun={setRun} onOpenAgent={onOpenAgent} /></details>}
  </section>;
}
