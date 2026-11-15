import { useEffect } from 'react';
import type { Agent, TeamView } from '../../api.ts';
import type { TeamLogItem } from '../../useTower.ts';
import { Icon } from '../Icon.tsx';
import { TeamsView } from '../TeamsView.tsx';
import './boardTeams.css';

type Props = {
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
  readonly onClose: () => void;
};

/** Waystation-run teams on the console board: the team list and the open team's tasks, conversation and outputs. */
export function BoardTeamsSheet({ onClose, onNewTeam, connected, ...team }: Props) {
  // Esc closes the sheet, but never while typing (a terminal, a message box or a task editor).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof Element && event.target.closest('.terminal-pane, .modal-backdrop, input, textarea, select');
      if (event.key === 'Escape' && !typing) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return <aside className="board-teams" aria-label="Teams">
    <header className="board-teams-head">
      <Icon name="crew" size={17} />
      <h2>Teams</h2>
      <span className="board-teams-note">A shared goal, a task board, and each member’s work</span>
      <span className="board-teams-spacer" />
      {connected && <button type="button" className="btn btn-go btn-small" onClick={onNewTeam}><Icon name="plus" size={14} />New team</button>}
      <button type="button" className="icon-btn" onClick={onClose} aria-label="Close teams" title="Close (Esc)"><Icon name="close" size={16} /></button>
    </header>
    <div className="board-teams-body">
      <TeamsView {...team} connected={connected} onNewTeam={onNewTeam} />
    </div>
  </aside>;
}
