import { motion } from 'framer-motion';
import type { Agent, TeamView } from '../api.ts';
import type { TeamLogItem } from '../useTower.ts';
import { timeAgo } from '../format.ts';
import { Icon } from './Icon.tsx';
import { WorkspaceDoodle } from './WorkspaceDoodle.tsx';
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
        <WorkspaceDoodle kind="team" />
        <h3>No teams yet</h3>
        <p>Bring a lead and a few workers together on one goal. Each gets a separate workspace, with a shared task board and conversation here.</p>
        {connected && <button className="btn btn-go" onClick={onNewTeam}><Icon name="plus" size={16} />Create a team</button>}
      </motion.div>
    );
  }

  return (
    <div className="teams-layout">
      <nav className="team-list" aria-label="Teams">
        <div className="team-list-heading"><Icon name="crew" size={16} /><strong>Your teams</strong><span className="section-count">{teams.length}</span></div>
        <div className="team-list-cards">
          {teams.map((team) => {
            const done = team.tasks.filter((task) => task.status === 'done').length;
            const blocked = team.tasks.filter((task) => task.status === 'blocked').length;
            const vendors = [...new Set(team.members.map((m) => (m.vendor === 'claude' ? 'Claude' : 'Codex')))].join(' + ');
            const memberCount = `${team.members.length} ${team.members.length === 1 ? 'member' : 'members'}`;
            return (
              <button
                key={team.id}
                className={`team-card ${team.id === selected?.id ? 'team-card-on' : ''}`}
                aria-current={team.id === selected?.id ? 'true' : undefined}
                title={`${team.goal}\nCreated ${timeAgo(team.createdAt, now)}`}
                onClick={() => onSelectTeam(team.id)}
              >
                <div className="team-card-head">
                  <strong>{team.name}</strong>
                  <span className={`team-status team-${team.status}`}>{TEAM_STATUS_LABEL[team.status]}</span>
                </div>
                <span className="team-card-meta"><span>{memberCount} · {vendors}</span><span>{team.tasks.length ? `${done}/${team.tasks.length} done` : 'Planning'}</span></span>
                {blocked > 0 && <span className="team-card-blocked"><Icon name="alert" size={13} />{blocked} blocked</span>}
              </button>
            );
          })}
        </div>
      </nav>
      {selected && (
        <TeamDetail
          key={selected.id}
          team={selected}
          agents={agents}
          teamLogFeed={teamLogFeed}
          now={now}
          connected={connected}
          notify={notify}
          onSelectAgent={onSelectAgent}
        />
      )}
    </div>
  );
}
