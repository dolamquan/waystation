import type { PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '../Icon.tsx';
import { groupFrame, moveGroup, type CanvasGroup } from './canvasGroups.ts';
import type { CanvasState, Rect, Viewport } from './canvasLayout.ts';
import type { ManagedTeamFrame } from './managedTeams.ts';

type Rects = Readonly<Record<string, Rect>>;

type Props = {
  readonly teams: readonly ManagedTeamFrame[];
  readonly rects: Rects;
  readonly viewport: Viewport;
  readonly update: (change: (current: CanvasState) => CanvasState) => void;
  readonly trackPointer: (start: ReactPointerEvent, apply: (dx: number, dy: number) => void) => void;
  readonly onOpenTeam: (teamId: string) => void;
};

const asGroup = (team: ManagedTeamFrame): CanvasGroup => ({ id: team.id, name: team.name, members: team.memberKeys, arranged: true });

/** Frames around the member tiles of each Waystation-run team. Drag the title strip to move the team; Open shows its board. */
export function ManagedTeamLayer({ teams, rects, viewport, update, trackPointer, onOpenTeam }: Props) {
  const startDrag = (event: ReactPointerEvent, team: ManagedTeamFrame) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = rects;
    trackPointer(event, (dx, dy) => {
      const moved = moveGroup(origin, asGroup(team), dx / viewport.zoom, dy / viewport.zoom);
      const members = Object.fromEntries(team.memberKeys.flatMap((key) => (moved[key] ? [[key, moved[key]] as const] : [])));
      update((current) => ({ ...current, rects: { ...current.rects, ...members } }));
    });
  };

  return <>
    {teams.map((team) => {
      const frame = groupFrame(asGroup(team), rects);
      if (!frame) return null;
      const progress = team.taskCount > 0 ? `${team.tasksDone}/${team.taskCount} tasks` : 'Planning';
      return <section key={team.id} className={team.needsYou ? 'managed-team managed-team-alert' : 'managed-team'} aria-label={`Team ${team.name}`}
        style={{
          left: frame.x * viewport.zoom + viewport.panX, top: frame.y * viewport.zoom + viewport.panY,
          width: frame.width * viewport.zoom, height: frame.height * viewport.zoom,
        }}>
        <header className="managed-team-head" onPointerDown={(event) => startDrag(event, team)} title="Drag to move the whole team">
          <Icon name="crew" size={14} />
          <strong>{team.name}</strong>
          <span className={`managed-team-status managed-team-${team.status}`}>{team.statusLabel}</span>
          <span className="managed-team-progress">{progress}</span>
          <span className="managed-team-spacer" />
          <button type="button" className="managed-team-open" onClick={() => onOpenTeam(team.id)} title="Tasks, conversation and outputs">
            {team.needsYou ? 'Review' : 'Open team'}<Icon name="arrow" size={13} />
          </button>
        </header>
      </section>;
    })}
  </>;
}
