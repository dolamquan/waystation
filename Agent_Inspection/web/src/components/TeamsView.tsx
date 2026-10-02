import { motion } from 'framer-motion';
import type { Agent, TeamView } from '../api.ts';
import type { TeamLogItem } from '../useTower.ts';
import { timeAgo } from '../format.ts';
import { Icon } from './Icon.tsx';
import { TEAM_STATUS_LABEL, TeamDetail } from './TeamDetail.tsx';

interface TeamsViewProps {
  readonly teams: readonly TeamView[];
  readonly agents: readonly Agent[];
  readonly selectedTeamId?: string;
  readonly teamLogFeed: readonly TeamLogItem[];
  readonly now: number;
  readonly connected: boolean;
  readonly onSelectTeam: (teamId: string) => void;
  readonly onSelectAgent: (agentId: string) => void;
  readonly onNewTeam: () => void;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
}

export function TeamsView({
  teams, agents, selectedTeamId, teamLogFeed, now, connected, onSelectTeam, onSelectAgent, onNewTeam, notify,
}: TeamsViewProps) {
  const selected = teams.find((team) => team.id === selectedTeamId) ?? teams[0];

  if (teams.length === 0) {
    return (
      <motion.div className="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <div className="empty-icon"><Icon name="crew" size={30} /></div>
        <h3>No teams yet</h3>
        <p>A team is a lead plus workers, and each worker can be a different model (Claude or Codex). Every member gets its own git worktree, and they coordinate through a shared channel and task board you can watch here.</p>
        {connected && <button className="btn btn-go" onClick={onNewTeam}><Icon name="plus" size={16} />Create a team</button>}
      </motion.div>
    );
  }

  return (
    <div className="teams-layout">
      <nav className="team-list" aria-label="Teams">
        {teams.map((team) => {
          const done = team.tasks.filter((task) => task.status === 'done').length;
          const vendors = [...new Set(team.members.map((m) => (m.vendor === 'claude' ? 'Claude' : 'Codex')))].join(' + ');
          return (
            <button
              key={team.id}
              className={`team-card ${team.id === selected?.id ? 'team-card-on' : ''}`}
              aria-current={team.id === selected?.id ? 'true' : undefined}
              onClick={() => onSelectTeam(team.id)}
            >
              <div className="team-card-head">
                <strong>{team.name}</strong>
                <span className={`team-status team-${team.status}`}>{TEAM_STATUS_LABEL[team.status]}</span>
              </div>
              <span className="small muted team-card-goal">{team.goal}</span>
              <span className="small muted">{team.members.length} members · {vendors} · {done}/{team.tasks.length} tasks · {timeAgo(team.createdAt, now)}</span>
            </button>
          );
        })}
      </nav>
      {selected && (
        <TeamDetail
          key={selected.id}
          team={selected}
          agents={agents}
          teamLogFeed={teamLogFeed}
          now={now}
          notify={notify}
          onSelectAgent={onSelectAgent}
        />
      )}
    </div>
  );
}
