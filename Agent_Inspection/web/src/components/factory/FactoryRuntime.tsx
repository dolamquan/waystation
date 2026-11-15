import { useEffect, useState } from 'react';
import type { Agent } from '../../../../daemon/domain/types.ts';
import type { FactoryDefinition, FactoryItem } from '../../../../shared/factory.ts';
import { FACTORY_STATUS_LABELS } from '../../../../shared/factory.ts';
import { managedProvider, providerLabel } from '../../../../shared/agentProviders.ts';
import { timeAgo } from '../../format.ts';
import { Icon } from '../Icon.tsx';
import { FactoryWorkflow } from './FactoryWorkflow.tsx';
import { factoryAssignments, factoryCurrentActivity, factoryDuration, preferredWorkItem, workflowProgress } from './workflowState.ts';

export function FactoryAgentRoster({ items, agents, onOpenAgent, onOpenItem, connected = true }: {
  items: FactoryItem[]; agents: readonly Agent[]; onOpenAgent: (id: string) => void;
  onOpenItem?: (id: string) => void; connected?: boolean;
}) {
  const assignments = factoryAssignments(items, agents);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!assignments.length) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [assignments.length]);
  return <section className="factory-runtime-roster" aria-label="Assigned factory agents">
    <div className="factory-section-head"><div><h3>Assigned agents</h3><p>{assignments.length ? `${assignments.filter(row => row.working).length} working · ${assignments.filter(row => row.waiting).length} need input` : 'Agents appear here when a work item assigns them a stage.'}</p></div><span className="factory-runtime-connection"><span className={`connection-dot ${connected ? 'live' : ''}`} />{connected ? 'Live session updates' : 'Last received session state'}</span></div>
    {!assignments.length ? <p className="factory-runtime-empty">No agent is currently assigned. Work waiting for your approval stays paused at its gate.</p> : <ul className="factory-runtime-list">{assignments.map(({ item, attempt, agent, label, working, waiting }) => <li key={attempt.id}>
      <div className={`factory-runtime-avatar ${working ? 'is-working' : waiting ? 'is-waiting' : ''}`}><Icon name="crew" size={21} /></div>
      <div className="factory-runtime-main"><div><strong>{agent?.name ?? attempt.stage[0].toUpperCase() + attempt.stage.slice(1)}</strong><span className={`factory-badge ${waiting ? 'factory-status-blocked' : ''}`}>{label}</span></div>
        {onOpenItem ? <button className="factory-link" onClick={() => onOpenItem(item.id)}>{item.title}</button> : <span className="factory-runtime-item">{item.title}</span>}
        <p>{attempt.stage[0].toUpperCase() + attempt.stage.slice(1)} · {agent ? providerLabel(agent) : managedProvider(item.definition.roles[attempt.stage].vendor)?.label ?? item.definition.roles[attempt.stage].vendor} · {agent?.model ?? (item.definition.roles[attempt.stage].model || 'Provider default')}</p>
        <p className="factory-runtime-activity">{agent?.currentActivity ?? (agent ? 'Waiting for the next activity update.' : 'The assignment is recorded; its session is not currently visible.')}</p>
      </div><div className="factory-runtime-time"><strong>{factoryDuration(attempt.startedAt, attempt.finishedAt ?? now)}</strong><span>{agent?.lastEventAt ? `Activity ${timeAgo(agent.lastEventAt, now)}` : 'Since assignment'}</span>
        {agent && <button className="btn btn-small" onClick={() => onOpenAgent(agent.id)}>Open agent details</button>}
      </div>
    </li>)}</ul>}
    {items.some(item => item.status === 'validating') && <div className="factory-checks-running"><Icon name="terminal" size={18} /><div><strong>Validation is running</strong>{items.filter(item => item.status === 'validating').map(item => <p key={item.id}>{item.title} · {item.validation?.currentCheck?.name ?? 'Preparing candidate checks'} · {item.evidence.length} of {item.definition.workflow.checks.length} checks recorded</p>)}</div></div>}
  </section>;
}
export function FactoryOperations({ factory, items, agents, onOpenItem, onOpenAgent, connected }: {
  factory: FactoryDefinition; items: FactoryItem[]; agents: readonly Agent[]; onOpenItem: (id: string) => void;
  onOpenAgent: (id: string) => void; connected: boolean;
}) {
  const [focusId, setFocusId] = useState('auto');
  const focused = focusId === 'auto' ? preferredWorkItem(items) : items.find(item => item.id === focusId);
  const definition = focused?.definition ?? factory;
  const progress = focused ? workflowProgress(focused) : undefined;
  return <>
    <div className="factory-operations-heading"><div><h2>Workflow & activity</h2><p>See the route, the current handoff and the agents doing the work.</p></div><label>Workflow view<select aria-label="Workflow view" value={focusId} onChange={event => setFocusId(event.target.value)}><option value="auto">Follow current work</option><option value="configuration">Factory configuration</option>{items.map(item => <option value={item.id} key={item.id}>{item.title} · {FACTORY_STATUS_LABELS[item.status]}</option>)}</select></label></div>
    {focused && <div className="factory-focused-work"><div><span className="factory-badge">{FACTORY_STATUS_LABELS[focused.status]}</span><strong>{focused.title}</strong><p>{factoryCurrentActivity(focused, agents)}</p>{focused.definition.revision !== factory.revision && <p className="factory-map-note">This work uses saved configuration v{focused.definition.revision}. Current factory settings are v{factory.revision}.</p>}</div><button className="btn btn-small" onClick={() => onOpenItem(focused.id)}>Open work item</button></div>}
    {!focused && <p className="factory-map-note">Showing the configured process. Start a work item to follow its actual progress here.</p>}
    <FactoryWorkflow key={focused?.id ?? `definition-${definition.id}`} definition={definition} item={focused} agents={agents} onOpenAgent={onOpenAgent} />
    {focused?.status === 'validating' && progress && <p className="factory-map-note">{progress.checksRecorded} of {progress.checksTotal} required checks recorded. Candidate {focused.candidate?.slice(0, 10)}.</p>}
    <FactoryAgentRoster items={items} agents={agents} onOpenAgent={onOpenAgent} onOpenItem={onOpenItem} connected={connected} />
  </>;
}
