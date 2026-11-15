import { useEffect, useState } from 'react';
import { FACTORY_ACTIVE, FACTORY_STATUS_LABELS, type FactoryAttempt, type FactoryItem } from '../../../../shared/factory.ts';
import { Confirm } from '../Modal.tsx';
import { factoryApi } from './api.ts';
import type { Agent } from '../../../../daemon/domain/types.ts';
import { FactoryWorkflow } from './FactoryWorkflow.tsx';
import { FactoryAgentRoster } from './FactoryRuntime.tsx';
import { factoryCurrentActivity, workflowProgress } from './workflowState.ts';

export function FactoryStatusBadge({ item }: { item: FactoryItem }) {
  return <span className={`factory-badge factory-status-${item.status}`}>{FACTORY_STATUS_LABELS[item.status]}</span>;
}
export function FactoryWorkList({ items, onOpen }: { items: FactoryItem[]; onOpen: (id: string) => void }) {
  return <div className="factory-work-list">{items.map(item => { const progress = workflowProgress(item); return <button className="factory-work-row" onClick={() => onOpen(item.id)} key={item.id}>
    <span><strong>{item.title}</strong><small>{item.definition.workflow.name} · configuration v{item.definition.revision} · {progress.completed}/{progress.total} stages complete</small></span>
    <FactoryStatusBadge item={item} /><span className="factory-row-arrow" aria-hidden="true">→</span>
  </button>; })}</div>;
}
/** An attempt's result: structured when the agent used the factory bridge, otherwise its replies. */
function AttemptResult({ attempt }: { attempt: FactoryAttempt }) {
  const submission = attempt.submission;
  const source = submission ? 'Structured' : 'From agent replies';
  return <details open={attempt.stage === 'reviewer'}>
    <summary>Agent result <span className="factory-badge">{source}</span></summary>
    {submission ? <>
      <p className="factory-prose"><strong>{submission.summary}</strong></p>
      {submission.findings.length > 0 && <ul className="factory-findings">{submission.findings.map((finding, index) => <li key={`${finding.severity}-${index}`}>
        <span className={`factory-badge factory-finding-${finding.severity}`}>{finding.severity}</span> {finding.text}{finding.file && <code>{finding.file}</code>}
      </li>)}</ul>}
      {submission.body && <p className="factory-prose">{submission.body}</p>}
    </> : <p className="factory-prose">{attempt.output}</p>}
  </details>;
}
const DETAIL_TABS = ['Workflow','Brief', 'Plan', 'Runs', 'Changes', 'Checks', 'Activity'] as const;
type DetailTab = typeof DETAIL_TABS[number];
export function FactoryItemDetail({ item, refresh, onBack, onOpenAgent, agents, connected }: { item: FactoryItem; refresh: () => Promise<void>; onBack: () => void; onOpenAgent: (id: string) => void; agents: readonly Agent[]; connected: boolean }) {
  const [tab, setTab] = useState<DetailTab>('Workflow');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [merge, setMerge] = useState(false);
  const [diff, setDiff] = useState<{ stat: string; patch: string; truncated: boolean }>(); const [diffError, setDiffError] = useState('');
  useEffect(() => {
    if (tab !== 'Changes' || !item.workspace) return;
    let stopped = false; setDiff(undefined); setDiffError('');
    void factoryApi.diff(item.id).then(({ diff }) => { if (!stopped) setDiff(diff); }).catch(error => { if (!stopped) setDiffError(error.message); });
    return () => { stopped = true; };
  }, [tab, item.id, item.candidate, item.status, item.workspace]);
  const action = async (name: string) => {
    setBusy(true); setError('');
    try { await factoryApi.action(item.id, name); await refresh(); }
    catch (error) { setError((error as Error).message); await refresh(); }
    finally { setBusy(false); }
  };
  return <section className="factory-item" aria-label="Work item details">
    <button className="factory-back" onClick={onBack}>← All work</button>
    <div className="factory-section-head"><div><h2>{item.title}</h2><p>{item.definition.workflow.name} · configuration v{item.definition.revision}</p></div><FactoryStatusBadge item={item} /></div>
    <div className="factory-callout"><p>{factoryCurrentActivity(item, agents)}</p><div className="factory-actions">
      {item.status === 'queued' && <button className="btn btn-go" disabled={busy} onClick={() => void action('start')}>Start work</button>}
      {item.status === 'plan_review' && <button className="btn btn-go" disabled={busy} onClick={() => { setTab('Plan'); void action('approve-plan'); }}>Approve plan & build</button>}
      {item.status === 'acceptance' && <button className="btn btn-go" disabled={busy} onClick={() => void action('accept')}>Accept candidate</button>}
      {item.status === 'accepted' && <button className="btn btn-go" disabled={busy} onClick={() => setMerge(true)}>Merge accepted branch</button>}
      {['paused', 'blocked'].includes(item.status) && <button className="btn" disabled={busy} onClick={() => void action('resume')}>Resume work</button>}
      {item.workspace && ['paused', 'blocked', 'acceptance', 'accepted'].includes(item.status) && <button className="btn" disabled={busy} onClick={() => void action('validate')}>Run checks again</button>}
      {(FACTORY_ACTIVE.includes(item.status) || item.status === 'plan_review') && <button className="btn" disabled={busy} onClick={() => void action('pause')}>Pause work</button>}
      {!['accepted', 'delivered', 'cancelled'].includes(item.status) && <button className="btn btn-ghost" disabled={busy} onClick={() => void action('cancel')}>Cancel work</button>}
      {busy && <span role="status">Updating work…</span>}
    </div></div>
    {error && <p className="error-text" role="alert">{error}</p>}
    <nav className="factory-detail-nav" aria-label="Work item sections">{DETAIL_TABS.map(name => <button key={name} aria-current={name === tab ? 'page' : undefined} onClick={() => setTab(name)}>{name}{name === 'Checks' && item.evidence.length > 0 && ` (${item.evidence.length})`}</button>)}</nav>
    <div className="factory-detail-body">
      {tab === 'Workflow' && <><FactoryWorkflow definition={item.definition} item={item} agents={agents} onOpenAgent={onOpenAgent} onInspect={setTab} /><FactoryAgentRoster items={[item]} agents={agents} onOpenAgent={onOpenAgent} connected={connected} /></>}
      {tab === 'Brief' && <><h3>Request</h3><p className="factory-prose">{item.request}</p><h3>Acceptance criteria</h3><p className="factory-prose">{item.criteria}</p>
        <dl className="factory-facts"><div><dt>Repository</dt><dd>{item.definition.repository}</dd></div><div><dt>Branch</dt><dd>{item.branch ?? 'Created when work starts'}</dd></div><div><dt>Candidate revision</dt><dd>{item.candidate ?? 'Available after implementation'}</dd></div><div><dt>Automatic repairs</dt><dd>{item.repairs} / {item.definition.workflow.maxRepairs}</dd></div></dl>
        <p className="factory-note">Acceptance records your decision on this revision and its evidence. It does not run additional tests.</p></>}
      {tab === 'Plan' && <><h3>Implementation plan</h3><p className="factory-prose">{item.plan ?? (item.definition.workflow.requirePlan ? 'The planner’s proposal will appear here after its turn finishes.' : 'This workflow starts directly with implementation. Your request and acceptance criteria guide the builder.')}</p>{item.planApprovedAt && <p className="factory-note">Approved {new Date(item.planApprovedAt).toLocaleString()}.</p>}</>}
      {tab === 'Runs' && <><h3>Agent attempts</h3>{!item.attempts.length && <p>No agents have been launched. Start this work item when ready.</p>}{item.attempts.map((attempt, i) => <article className="factory-attempt" key={attempt.id}>
        <div className="factory-section-head"><strong>{i + 1}. {attempt.stage}</strong><span className="factory-badge">{attempt.outcome}</span></div>
        <p className="factory-note">{new Date(attempt.startedAt).toLocaleString()}</p>
        {attempt.agentId && agents.some(agent => agent.id === attempt.agentId) && <button className="btn btn-small" onClick={() => onOpenAgent(attempt.agentId!)}>Open agent details</button>}
        {attempt.output && <details open={attempt.stage === 'reviewer'}><summary>Agent result</summary><p className="factory-prose">{attempt.output}</p></details>}
      </article>)}</>}
      {tab === 'Changes' && <><h3>Branch changes</h3>{!item.workspace ? <p>Start work to create an isolated branch.</p> : diffError ? <p className="error-text" role="alert">{diffError}</p> : !diff ? <p role="status">Loading changes…</p> : <><pre>{diff.stat || 'No file changes.'}</pre><pre className="factory-diff">{diff.patch}</pre>{diff.truncated && <p>Diff preview truncated. Inspect the branch locally for the complete changes.</p>}</>}</>}
      {tab === 'Checks' && <><h3>Validation evidence</h3>{item.validation?.outcome === 'invalidated' && <div className="factory-callout" role="status"><h3>Evidence needs revalidation</h3><p>The workspace changed after validation. These results are retained for the earlier candidate and cannot support acceptance of the current changes. Run checks again.</p></div>}{item.evidence.length === 0 && <p>Check results appear after implementation. Unknown or missing results do not count as passing.</p>}{item.evidence.map(check => <details className="factory-attempt" key={check.id} open={check.outcome !== 'passed'}>
        <summary>{check.name} · {check.outcome.replace('_', ' ')}{item.validation?.outcome === 'invalidated' ? ' (previous candidate)' : ''}</summary><p className="factory-note">Revision {check.revision}</p><code>{check.command}</code><pre>{check.output || '(No command output)'}</pre>
      </details>)}{item.validationHistory?.length ? <><h3>Earlier validations</h3>{item.validationHistory.map((results, index) => <details className="factory-attempt" key={index}><summary>Validation {index + 1} · {results.filter(result => result.outcome === 'passed').length} / {results.length} passed</summary>{results.map(check => <div key={check.id}><strong>{check.name} · {check.outcome}</strong><p className="factory-note">Revision {check.revision}</p><pre>{check.output || '(No command output)'}</pre></div>)}</details>)}</> : null}</>}
      {tab === 'Activity' && <><h3>Run history</h3><ol className="factory-activity">{item.activity.map(event => <li key={event.id}><time>{new Date(event.at).toLocaleString()}</time><p>{event.message}</p></li>)}</ol></>}
    </div>
    {merge && <Confirm title="Merge accepted candidate?" body={`This merges ${item.branch} into ${item.baseBranch}. Waystation checks that the evidence and acceptance still match, and refuses if the target branch has moved or your checkout has tracked changes.`} confirmLabel="Merge branch" onClose={() => setMerge(false)} onConfirm={() => void action('merge')} />}
  </section>;
}
