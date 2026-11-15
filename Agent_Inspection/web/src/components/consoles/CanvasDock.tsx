import { Icon } from '../Icon.tsx';

type Props = {
  /** Every selected tile, of any kind. */
  readonly selectedCount: number;
  /** The selected agent and console tiles: only these can be grouped into a team. */
  readonly sessionCount: number;
  readonly agentCount: number;
  readonly onNewTile: () => void;
  readonly onSpawnTeam: () => void;
  readonly onGroup: () => void;
  readonly onClearSelection: () => void;
  readonly onPauseAll: () => void;
  readonly onResumeAll: () => void;
  readonly onHandoff: () => void;
  readonly onNewOrchestrator: () => void;
};

/** The canvas's bottom bar: make tiles or a whole team, bundle selected tiles, steer every agent at once, open the orchestrator. */
export function CanvasDock({
  selectedCount, sessionCount, agentCount, onNewTile, onSpawnTeam, onGroup, onClearSelection, onPauseAll, onResumeAll, onHandoff, onNewOrchestrator,
}: Props) {
  const noAgents = agentCount === 0;
  return <div className="canvas-dock" role="toolbar" aria-label="Canvas actions">
    <button type="button" onClick={onNewTile} title="A new tile that becomes an agent, a console or a browser (or double-click empty space)">
      <Icon name="plus" size={14} />New tile
    </button>
    <button type="button" onClick={onSpawnTeam} title="Launch several consoles as one team, with presets"><Icon name="crew" size={14} />Spawn team</button>
    <button type="button" onClick={onGroup} disabled={sessionCount < 2}
      title={sessionCount < 2 ? 'Drag a box across empty space (or Shift-click title bars) to select two or more agent tiles' : 'Bundle the selected agents and consoles into a team'}>
      <Icon name="grid" size={14} />Group{sessionCount > 0 ? ` (${sessionCount})` : ''}
    </button>
    {selectedCount > 0 && <span className="canvas-dock-selection" aria-live="polite"
      title="Drag any selected tile to move them all; arrow keys on a selected title bar move them too">{selectedCount} selected</span>}
    {selectedCount > 0 && <button type="button" onClick={onClearSelection} aria-label="Clear selection" title="Clear selection (Esc)"><Icon name="close" size={13} /></button>}
    <span className="canvas-dock-sep" aria-hidden="true" />
    <button type="button" onClick={onNewOrchestrator}
      title="A new orchestrator tile: pick the teams it directs, then give them one goal. Add as many as you like.">
      <Icon name="sparkle" size={14} />Orchestrator</button>
    <button type="button" onClick={onPauseAll} disabled={noAgents} title="Interrupt every agent's current turn (Esc). Shells are left alone.">Pause all</button>
    <button type="button" onClick={onResumeAll} disabled={noAgents} title="Tell every agent to continue">Resume all</button>
    <button type="button" onClick={onHandoff} disabled={noAgents} title="Pass a task from one console to an agent console">Hand off…</button>
  </div>;
}
