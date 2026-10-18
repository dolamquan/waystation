import type { Agent, TeamMember, TeamView } from '../../api.ts';
import { formatUsd } from '../../format.ts';
import { Icon } from '../Icon.tsx';
import { TEAM_STATUS_LABEL, agentFor, findMember, isArchived, leadOf } from './teamUi.ts';

interface TeamOverviewProps {
  readonly team: TeamView;
  readonly agents: readonly Agent[];
  readonly now: number;
  readonly connected: boolean;
  readonly onSelectAgent: (agentId: string) => void;
  readonly onMessage: (member: TeamMember) => void;
}

const LIVE = new Set<TeamView['status']>(['running', 'planning']);

/** Status notices, progress, what needs the operator, and the run limits with spend. */
export function TeamOverview({ team, agents, now, connected, onSelectAgent, onMessage }: TeamOverviewProps) {
  const archived = isArchived(team);
  const doneTasks = team.tasks.filter((task) => task.status === 'done').length;
  const blockedTasks = team.tasks.filter((task) => task.status === 'blocked');
  const waitingMembers = team.members.filter((member) => agentFor(member, agents)?.status === 'waiting');
  const workingMembers = team.members.filter((member) => !member.terminal && agentFor(member, agents)?.status === 'busy').length;
  const helpUnblock = (assignee?: string) => {
    const member = findMember(team, assignee) ?? leadOf(team);
    if (member) onMessage(member);
  };

  return (
    <>
      {!connected && <div className="session-notice" role="status"><Icon name="link" size={16} />Reconnecting. Team controls will be available when the connection returns.</div>}
      {archived && <div className="session-notice" role="status"><Icon name="info" size={16} /><span>This team was disbanded. Its board, conversation and branches are kept here for reference; nothing can be changed.</span></div>}
      {team.statusReason && !archived && <div className="session-notice"><Icon name="info" size={16} /><span>{team.statusReason}</span></div>}
      {team.summary && <div className="session-summary"><Icon name="check" size={18} /><div><strong>Lead’s summary</strong><p>{team.summary}</p></div></div>}

      <div className="session-progress" aria-label="Team progress">
        <div><strong>{doneTasks} of {team.tasks.length} tasks complete</strong><span>{workingMembers} of {team.members.length} members working</span></div>
        <progress max={Math.max(1, team.tasks.length)} value={doneTasks} aria-label="Tasks completed" />
      </div>
      {!archived && (blockedTasks.length > 0 || waitingMembers.length > 0) && (
        <section className="session-attention" aria-label="Team needs attention">
          <h3><Icon name="alert" size={17} />Needs your attention</h3>
          {waitingMembers.map((member) => (
            <div key={member.id}><span><strong>{member.name}</strong> is waiting for your input or approval.</span><button className="btn btn-small" onClick={() => onSelectAgent(member.agentId!)}>Review session<Icon name="expand" size={13} /></button></div>
          ))}
          {blockedTasks.map((task) => (
            <div key={task.id}><span><strong>{task.title}</strong><small>{task.note || 'This task is blocked. Ask the assignee what they need.'}</small></span><button className="btn btn-small" onClick={() => helpUnblock(task.assignee)}>Help unblock<Icon name="message" size={13} /></button></div>
          ))}
        </section>
      )}
      <TeamLimits team={team} now={now} workingMembers={workingMembers} />
    </>
  );
}

function TeamLimits({ team, now, workingMembers }: { team: TeamView; now: number; workingMembers: number }) {
  const { wakesUsed, maxWakes, deadline } = team.budget;
  const live = LIVE.has(team.status);
  const minutesLeft = Math.max(0, Math.round((deadline - now) / 60_000));
  const wakePercent = maxWakes > 0 ? Math.max(0, Math.min(100, Math.round((wakesUsed / maxWakes) * 100))) : 0;
  const spend = team.spend?.costUsd ?? 0;
  return (
    <details className="session-limits">
      <summary>Run limits · {wakesUsed} / {maxWakes} agent turns used{live ? ` · ${minutesLeft} min left` : ''} · {formatUsd(spend)} spent</summary>
      <p>Each automatic agent turn uses one wake-up. The team pauses when either limit is reached. Resuming adds {team.resumeGrant.wakes} turns and {team.resumeGrant.minutes} minutes. Spend is estimated from each member’s usage.</p>
      <div className="session-stats" aria-label="Run limits">
        <div className="session-stat"><span><Icon name="crew" size={15} />Team members</span><strong>{team.members.length}<small>{workingMembers ? `${workingMembers} working now` : 'None working now'}</small></strong></div>
        <div className="session-stat"><span><Icon name="sparkle" size={15} />Team spend</span><strong>{formatUsd(spend)}<small>{team.spend?.turns ?? 0} turns</small></strong></div>
        <div className="session-stat">
          <span title="Each automatic agent turn uses one wake-up"><Icon name="activity" size={15} />Wake-ups used</span>
          <strong>{wakesUsed}<small>of {maxWakes}</small></strong>
          <div className="meter" role="meter" aria-label="Wake-ups used" aria-valuemin={0} aria-valuemax={Math.max(1, maxWakes)} aria-valuenow={Math.max(0, Math.min(wakesUsed, Math.max(1, maxWakes)))}><span style={{ transform: `scaleX(${wakePercent / 100})` }} /></div>
        </div>
        <div className="session-stat"><span><Icon name="clock" size={15} />Time remaining</span><strong>{live ? minutesLeft : '—'}<small>{live ? 'minutes' : TEAM_STATUS_LABEL[team.status]}</small></strong></div>
      </div>
    </details>
  );
}
