import { useEffect, useState } from 'react';
import { FACTORY_ACTIVE, FACTORY_ATTENTION, type FactoryDefinition, type FactoryItem, type FactorySnapshot } from '../../../../shared/factory.ts';
import { Modal } from '../Modal.tsx';
import { Icon } from '../Icon.tsx';
import { factoryApi } from './api.ts';
import { FactoryEditor, type FactoryTab } from './FactoryEditor.tsx';
import { FactoryItemDetail, FactoryWorkList } from './FactoryWork.tsx';
import './factory.css';
import type { Agent } from '../../../../daemon/domain/types.ts';
import { FactoryAgentRoster, FactoryOperations } from './FactoryRuntime.tsx';
import './factory-workflow.css';

const TABS: { id: FactoryTab; label: string; description: string }[] = [
  { id: 'overview', label: 'Overview', description: 'The state of your factory' }, { id: 'work', label: 'Work', description: 'Requests and their progress' },
  { id: 'agents', label: 'Agents', description: 'Your reusable crew' }, { id: 'workflows', label: 'Workflows', description: 'Stages and required checks' },
  { id: 'quality', label: 'Quality', description: 'Evidence across your work' }, { id: 'settings', label: 'Settings', description: 'Repository and context' },
];
export interface FactoryViewProps {
  data?: FactorySnapshot; error?: string; refresh: () => Promise<void>;
  initialItemId?: string; onOpenAgent: (id: string) => void; agents: readonly Agent[]; connected?: boolean;
}
const FACTORY_SELECTION_KEY = 'waystation-selected-factory';
function savedFactory(): string { try { return localStorage.getItem(FACTORY_SELECTION_KEY) ?? ''; } catch { return ''; } }
export function FactoryView({ data, error, refresh, initialItemId, onOpenAgent, agents, connected = true }: FactoryViewProps) {
  const [factoryId, setFactoryId] = useState(savedFactory); const [tab, setTab] = useState<FactoryTab>('overview');
  const [itemId, setItemId] = useState<string>(); const [create, setCreate] = useState<'factory' | 'work'>();
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState('all');
  const requestedFactoryId = data?.items.find(item => item.id === initialItemId)?.factoryId;
  useEffect(() => { if (factoryId) { try { localStorage.setItem(FACTORY_SELECTION_KEY, factoryId); } catch { /* Storage is optional. */ } } }, [factoryId]);
  useEffect(() => {
    if (requestedFactoryId && initialItemId) { setFactoryId(requestedFactoryId); setItemId(initialItemId); setTab('work'); }
  }, [initialItemId, requestedFactoryId]);
  if (!data) return <section className="factory-panel" aria-label="Software factory">{error ? <><p role="alert" className="error-text">{error}</p><button className="btn" onClick={() => void refresh()}>Retry connection</button></> : <p role="status">Loading your factories…</p>}</section>;
  const factory = data.factories.find(entry => entry.id === factoryId) ?? data.factories[0];
  const items = data.items.filter(item => item.factoryId === factory?.id);
  const selected = items.find(item => item.id === itemId);
  const open = (id: string) => { setItemId(id); setTab('work'); };
  const attention = items.filter(item => FACTORY_ATTENTION.includes(item.status));
  const visibleItems = items.filter(item => (!query || `${item.title} ${item.request}`.toLowerCase().includes(query.toLowerCase())) && (filter === 'all' || (filter === 'active' ? FACTORY_ACTIVE.includes(item.status) : filter === 'attention' ? FACTORY_ATTENTION.includes(item.status) : ['accepted', 'delivered'].includes(item.status))));
  return <section className="factory-workspace" aria-label="Software factory">
    {error && <div className="factory-callout" role="alert"><p>Connection interrupted: {error}. Showing the last received state.</p><button className="btn btn-small" onClick={() => void refresh()}>Retry connection</button></div>}
    <header className="factory-toolbar"><div><h2>{factory?.name ?? 'A place for repeatable work'}</h2></div><div className="factory-actions">
      {factory && <label className="factory-select-label">Factory<select aria-label="Select factory" value={factory.id} onChange={event => { setFactoryId(event.target.value); setItemId(undefined); }}>
        {data.factories.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select></label>}
      <button className="btn" onClick={() => setCreate('factory')}>New factory</button>
      {factory && <button className="btn btn-go" disabled={!factory.workflow.checks.length} title={!factory.workflow.checks.length ? 'Add required checks in Workflows first' : undefined} onClick={() => setCreate('work')}>New work</button>}
    </div></header>
    {!factory ? <div className="factory-welcome"><Icon name="tower" size={38} /><h3>Give your agents a process.</h3><p>Connect a repository, configure a crew and define the checks that make a change ready for you.</p><ol><li>Choose your project</li><li>Define its workflow and checks</li><li>Send your first request</li></ol><button className="btn btn-go" onClick={() => setCreate('factory')}>Create your first factory</button></div> : <div className="factory-layout">
      <nav className="factory-nav" aria-label="Factory sections">{TABS.map(entry => <button key={entry.id} aria-current={tab === entry.id ? 'page' : undefined} onClick={() => { setTab(entry.id); setItemId(undefined); }}><strong>{entry.label}</strong><small>{entry.description}</small>{entry.id === 'work' && attention.length > 0 && <span className="factory-nav-count">{attention.length}</span>}</button>)}</nav>
      <div className="factory-content" key={factory.id}>
        {tab === 'overview' && <>
          <div className="factory-activity-summary" aria-label="Factory activity summary">{[['In progress', items.filter(item => FACTORY_ACTIVE.includes(item.status)).length], ['Needs you', attention.length], ['Queued', items.filter(item => item.status === 'queued').length], ['Delivered', items.filter(item => item.status === 'delivered').length]].map(([name, value]) => <span key={name}><strong>{value}</strong>{name}</span>)}</div>
          {!factory.workflow.checks.length && <div className="factory-callout"><h3>Set your quality bar first</h3><p>Add the commands that build and test this project before sending work to the factory.</p><button className="btn" onClick={() => setTab('workflows')}>Configure required checks</button></div>}
          <FactoryOperations factory={factory} items={items} agents={agents} onOpenItem={open} onOpenAgent={onOpenAgent} connected={connected && !error} />
          <h3>{attention.length ? 'Waiting for your decision' : 'Recent work'}</h3>
          {items.length ? <FactoryWorkList items={(attention.length ? attention : items).slice(0, 6)} onOpen={open} /> : <div className="factory-empty"><p>Your factory is ready to be configured. Once checks are saved, queue a small, well-defined change to try the whole process.</p><button className="btn" onClick={() => setTab('agents')}>Meet your crew</button></div>}
        </>}
        {tab === 'work' && (selected ? <FactoryItemDetail key={selected.id} item={selected} refresh={refresh} onBack={() => setItemId(undefined)} onOpenAgent={onOpenAgent} agents={agents} connected={connected && !error} /> : <>
          <div className="factory-section-head"><div><h2>Work through the factory</h2><p>A request keeps its plan, attempts and evidence together.</p></div><span className="factory-badge">{items.length} items</span></div>
          <div className="factory-work-tools"><label>Search work<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a request…" /></label><label>Status<select aria-label="Status" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All work</option><option value="active">In progress</option><option value="attention">Needs attention</option><option value="complete">Accepted / delivered</option></select></label></div>
          {visibleItems.length ? <FactoryWorkList items={visibleItems} onOpen={open} /> : <div className="factory-empty"><h3>{items.length ? 'No matching work' : 'Your next change starts here'}</h3><p>{items.length ? 'Try another search or status.' : 'Describe a scoped request and its acceptance criteria. Work starts only when you choose Start work.'}</p></div>}
        </>)}
        {tab === 'agents' && <FactoryAgentRoster items={items} agents={agents} onOpenAgent={onOpenAgent} onOpenItem={open} connected={connected && !error} />}
        {(['agents', 'workflows', 'settings'] as FactoryTab[]).includes(tab) && <FactoryEditor key={`${factory.id}-${tab}`} factory={factory} tab={tab} onSaved={refresh} />}
        {tab === 'quality' && <FactoryQuality items={items} onOpen={open} />}
      </div>
    </div>}
    {create === 'factory' && <NewFactory onClose={() => setCreate(undefined)} onCreated={async next => { await refresh(); setFactoryId(next.id); setTab('workflows'); setCreate(undefined); }} />}
    {create === 'work' && factory && <NewWork factory={factory} onClose={() => setCreate(undefined)} onCreated={async next => { await refresh(); setCreate(undefined); open(next.id); }} />}
  </section>;
}
function NewFactory({ onClose, onCreated }: { onClose: () => void; onCreated: (factory: FactoryDefinition) => Promise<void> }) {
  const [name, setName] = useState(''); const [repository, setRepository] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <Modal title="Create a software factory" onClose={onClose}><form className="factory-dialog" onSubmit={event => {
    event.preventDefault(); setBusy(true); setError(''); void factoryApi.save({ name, repository }).then(({ factory }) => onCreated(factory)).catch(error => setError(error.message)).finally(() => setBusy(false));
  }}><p>A factory connects a project with a reusable crew, workflow and quality checks.</p><label>Factory name<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="Customer portal" autoFocus /></label><label>Repository path<input required maxLength={2000} value={repository} onChange={event => setRepository(event.target.value)} placeholder="C:\Projects\customer-portal" /></label><p className="factory-note">Choose the root of an existing Git repository with at least one commit. Work starts from committed files.</p>{error && <p role="alert" className="error-text">{error}</p>}<footer><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-go" disabled={busy}>{busy ? 'Creating…' : 'Create factory'}</button></footer></form></Modal>;
}
function NewWork({ factory, onClose, onCreated }: { factory: FactoryDefinition; onClose: () => void; onCreated: (item: FactoryItem) => Promise<void> }) {
  const [title, setTitle] = useState(''); const [request, setRequest] = useState(''); const [criteria, setCriteria] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <Modal title="Send work to the factory" onClose={onClose}><form className="factory-dialog" onSubmit={event => {
    event.preventDefault(); setBusy(true); setError(''); void factoryApi.create({ factoryId: factory.id, title, request, criteria }).then(({ item }) => onCreated(item)).catch(error => setError(error.message)).finally(() => setBusy(false));
  }}><p>{factory.name} · {factory.workflow.name} · configuration v{factory.revision}</p><label>Title<input required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} autoFocus placeholder="Add password reset" /></label><label>Request<textarea required maxLength={6000} rows={4} value={request} onChange={event => setRequest(event.target.value)} placeholder="What should change, and why?" /></label><label>Acceptance criteria<textarea required maxLength={4000} rows={4} value={criteria} onChange={event => setCriteria(event.target.value)} placeholder="Describe the observable behavior that makes this change complete." /></label><p className="factory-note">This queues the request. Agents launch only after you choose Start work.</p>{error && <p role="alert" className="error-text">{error}</p>}<footer><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-go" disabled={busy}>{busy ? 'Queuing…' : 'Queue work'}</button></footer></form></Modal>;
}
function FactoryQuality({ items, onOpen }: { items: FactoryItem[]; onOpen: (id: string) => void }) {
  const invalidated = items.filter(item => item.validation?.outcome === 'invalidated');
  const evidence = items.filter(item => item.validation?.outcome !== 'invalidated').flatMap(item => item.evidence); const passed = evidence.filter(check => check.outcome === 'passed').length;
  const failures = items.filter(item => item.evidence.some(check => check.outcome !== 'passed') || item.status === 'blocked' || item.validation?.outcome === 'invalidated');
  return <><div className="factory-section-head"><div><h2>Evidence, then confidence</h2><p>Results from the latest validation of each work item.</p></div></div>
    <div className="factory-ledger"><div><span>Current recorded checks</span><strong>{evidence.length}</strong></div><div><span>Passing current checks</span><strong>{evidence.length ? `${Math.round(passed / evidence.length * 100)}%` : '—'}</strong></div><div><span>Automatic repairs</span><strong>{items.reduce((sum, item) => sum + item.repairs, 0)}</strong></div><div><span>Accepted changes</span><strong>{items.filter(item => ['accepted', 'delivered'].includes(item.status) && item.validation?.outcome !== 'invalidated').length}</strong></div></div>
    {invalidated.length > 0 && <div className="factory-callout" role="status"><strong>{invalidated.length} {invalidated.length === 1 ? 'candidate needs' : 'candidates need'} revalidation</strong><p>Their retained results are excluded from current check totals and pass rates because the workspace changed.</p></div>}
    <h3>Failures to investigate</h3>{failures.length ? <FactoryWorkList items={failures} onOpen={onOpen} /> : <p className="factory-empty">{evidence.length ? 'No recorded failures in the latest checks.' : 'No validation results yet. Run your first work item to collect real evidence.'}</p>}
    <h3>Latest check results</h3>{items.filter(item => item.evidence.length).map(item => <div className="factory-quality-row" key={item.id}><button className="factory-link" onClick={() => onOpen(item.id)}>{item.title}</button><span>{item.validation?.outcome === 'invalidated' ? 'Needs revalidation · retained results' : `${item.evidence.filter(check => check.outcome === 'passed').length} / ${item.evidence.length} passed`}</span></div>)}
    <p className="factory-note">These figures describe recorded commands, not a prediction of software correctness. Evaluate the acceptance criteria and review findings before accepting a change.</p>
  </>;
}
export function FactoryAttention({ items, onOpen }: { items: FactoryItem[]; onOpen: (id: string) => void }) {
  const waiting = items.filter(item => FACTORY_ATTENTION.includes(item.status));
  if (!waiting.length) return null;
  return <section className="factory-panel" aria-label="Factory decisions"><div className="factory-section-head"><div><h2>Factory decisions</h2><p>Plans, candidates and blocked work waiting for you.</p></div></div><FactoryWorkList items={waiting} onOpen={onOpen} /></section>;
}
