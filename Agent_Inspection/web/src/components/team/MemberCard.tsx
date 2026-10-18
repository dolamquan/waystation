import type { Agent, TeamMember, TeamView } from '../../api.ts';
import { formatUsd } from '../../format.ts';
import { Icon } from '../Icon.tsx';
import { agentFor, findMember, memberStatus, plural } from './teamUi.ts';

export interface MemberActions {
  readonly onSelectAgent: (agentId: string) => void;
  readonly onMessage: (member: TeamMember) => void;
  readonly onDiff: (member: TeamMember) => void;
  readonly onMerge: (member: TeamMember) => void;
  readonly onOpenCli: (member: TeamMember) => void;
  readonly onTakeBack: (member: TeamMember) => void;
}

interface MemberCardProps extends MemberActions {
  readonly team: TeamView;
  readonly member: TeamMember;
  readonly agents: readonly Agent[];
  readonly readOnly: boolean;
  readonly unavailable: boolean;
  readonly busy?: string;
  /** Why this member's CLI can't open, if it can't. */
  readonly cliMissing?: string;
}

/** One member: what it is doing now, its current task, waiting mail, spend, and its review actions. */
export function MemberCard(props: MemberCardProps) {
  const { team, member, agents, readOnly, unavailable, busy, cliMissing } = props;
  const status = memberStatus(member, agents);
  const agent = agentFor(member, agents);
  const working = agent?.status === 'busy' || agent?.status === 'waiting' || !!member.terminal;
  const task = team.tasks.find((t) => t.status === 'in_progress' && findMember(team, t.assignee)?.id === member.id);
  const waiting = team.pending?.[member.id] ?? 0;
  const activity = agent?.status === 'busy' ? agent.currentActivity : undefined;

  return (
    <li className="team-member">
      <div className="session-member-heading">
        <span className={`session-member-avatar avatar-${member.vendor}`} aria-hidden="true">{member.name.slice(0, 1).toUpperCase()}</span>
        <div className="team-member-main">
          <strong>{member.name}{member.role === 'lead' && <span className="session-lead-badge">Lead</span>}</strong>
          <span>{member.vendor === 'claude' ? 'Claude' : 'Codex'}{member.model ? ` · ${member.model}` : ''}</span>
        </div>
        <span className={`status-pill ${status.pill}`}>{member.merged ? 'Merged' : status.label}</span>
      </div>
      {member.focus && <p className="team-member-focus" title="Focus">{member.focus}</p>}
      <dl className="team-member-facts">
        {activity && <div><dt>Now</dt><dd className="team-member-activity">{activity}</dd></div>}
        <div><dt>Task</dt><dd>{task ? task.title : 'No task in progress'}</dd></div>
        {waiting > 0 && <div><dt>Waiting</dt><dd>{plural(waiting, 'message')} queued for {member.name}</dd></div>}
        <div><dt>Spend</dt><dd>{formatUsd(member.spend?.costUsd ?? 0)}{member.spend?.turns ? ` · ${plural(member.spend.turns, 'turn')}` : ''}</dd></div>
      </dl>
      {!readOnly && (
        <div className="team-member-actions">
          {agent && <button className="btn btn-small" onClick={() => props.onSelectAgent(agent.id)}><Icon name="expand" size={13} />View session</button>}
          <button className="btn btn-small btn-ghost" onClick={() => props.onMessage(member)}><Icon name="message" size={14} />Message</button>
        </div>
      )}
      <div className="session-review-actions">
        <button className="btn btn-small" disabled={unavailable} onClick={() => props.onDiff(member)}>{busy === `diff:${member.id}` ? 'Loading…' : 'View changes'}</button>
        {!readOnly && (
          <button className="btn btn-small btn-ok" disabled={unavailable || member.merged || working} title={working ? 'Wait for this member to finish before merging' : undefined} onClick={() => props.onMerge(member)}>
            {member.merged ? 'Merged' : 'Merge work'}
          </button>
        )}
      </div>
      <details className="session-member-workspace">
        <summary>Workspace &amp; CLI<Icon name="chevronDown" size={13} /></summary>
        <code className="team-branch" title={member.worktree}>{member.branch}</code>
        {!readOnly && (
          <div className="session-workspace-actions">
            {member.terminal
              ? <button className="btn btn-small" disabled={unavailable} title="Bring this member back to the team now" onClick={() => props.onTakeBack(member)}>Take back</button>
              : agent?.sessionId && <button className="btn btn-small" disabled={unavailable || !!cliMissing} title={cliMissing ?? `Continue in ${member.vendor === 'codex' ? 'Codex' : 'Claude Code'}`} onClick={() => props.onOpenCli(member)}><Icon name="terminal" size={13} />Open CLI</button>}
          </div>
        )}
      </details>
    </li>
  );
}
