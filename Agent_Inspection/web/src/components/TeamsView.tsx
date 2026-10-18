import { motion } from 'framer-motion';
import type { Agent, TeamView } from '../api.ts';
import type { TeamLogItem } from '../useTower.ts';
import { timeAgo } from '../format.ts';
import { Icon } from './Icon.tsx';
import { WorkspaceDoodle } from './WorkspaceDoodle.tsx';
import { TeamDetail } from './TeamDetail.tsx';
import { TEAM_STATUS_LABEL, isArchived } from './team/teamUi.ts';

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
  const active = teams.filter((team) => !isArchived(team));
  const archived = teams.filter(isArchived);
  const selected = teams.find((team) => team.id === selectedTeamId) ?? active[0] ?? archived[0];

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
        <div className="team-list-heading"><Icon name="crew" size={16} /><strong>Your teams</strong><span className="section-count">{active.length}</span></div>
        <div className="team-list-cards">
          {active.map((team) => <TeamCard key={team.id} team={team} agents={agents} now={now} selected={team.id === selected?.id} onSelect={onSelectTeam} />)}
          {active.length === 0 && <p className="team-list-empty">No active teams. {connected && <button className="btn btn-small btn-ghost" onClick={onNewTeam}><Icon name="plus" size={14} />Create a team</button>}</p>}
        </div>
        {archived.length > 0 && (
          <details className="team-archive" open={!!selected && isArchived(selected)}>
            <summary className="team-list-heading"><Icon name="book" size={16} /><strong>Archived</strong><span className="section-count">{archived.length}</span><Icon name="chevronDown" size={13} /></summary>
            <div className="team-list-cards">
              {archived.map((team) => <TeamCard key={team.id} team={team} agents={agents} now={now} selected={team.id === selected?.id} onSelect={onSelectTeam} />)}
            </div>
          </details>
        )}
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

interface TeamCardProps {
  readonly team: TeamView;
  readonly agents: readonly Agent[];
  readonly now: number;
  readonly selected: boolean;
  readonly onSelect: (teamId: string) => void;
}

function TeamCard({ team, agents, now, selected, onSelect }: TeamCardProps) {
  const done = team.tasks.filter((task) => task.status === 'done').length;
  const blocked = team.tasks.filter((task) => task.status === 'blocked').length;
  const waiting = team.members.filter((member) => agents.some((agent) => agent.id === member.agentId && agent.status === 'waiting')).length;
  const vendors = [...new Set(team.members.map((m) => (m.vendor === 'claude' ? 'Claude' : 'Codex')))].join(' + ');
  const memberCount = `${team.members.length} ${team.members.length === 1 ? 'member' : 'members'}`;
  const needs = [blocked > 0 && `${blocked} blocked`, waiting > 0 && `${waiting} needs you`, team.status === 'plan_review' && 'plan to review'].filter(Boolean);
  return (
    <button
      className={`team-card ${selected ? 'team-card-on' : ''} ${isArchived(team) ? 'team-card-archived' : ''}`}
      aria-current={selected ? 'true' : undefined}
      title={`${team.goal}
Created ${timeAgo(team.createdAt, now)}`}
      onClick={() => onSelect(team.id)}
    >
      <div className="team-card-head">
        <strong>{team.name}</strong>
        <span className={`team-status team-${team.status}`}>{TEAM_STATUS_LABEL[team.status]}</span>
      </div>
      <span className="team-card-meta"><span>{memberCount} · {vendors}</span><span>{team.tasks.length ? `${done}/${team.tasks.length} done` : 'Planning'}</span></span>
      <span className="team-card-goal">{team.goal}</span>
      {!isArchived(team) && needs.length > 0 && <span className="team-card-blocked"><Icon name="alert" size={13} />{needs.join(' · ')}</span>}
    </button>
  );
}
