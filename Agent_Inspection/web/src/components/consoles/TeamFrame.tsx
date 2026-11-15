import { useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '../Icon.tsx';
import { MAX_GROUP_NAME, type CanvasGroup } from './canvasGroups.ts';

type Props = {
  readonly group: CanvasGroup;
  /** Screen position and size of the frame (already multiplied by the zoom). */
  readonly style: CSSProperties;
  readonly agentCount: number;
  readonly onDragStart: (event: ReactPointerEvent) => void;
  readonly onRename: (name: string) => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onHandoff: () => void;
  readonly onUngroup: () => void;
};

/** The labelled frame around a team on the canvas. Drag its title strip to move every member at once. */
export function TeamFrame({ group, style, agentCount, onDragStart, onRename, onPause, onResume, onHandoff, onUngroup }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);
  const finish = (save: boolean) => {
    if (save) onRename(draft);
    setEditing(false);
  };
  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') { event.stopPropagation(); finish(false); }
  };
  const noAgents = agentCount === 0;
  return <section className="team-frame" style={style} aria-label={`Team ${group.name}`}>
    <header className="team-frame-head" onPointerDown={(event) => { if (!(event.target as Element).closest('button, input')) onDragStart(event); }}
      title="Drag to move the whole team">
      <Icon name="crew" size={14} />
      {editing
        ? <input className="team-frame-name-input" value={draft} maxLength={MAX_GROUP_NAME} autoFocus aria-label="Team name"
          onChange={(event) => setDraft(event.target.value)} onBlur={() => finish(true)} onKeyDown={handleKey} />
        : <button type="button" className="team-frame-name" onClick={() => { setDraft(group.name); setEditing(true); }} title="Rename team">{group.name}</button>}
      <span className="team-frame-count">{group.members.length}</span>
      <span className="team-frame-spacer" />
      <button type="button" className="team-frame-action" onClick={onHandoff} disabled={noAgents} title="Pass a task from one member to another">Hand off…</button>
      <button type="button" className="team-frame-action" onClick={onPause} disabled={noAgents} title="Interrupt every agent's current turn (Esc)">Pause</button>
      <button type="button" className="team-frame-action" onClick={onResume} disabled={noAgents} title="Tell every agent to continue">Resume</button>
      <button type="button" className="icon-btn team-frame-x" onClick={onUngroup} aria-label={`Ungroup ${group.name}`} title="Ungroup (the consoles stay open)">
        <Icon name="close" size={13} />
      </button>
    </header>
  </section>;
}
