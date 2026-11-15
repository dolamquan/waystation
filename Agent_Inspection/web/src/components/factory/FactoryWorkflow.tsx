import { useId, useState, type CSSProperties } from 'react';
import type { Agent } from '../../../../daemon/domain/types.ts';
import type { FactoryDefinition, FactoryItem } from '../../../../shared/factory.ts';
import { managedProvider } from '../../../../shared/agentProviders.ts';
import { Icon } from '../Icon.tsx';
import { STAGE_STATE_LABELS, workflowProgress, workflowStages, latestRoleAttempt, type WorkflowStageId, type WorkflowStageState } from './workflowState.ts';

export function FactoryWorkflow({ definition, item, agents = [], onOpenAgent, onInspect }: {
  definition: FactoryDefinition; item?: FactoryItem; agents?: readonly Agent[];
  onOpenAgent?: (id: string) => void; onInspect?: (section: 'Plan' | 'Runs' | 'Checks' | 'Brief') => void;
}) {
  const uid = useId(); const [selectedId, setSelectedId] = useState<WorkflowStageId>();
  const progress = item ? workflowProgress(item) : undefined;
  const stages = (progress?.stages ?? workflowStages(definition).map(stage => ({ ...stage, state: 'pending' as const }))).map(stage => {
    if (!item || stage.state !== 'active' || !stage.role) return stage;
    const attempt = latestRoleAttempt(item, stage.role); const agent = agents.find(agent => agent.id === attempt?.agentId);
    const state: WorkflowStageState = attempt?.outcome === 'finished' || agent?.status === 'idle' ? 'finishing' : agent?.status === 'waiting' ? 'waiting' : agent?.status === 'busy' ? 'active' : agent?.status === 'stopped' ? 'blocked' : 'awaiting';
    return { ...stage, state };
  });
  const selected = stages.find(stage => stage.id === (selectedId ?? progress?.currentId)) ?? stages[0];
  const role = selected.role ? definition.roles[selected.role] : undefined;
  const attempt = item && selected.role ? latestRoleAttempt(item, selected.role) : undefined;
  const agent = agents.find(agent => agent.id === attempt?.agentId);
  const from = (stages.findIndex(stage => stage.id === 'checks') + .5) / stages.length * 1000;
  const to = (stages.findIndex(stage => stage.id === 'build') + .5) / stages.length * 1000;
  const current = stages.find(stage => stage.id === progress?.currentId);
  const inspection = selected.id === 'plan' || selected.id === 'approval' ? 'Plan' : selected.id === 'checks' ? 'Checks' : selected.role ? 'Runs' : 'Brief';
  return <section className="factory-workflow-map" aria-label="Workflow architecture">
    <div className="factory-map-heading"><div><h3>{item ? 'Workflow progress' : 'Workflow architecture'}</h3><p>{item ? `Recorded configuration v${definition.revision} · ${definition.workflow.name}` : `${definition.workflow.name} · configuration v${definition.revision}`}</p></div>
      {progress && <div className="factory-stage-count"><strong>{progress.completed} of {progress.total}</strong><span>stages complete</span></div>}
    </div>
    {progress && <div className="factory-progress-track" role="progressbar" aria-label="Completed workflow stages" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.completed} aria-valuetext={`${progress.completed} of ${progress.total} stages complete; ${current ? `${current.label}: ${STAGE_STATE_LABELS[current.state]}` : 'not started'}`}><span style={{ width: `${progress.completed / progress.total * 100}%` }} /></div>}
    <ol className="factory-flow-nodes" aria-label="Workflow stages" style={{ '--factory-stage-count': stages.length } as CSSProperties}>
      {stages.map((stage, index) => <li key={stage.id} className={`factory-flow-${stage.state}`}>
        <button type="button" aria-label={`${stage.label}: ${item ? STAGE_STATE_LABELS[stage.state] : stage.owner}`} aria-pressed={stage.id === selected.id} aria-current={progress?.currentId === stage.id ? 'step' : undefined} aria-controls={`${uid}-inspector`} onClick={() => setSelectedId(stage.id)}>
          <span className="factory-flow-symbol"><Icon name={stage.state === 'complete' ? 'check' : stage.role ? 'crew' : stage.id === 'checks' ? 'terminal' : stage.id === 'deliver' ? 'folder' : 'shield'} size={17} /><span>{index + 1}</span></span>
          <strong>{stage.label}</strong><span className="factory-flow-owner">{stage.owner}</span>
          {item && <small>{STAGE_STATE_LABELS[stage.state]}</small>}
        </button>{index < stages.length - 1 && <span className="factory-flow-edge"><Icon name="arrow" size={17} /></span>}
      </li>)}
    </ol>
    <div className="factory-repair-route">
      {definition.workflow.maxRepairs > 0 && <svg viewBox="0 0 1000 43" preserveAspectRatio="none" aria-hidden="true"><defs><marker id={`${uid}-arrow`} markerWidth="7" markerHeight="7" refX="3" refY="3" orient="auto"><path d="M0 0 6 3 0 6" fill="none" stroke="currentColor" strokeWidth="1.2" /></marker></defs><path d={`M ${from} 1 V 15 Q ${from} 29 ${from - 14} 29 H ${to + 14} Q ${to} 29 ${to} 15 V 4`} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" markerEnd={`url(#${uid}-arrow)`} /></svg>}
      <p><Icon name={definition.workflow.maxRepairs > 0 ? 'refresh' : 'alert'} size={14} />{definition.workflow.maxRepairs > 0 ? `Failed checks return to Builder · ${item ? `${item.repairs} of ${definition.workflow.maxRepairs} repairs used` : `up to ${definition.workflow.maxRepairs} automatic repairs`}` : 'Failed checks pause the work for your attention; automatic repair is off.'}</p>
    </div>
    {(!definition.workflow.requirePlan || !definition.workflow.review) && <p className="factory-map-note">Disabled in this workflow: {[!definition.workflow.requirePlan && 'planning and plan approval', !definition.workflow.review && 'agent review'].filter(Boolean).join('; ')}.</p>}
    <div className="factory-stage-inspector" id={`${uid}-inspector`}>
      <div><div className="factory-inspector-title"><strong>{selected.label}</strong><span>{item ? STAGE_STATE_LABELS[selected.state] : selected.owner}</span></div><p>{selected.description}</p>
        {role && <p className="factory-inspector-meta">{managedProvider(role.vendor)?.label ?? role.vendor} · {agent?.model ?? (role.model || 'Provider default')}</p>}
        {selected.id === 'checks' && <p className="factory-inspector-meta">{progress ? `${progress.checksRecorded} of ${progress.checksTotal} checks recorded for this candidate` : `${definition.workflow.checks.length} required checks`}{item?.validation?.outcome === 'running' && item.validation.currentCheck ? ` · Running: ${item.validation.currentCheck.name}` : ''}</p>}
        {selected.id === 'checks' && item?.validation?.outcome === 'invalidated' && <p>The workspace changed after these results were recorded. Run checks again before acceptance.</p>}
        {selected.id === 'checks' && definition.workflow.checks.length > 0 && <ul className="factory-map-checks">{definition.workflow.checks.map(check => <li key={check.id}><span>{check.name}</span><code>{check.command}</code></li>)}</ul>}
      </div><div className="factory-inspector-actions">
        {selectedId && progress?.currentId && selectedId !== progress.currentId && <button type="button" className="btn btn-small" onClick={() => setSelectedId(undefined)}>Follow current stage</button>}
        {agent && onOpenAgent && <button type="button" className="btn btn-small" onClick={() => onOpenAgent(agent.id)}>Open agent details</button>}
        {onInspect && <button type="button" className="btn btn-small" onClick={() => onInspect(inspection)}>Inspect {inspection.toLowerCase()}</button>}
      </div>
    </div>
    {progress && <p className="factory-map-note">Progress counts completed stages. It is not an estimate of remaining time.</p>}
  </section>;
}
