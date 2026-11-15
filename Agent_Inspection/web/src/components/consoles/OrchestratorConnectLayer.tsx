import { useEffect, type CSSProperties } from 'react';
import { Icon } from '../Icon.tsx';
import type { Rect, Viewport } from './canvasLayout.ts';
import type { Wired } from './orchestration.ts';

export interface ConnectTarget {
  readonly id: string;
  readonly name: string;
  readonly rect: Rect;
}

/** Wired ids with one toggled: added when absent, removed when present. Never mutates the input. */
export const toggleId = (ids: readonly string[], id: string): readonly string[] =>
  (ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]);

/**
 * Connect mode for one orchestrator: every agent tile and team frame on the stage becomes clickable, and a click wires
 * it to (or unwires it from) that orchestrator. Empty space still pans and selects; Escape or Done leaves the mode.
 */
export function OrchestratorConnectLayer({ name, tone, wired, agents, teams, viewport, onChange, onDone }: {
  readonly name: string;
  readonly tone: string;
  readonly wired: Wired;
  readonly agents: readonly ConnectTarget[];
  readonly teams: readonly ConnectTarget[];
  readonly viewport: Viewport;
  readonly onChange: (wired: Wired) => void;
  readonly onDone: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onDone(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);

  const screen = (rect: Rect): CSSProperties => ({
    left: rect.x * viewport.zoom + viewport.panX, top: rect.y * viewport.zoom + viewport.panY,
    width: rect.width * viewport.zoom, height: rect.height * viewport.zoom,
  });
  const count = wired.teams.length + wired.agents.length;
  const nothing = agents.length === 0 && teams.length === 0;

  return <div className="orch-connect" style={{ '--orch-tone': tone } as CSSProperties}>
    {agents.map((agent) => {
      const on = wired.agents.includes(agent.id);
      return <button key={agent.id} type="button" className={on ? 'orch-pick orch-pick-on' : 'orch-pick'} style={screen(agent.rect)}
        aria-pressed={on} onClick={() => onChange({ ...wired, agents: toggleId(wired.agents, agent.id) })}
        title={on ? `Disconnect ${agent.name} from ${name}` : `Connect ${agent.name} to ${name}`}>
        <span className="orch-pick-badge">{on ? <><Icon name="check" size={12} />Connected</> : <><Icon name="plus" size={12} />Connect</>}</span>
      </button>;
    })}
    {teams.map((team) => {
      const on = wired.teams.includes(team.id);
      const box = screen(team.rect);
      return <button key={team.id} type="button" className={on ? 'orch-pick-team orch-pick-on' : 'orch-pick-team'}
        style={{ left: box.left, top: box.top }} aria-pressed={on}
        onClick={() => onChange({ ...wired, teams: toggleId(wired.teams, team.id) })}
        title={on ? `Disconnect team ${team.name} from ${name}` : `Connect the whole team ${team.name} to ${name}`}>
        <Icon name={on ? 'check' : 'crew'} size={12} />{team.name}
      </button>;
    })}
    <div className="orch-connect-bar" role="status">
      <span className="orch-connect-mark" aria-hidden="true"><Icon name="link" size={14} /></span>
      <span className="orch-connect-text">
        <span className="orch-eyebrow">Connecting · {name}</span>
        <span>{nothing ? 'No agents or teams on this canvas yet.' : 'Click agents or team labels to bring them aboard.'}</span>
      </span>
      <span className="orch-connect-count">{count} connected</span>
      <button type="button" className="orch-connect-done" onClick={onDone}>Done</button>
    </div>
  </div>;
}
