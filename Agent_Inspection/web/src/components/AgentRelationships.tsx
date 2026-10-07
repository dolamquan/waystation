import type { Agent } from '../api.ts';
import { subagentsByParent } from '../crew.ts';
import { STATUS_LABEL, subagentCountLabel } from '../format.ts';
import { CrewAvatar } from './CrewAvatar.tsx';
import { Icon } from './Icon.tsx';

export function AgentRelationships({ agent, agents, onSelect }: {
  readonly agent: Agent;
  readonly agents: readonly Agent[];
  readonly onSelect: (id: string) => void;
}) {
  const parent = agents.find(candidate => candidate.id === agent.parentId);
  const children = subagentsByParent(agents).get(agent.id) ?? [];
  if (!agent.parentId && !children.length) return null;
  const parentName = parent?.name ?? agent.subagent?.parentName ?? 'Parent session';
  return <section className="agent-relationships" aria-label="Agent relationships">
    {agent.parentId && <div className="relationship-parent">
      <span className="detail-section-label">Spawned by</span>
      {parent ? <button className="relationship-row" onClick={() => onSelect(parent.id)} aria-label={`Open parent ${parent.name}`}>
        <CrewAvatar id={parent.id} status={parent.status} size={32} animated={false} />
        <span><strong>{parent.name}</strong><small>Parent session</small></span><Icon name="arrow" size={14} />
      </button> : <p className="relationship-unavailable"><strong>{parentName}</strong><small>Parent session is no longer visible.</small></p>}
      {agent.subagent?.description && <p className="relationship-task">{agent.subagent.description}</p>}
    </div>}
    {children.length > 0 && <div className="relationship-children">
      <div className="detail-section-heading"><h3>Spawned subagents</h3><span>{subagentCountLabel(children.length)}</span></div>
      <div className="relationship-list">{children.map(child => <button key={child.id} className="relationship-row" onClick={() => onSelect(child.id)} aria-label={`Open subagent ${child.name}`}>
        <CrewAvatar id={child.id} status={child.status} size={32} animated={false} />
        <span><strong>{child.name}</strong><small>{child.subagent?.description ?? child.currentActivity ?? child.subagent?.type ?? 'Subagent'}</small></span>
        <span className={`relationship-status crew-status-${child.status}`}>{STATUS_LABEL[child.status]}</span>
      </button>)}</div>
    </div>}
  </section>;
}
