import type { TeamView } from '../../api.ts';
import { timeAgo } from '../../format.ts';
import { Icon } from '../Icon.tsx';
import { TEAM_STATUS_LABEL, canPause, canResume, isArchived, resumeGrantText } from './teamUi.ts';

export interface TeamHeaderActions {
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onOperatorCli: () => void;
  readonly onMergeAll: () => void;
  readonly onDisband: () => void;
  readonly onRemove: () => void;
}

interface TeamHeaderProps extends TeamHeaderActions {
  readonly team: TeamView;
  readonly now: number;
  readonly busy?: string;
  readonly unavailable: boolean;
  readonly operatorCliMissing?: string;
}

export function TeamHeader({ team, now, busy, unavailable, operatorCliMissing, ...actions }: TeamHeaderProps) {
  const archived = isArchived(team);
  const unmerged = team.members.some((m) => !m.merged);
  return (
    <header className="team-detail-head">
      <div>
        <h2>{team.name} <span className={`team-status team-${team.status}`}>{TEAM_STATUS_LABEL[team.status]}</span></h2>
        <p className="team-goal">{team.goal}</p>
        <p className="session-started">
          <Icon name="clock" size={14} />Started {timeAgo(team.createdAt, now)}
          {team.archivedAt !== undefined && <> · Archived {timeAgo(team.archivedAt, now)}</>}
        </p>
      </div>
      <div className="team-actions">
        {archived ? (
          <button className="btn btn-small btn-danger" disabled={unavailable} onClick={actions.onRemove}><Icon name="trash" size={14} />Remove from list</button>
        ) : (
          <>
            {unmerged && <button className="btn btn-small btn-ok" disabled={unavailable} onClick={actions.onMergeAll}><Icon name="check" size={14} />{busy === 'Merge all' ? 'Merging…' : 'Merge all'}</button>}
            {canPause(team) && <button className="btn btn-small" disabled={unavailable} onClick={actions.onPause}><Icon name="pause" size={14} />{busy === 'pause' ? 'Pausing…' : 'Pause team'}</button>}
            {canResume(team) && <button className="btn btn-small btn-go" disabled={unavailable} title={`Adds ${resumeGrantText(team)}`} onClick={actions.onResume}><Icon name="play" size={14} />{busy === 'resume' ? 'Resuming…' : 'Resume team'}</button>}
            <details className="session-menu">
              <summary aria-label="More team actions"><Icon name="chevronDown" size={16} />More</summary>
              <div className="session-menu-items">
                <button className="btn btn-small" disabled={unavailable || !!operatorCliMissing} title={operatorCliMissing ?? 'Open a Claude Code session that can read and steer this team'} onClick={actions.onOperatorCli}><Icon name="terminal" size={14} />Open in Claude Code</button>
                <button className="btn btn-small btn-danger" disabled={unavailable} onClick={actions.onDisband}><Icon name="trash" size={14} />Disband team</button>
              </div>
            </details>
          </>
        )}
      </div>
    </header>
  );
}
