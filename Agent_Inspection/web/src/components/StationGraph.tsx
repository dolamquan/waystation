import type { CSSProperties } from 'react';
import { providerLabel } from '../../../shared/agentProviders.ts';
import type { Agent, PendingInterception, TeamView } from '../api.ts';
import { characterFor } from '../crew.ts';
import { STATUS_LABEL, formatUsd } from '../format.ts';
import type { Seat } from '../stationLayout.ts';
import { CrewAvatar } from './CrewAvatar.tsx';
import { Icon } from './Icon.tsx';
import { StationApproval, type Notify } from './StationApproval.tsx';
import { breakerAlarm, deskBubble, workUpdate } from './stationEvents.ts';

/** One unit on the canvas: a solo session with its subagents, or a team with its seats. */
export type GraphCluster =
  | { readonly kind: 'agent'; readonly agent: Agent; readonly helpers: readonly Agent[] }
  | { readonly kind: 'team'; readonly team: TeamView; readonly seats: readonly Seat[] };

interface StationGraphProps {
  readonly clusters: readonly GraphCluster[];
  /** Every known session, so a subagent can name a parent that lives in another office. */
  readonly allAgents: readonly Agent[];
  readonly selectedId?: string;
  readonly onSelect?: (id: string) => void;
  readonly onOpenTeam?: (teamId: string) => void;
  readonly pending?: readonly PendingInterception[];
  readonly notify?: Notify;
  /** Sample crew: approval buttons only explain themselves, never call the daemon. */
  readonly demo?: boolean;
  readonly ready?: ReadonlySet<string>;
  readonly onLook?: (id: string) => void;
}

type NodeContext = Pick<StationGraphProps, 'onSelect' | 'pending' | 'notify' | 'demo' | 'onLook'>;

interface NodeProps {
  readonly agent: Agent;
  /** Overrides the session name, e.g. a team member's handle. */
  readonly label?: string;
  readonly compact?: boolean;
  readonly parentName?: string;
  readonly helperCount?: number;
  readonly selected: boolean;
  readonly isReady: boolean;
  readonly context: NodeContext;
}

/** What the node asks of the operator, if anything: a held call, a reply, or a finished change. */
function NodeSignal({ agent, isReady, context }: Pick<NodeProps, 'agent' | 'isReady' | 'context'>) {
  const bubble = deskBubble(agent, context.pending ?? []);
  if (bubble?.kind === 'approval' || bubble?.kind === 'question') {
    return <StationApproval agent={agent} item={bubble.item} question={bubble.kind === 'question'} demo={context.demo} notify={context.notify} onSelect={context.onSelect} />;
  }
  if (bubble?.kind === 'ask') return <div className="node-ask"><Icon name="message" size={13} />Waiting for your reply</div>;
  if (isReady && context.onLook) {
    return <button className="node-ready" onClick={() => context.onLook?.(agent.id)} aria-label={`${agent.name} finished a change. Ready to look`}><Icon name="sparkle" size={13} />Ready to look<Icon name="arrow" size={13} /></button>;
  }
  return null;
}

/** A session on the canvas. The header opens it; signals underneath act on it in place. */
function AgentNode({ agent, label, compact = false, parentName, helperCount = 0, selected, isReady, context }: NodeProps) {
  const alarm = breakerAlarm(agent);
  const activity = workUpdate(agent);
  const cost = agent.usage?.costUsd;
  const name = label ?? agent.name;
  const lineage = agent.parentId ? `from ${parentName ?? agent.subagent?.parentName ?? 'parent session'}` : undefined;
  const style = { '--node-color': characterFor(agent.id).color } as CSSProperties;
  const hasMeta = !!alarm || cost !== undefined || helperCount > 0;
  return (
    <article className={`node node-${agent.status} ${compact ? 'node-compact' : ''} ${selected ? 'node-selected' : ''}`} style={style} aria-label={`${name}, ${STATUS_LABEL[agent.status]}`}>
      <button className="node-head" onClick={() => context.onSelect?.(agent.id)} title={`${agent.project}\n${agent.currentActivity ?? 'No activity captured yet'}`} aria-label={`Open ${name}`}>
        <CrewAvatar id={agent.id} status={agent.status} size={compact ? 24 : 28} />
        <span className="node-title">
          <strong>{name}</strong>
          <small>{lineage ?? `${providerLabel(agent)} · ${agent.project}`}</small>
        </span>
        <span className={`node-status status-${agent.status}`}><i />{STATUS_LABEL[agent.status]}</span>
      </button>
      {(activity || hasMeta) && <div className="node-body">
        {activity && <p className="node-activity" title={activity}>{activity}</p>}
        {hasMeta && <div className="node-meta">
          {cost !== undefined && <span title="Cost so far">{formatUsd(cost)}</span>}
          {helperCount > 0 && <span>{helperCount} {helperCount === 1 ? 'subagent' : 'subagents'}</span>}
          {alarm && <span className={`node-guard node-guard-${alarm.level === 'warned' ? 'warn' : 'stop'}`} title={`Runaway guard (${alarm.level}): ${alarm.reason}`}><Icon name="alert" size={12} />Guard {alarm.level}</span>}
        </div>}
      </div>}
      <NodeSignal agent={agent} isReady={isReady} context={context} />
    </article>
  );
}

function TeamGroup({ cluster, props }: { readonly cluster: Extract<GraphCluster, { kind: 'team' }>; readonly props: StationGraphProps }) {
  const { team, seats } = cluster;
  const done = team.tasks.filter(task => task.status === 'done').length;
  const style = { '--node-color': characterFor(team.id).color } as CSSProperties;
  return (
    <section className="graph-team" style={style} aria-label={`Team ${team.name}`}>
      <header className="graph-team-head">
        <span className="graph-team-mark" aria-hidden="true" />
        <span className="graph-team-name"><strong>{team.name}</strong><small>Team · {done}/{team.tasks.length} tasks</small></span>
        {props.onOpenTeam && <button className="node-btn" onClick={() => props.onOpenTeam?.(team.id)} aria-label={`Open team ${team.name}`}>Open<Icon name="arrow" size={12} /></button>}
      </header>
      <div className="graph-team-seats">
        {seats.map(seat => {
          const seatLabel = `${seat.member.name}${seat.member.role === 'lead' ? ' · lead' : ''}`;
          if (seat.agent) return <AgentNode key={seat.member.id} agent={seat.agent} label={seatLabel} compact selected={seat.agent.id === props.selectedId} isReady={!!props.ready?.has(seat.agent.id)} context={props} />;
          return (
            <div key={seat.member.id} className="node node-ghost node-compact">
              <div className="node-head node-head-static">
                <CrewAvatar id={`${team.id}:${seat.member.name}`} status="stopped" size={24} animated={false} />
                <span className="node-title"><strong>{seatLabel}</strong><small>Joins on first task · {providerLabel(seat.member)}</small></span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The station as a graph: every live session is a node, subagents branch from their parent, teams are framed groups. */
export function StationGraph(props: StationGraphProps) {
  const { clusters, allAgents, selectedId, ready } = props;
  const nameOf = (id?: string) => allAgents.find(agent => agent.id === id)?.name;
  return (
    <div className="graph-lanes">
      {clusters.map(cluster => cluster.kind === 'team'
        ? <TeamGroup key={`team-${cluster.team.id}`} cluster={cluster} props={props} />
        : (
          <div key={cluster.agent.id} className="graph-cluster">
            <AgentNode agent={cluster.agent} parentName={nameOf(cluster.agent.parentId)} helperCount={cluster.helpers.length} selected={cluster.agent.id === selectedId} isReady={!!ready?.has(cluster.agent.id)} context={props} />
            {cluster.helpers.length > 0 && (
              <ul className="graph-children" aria-label={`Subagents of ${cluster.agent.name}`}>
                {cluster.helpers.map(helper => <li key={helper.id}><AgentNode agent={helper} compact parentName={cluster.agent.name} selected={helper.id === selectedId} isReady={!!ready?.has(helper.id)} context={props} /></li>)}
              </ul>
            )}
          </div>
        ))}
    </div>
  );
}
