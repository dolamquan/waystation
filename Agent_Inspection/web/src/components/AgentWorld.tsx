import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Agent, TeamView } from '../api.ts';
import { deckRows, layoutDecks, teamAgentIds, type Placement } from '../stationLayout.ts';
import { useDragPan, useStationScale } from '../useStationViewport.ts';
import { CREW, WORLD_THEMES, characterFor, subagentsByParent, type WorldTheme } from '../crew.ts';
import { stationOffices } from '../stationOffices.ts';
import { STATUS_LABEL, VENDOR_LABEL } from '../format.ts';
import { CrewAvatar } from './CrewAvatar.tsx';
import { StationScene } from './StationScene.tsx';
import { Icon } from './Icon.tsx';

interface AgentWorldProps {
  readonly agents: readonly Agent[];
  readonly selectedId?: string;
  readonly connected: boolean;
  readonly authError: boolean;
  readonly onSelect: (id: string) => void;
  readonly onLaunch: () => void;
  readonly teams?: readonly TeamView[];
  readonly onOpenTeam?: (teamId: string) => void;
}

const TEAM_FILTER = 'team:';

export const PREVIEW_CREW: Agent[] = CREW.map((character, i) => ({
  id: `demo-${character.name}`,
  vendor: i % 2 ? 'codex' : 'claude',
  tier: 'C',
  name: ['Demo reviewer', 'Demo builder', 'Demo planner', 'Demo tester', 'Demo researcher', 'Demo writer'][i],
  project: 'Demo expedition',
  status: (['busy', 'busy', 'waiting', 'idle', 'unknown', 'stopped'] as const)[i],
  currentActivity: character.detail,
  source: 'Illustration',
  hooked: false,
  intercepting: false,
  canInstruct: false,
}));

interface CrewRowProps {
  readonly agent: Agent;
  /** Overrides the session name, e.g. a team member's handle. */
  readonly label?: string;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
  /** A subagent listed under its parent. */
  readonly nested?: boolean;
  readonly parentName?: string;
  readonly helperCount?: number;
}

function CrewRow({ agent, label, selected, onSelect, nested = false, parentName, helperCount = 0 }: CrewRowProps) {
  const name = label ?? agent.name;
  const relationship = agent.parentId ? `Spawned by ${parentName ?? agent.subagent?.parentName ?? 'parent session'}` : undefined;
  return (
    <button className={`crew-row ${selected ? 'crew-row-selected' : ''} ${nested ? 'crew-row-subagent' : ''}`} onClick={() => onSelect(agent.id)} aria-label={nested ? `Open subagent ${name}` : `Open ${name}`} title={relationship}>
      <CrewAvatar id={agent.id} status={agent.status} size={36} animated={false} />
      <span className="crew-row-text"><strong>{label ?? agent.name}</strong><small>{relationship ?? `${VENDOR_LABEL[agent.vendor]} · ${STATUS_LABEL[agent.status]}`}</small>{helperCount > 0 && <small className="crew-row-subcount">{helperCount} {helperCount === 1 ? 'subagent' : 'subagents'}</small>}</span>
      <span className={`crew-status crew-status-${agent.status}`} title={STATUS_LABEL[agent.status]} aria-label={STATUS_LABEL[agent.status]} />
    </button>
  );
}

const demoMember = (name: string, role: 'lead' | 'worker', vendor: 'claude' | 'codex', agentId?: string) =>
  ({ id: name, name, role, vendor, agentId, worktree: '', branch: `team/demo/${name}`, merged: false });

/** A labeled sample team for the demo: three of the demo characters share a table. */
export const PREVIEW_TEAM: TeamView = {
  id: 'demo-team',
  name: 'Launch squad',
  goal: 'A sample team: a lead plans, two workers build and test.',
  repoRoot: '',
  baseBranch: 'main',
  status: 'running',
  createdAt: 0,
  members: [
    // Vendors match the demo characters (PREVIEW_CREW alternates Claude, Codex).
    demoMember('lead', 'lead', 'claude', 'demo-Pip'),
    demoMember('builder', 'worker', 'codex', 'demo-Mica'),
    demoMember('tester', 'worker', 'codex', 'demo-Sprout'),
    demoMember('reviewer', 'worker', 'claude'),
  ],
  tasks: [
    { id: 't1', title: 'Plan', details: '', status: 'done', createdBy: 'lead', updatedAt: 0 },
    { id: 't2', title: 'Build', details: '', status: 'in_progress', createdBy: 'lead', updatedAt: 0 },
    { id: 't3', title: 'Test', details: '', status: 'in_progress', createdBy: 'lead', updatedAt: 0 },
    { id: 't4', title: 'Review', details: '', status: 'open', createdBy: 'lead', updatedAt: 0 },
  ],
  budget: { maxWakes: 40, wakesUsed: 6, deadline: 0 },
};

function savedTheme(): WorldTheme {
  try {
    const value = localStorage.getItem('waystation-theme');
    if (value && Object.hasOwn(WORLD_THEMES, value)) return value as WorldTheme;
  } catch { /* A theme also works without browser storage. */ }
  return 'moonbase';
}

export function AgentWorld({ agents, selectedId, connected, authError, onSelect, onLaunch, teams = [], onOpenTeam }: AgentWorldProps) {
  const [theme, setTheme] = useState<WorldTheme>(savedTheme);
  const [officeKey, setOfficeKey] = useState<string>();
  const officeId = useId();
  const [project, setProject] = useState('all');
  const [page, setPage] = useState(0);
  const [motionPaused, setMotionPaused] = useState(false);
  const [demo, setDemo] = useState(false);
  const [demoId, setDemoId] = useState<string>();
  const [zoomed, setZoomed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const viewport = useDragPan<HTMLDivElement>();
  const scale = useStationScale(viewport, zoomed);
  // Expanded fills the window: lock page scroll, and let Esc return (unless a drawer or dialog has it).
  useEffect(() => {
    if (!expanded) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"], .drawer')) setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [expanded]);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  const paused = motionPaused || !!reducedMotion;
  const offices = useMemo(() => stationOffices(agents, teams), [agents, teams]);
  const office = offices.find(candidate => candidate.key === officeKey) ?? offices[0];
  const activeOfficeKey = office?.key;
  // Keep the current office as sessions arrive, and fall back when its last session leaves.
  useEffect(() => {
    if (activeOfficeKey !== officeKey) setOfficeKey(activeOfficeKey);
  }, [activeOfficeKey, officeKey]);
  const previousSelection = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousSelection.current === selectedId) return;
    previousSelection.current = selectedId;
    const selectedOffice = offices.find(candidate => candidate.agents.some(agent => agent.id === selectedId));
    if (selectedOffice && selectedOffice.key !== activeOfficeKey) { setOfficeKey(selectedOffice.key); setProject('all'); setPage(0); }
  }, [selectedId, offices, activeOfficeKey]);
  useEffect(() => {
    setProject('all');
    setPage(0);
    viewport.current?.scrollTo(0, 0);
  }, [activeOfficeKey, demo, viewport]);
  // Team members sit at their team's table; everyone else keeps a desk of their own.
  const floorTeams = useMemo(() => (demo ? [PREVIEW_TEAM] : office?.teams ?? []), [office, demo]);
  const crewAgents = demo ? PREVIEW_CREW : office?.agents ?? [];
  // Subagents stand beside their parent's desk instead of taking one of their own (unless the parent sits at a team table).
  const { solos, helpers } = useMemo(() => {
    const seated = teamAgentIds(floorTeams);
    const deskIds = new Set(crewAgents.filter(a => !seated.has(a.id) && !a.parentId).map(a => a.id));
    const hosted = (a: Agent) => !!a.parentId && deskIds.has(a.parentId);
    return {
      solos: crewAgents.filter(a => !seated.has(a.id) && !hosted(a)),
      helpers: subagentsByParent(crewAgents.filter(hosted)),
    };
  }, [crewAgents, floorTeams]);
  const activeProject = floorTeams.some(t => `${TEAM_FILTER}${t.id}` === project) ? project : 'all';
  const visibleTeams = useMemo(() => {
    if (demo) return floorTeams;
    if (activeProject.startsWith(TEAM_FILTER)) return floorTeams.filter(t => `${TEAM_FILTER}${t.id}` === activeProject);
    return activeProject === 'all' ? [...floorTeams].sort((a, b) => a.createdAt - b.createdAt) : [];
  }, [floorTeams, activeProject, demo]);
  const visible = useMemo(() => {
    const list = demo || activeProject === 'all' ? solos : [];
    return [...list].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id));
  }, [solos, activeProject, demo]);
  const decks = useMemo(() => layoutDecks(visibleTeams, visible, crewAgents), [visibleTeams, visible, crewAgents]);
  const pages = decks.length;
  const currentPage = Math.min(page, pages - 1);
  const deck: readonly Placement[] = decks[currentPage];
  const rows = deckRows(deck);
  const visibleHelpers = visible.flatMap(a => helpers.get(a.id) ?? []);
  const crewCount = visible.length + visibleHelpers.length + visibleTeams.reduce((n, t) => n + t.members.length, 0);
  const workingCount = [...visible, ...visibleHelpers, ...visibleTeams.flatMap(t => t.members.flatMap(m => crewAgents.filter(a => a.id === m.agentId)))].filter(a => a.status === 'busy').length;
  const preview = PREVIEW_CREW.find(a => a.id === demoId);
  const parentName = (agent: Agent) => agents.find(parent => parent.id === agent.parentId)?.name;

  const changeTheme = (next: WorldTheme) => {
    setTheme(next);
    try { localStorage.setItem('waystation-theme', next); } catch { /* optional preference */ }
  };
  const toggleDemo = () => { setDemo(!demo); setDemoId(undefined); setPage(0); };

  return (
    <section className={`agent-world world-${theme} ${paused ? 'motion-paused' : ''} ${expanded ? 'world-expanded' : ''}`} aria-label="Waystation agent world">
      <header className="world-toolbar">
        <div className="world-title"><span className="world-title-icon"><Icon name="planet" size={19} /></span><div><h2>The station</h2><span>{demo ? 'Sample workspace' : WORLD_THEMES[theme].location}</span></div></div>
        <div className="world-controls">
          <div className="theme-picker" aria-label="Station theme">
            {(Object.keys(WORLD_THEMES) as WorldTheme[]).map(t => <button key={t} className={theme === t ? 'theme-active' : ''} onClick={() => changeTheme(t)} aria-pressed={theme === t}><span className={`theme-swatch swatch-${t}`} />{WORLD_THEMES[t].label}</button>)}
          </div>
          <button className="world-motion" onClick={() => setExpanded(!expanded)} aria-pressed={expanded} aria-label={expanded ? 'Exit full screen station' : 'Expand station to full screen'} title={expanded ? 'Exit full screen (Esc)' : 'Expand station to full screen'}><Icon name={expanded ? 'collapse' : 'expand'} size={16} /></button>
          <button className="world-motion" onClick={() => setMotionPaused(!motionPaused)} disabled={!!reducedMotion} aria-label={paused ? 'Resume animations' : 'Pause animations'} aria-pressed={paused} title={reducedMotion ? 'Animations are off because of your system motion preference' : paused ? 'Resume animations' : 'Pause animations'}><Icon name={paused ? 'play' : 'pause'} size={16} /></button>
        </div>
      </header>

      {!demo && offices.length > 0 && <div className="office-switcher">
        <div className="office-tabs" role="tablist" aria-label="Folder offices">
          {offices.map((candidate, index) => <button
            key={candidate.key}
            id={`${officeId}-tab-${index}`}
            className={`office-tab ${candidate.key === activeOfficeKey ? 'office-tab-active' : ''}`}
            role="tab"
            aria-selected={candidate.key === activeOfficeKey}
            aria-controls={`${officeId}-panel`}
            tabIndex={candidate.key === activeOfficeKey ? 0 : -1}
            title={candidate.path ?? 'Sessions with no known working folder'}
            onClick={() => setOfficeKey(candidate.key)}
            onKeyDown={event => {
              let next = index;
              if (event.key === 'ArrowRight') next = (index + 1) % offices.length;
              else if (event.key === 'ArrowLeft') next = (index - 1 + offices.length) % offices.length;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = offices.length - 1;
              else return;
              event.preventDefault();
              setOfficeKey(offices[next].key);
              document.getElementById(`${officeId}-tab-${next}`)?.focus();
            }}
          ><Icon name="folder" size={14} /><span className="office-tab-name">{candidate.name}</span><span className="office-tab-count" aria-label={`${candidate.agents.length} agents`}>{candidate.agents.length}</span></button>)}
        </div>
        <div className="office-location"><span title={office?.path}>{office?.path ?? 'Working folder unknown'}</span><small>{offices.length} {offices.length === 1 ? 'office' : 'offices'}</small></div>
      </div>}

      <div className="world-body" id={`${officeId}-panel`} role={!demo && office ? 'tabpanel' : undefined} aria-labelledby={!demo && office ? `${officeId}-tab-${offices.indexOf(office)}` : undefined}>
        <div className="world-scene-wrap">
          <div className="world-scene-topline"><span className={`world-live ${demo ? 'world-demo' : ''}`}><span className={`connection-dot ${connected && !demo ? 'live' : ''}`} />{demo ? 'DEMO CREW' : connected ? 'LIVE WORKSPACE' : authError ? 'ACCESS TOKEN REQUIRED' : 'CONNECTING'}</span><div className="scene-camera"><span className="world-coordinate">{theme === 'moonbase' ? '25.8° N / 02.6° E' : theme === 'greenhouse' ? '21°C / A LITTLE SUNSHINE' : 'DEPTH 2,400 M / ALL IS QUIET'}</span><button onClick={() => setZoomed(!zoomed)} aria-label={zoomed ? 'Fit station to view' : 'Zoom in on station'} aria-pressed={zoomed} title={zoomed ? 'Fit station to view' : 'Zoom in on station'}><Icon name={zoomed ? 'fit' : 'zoom'} size={14} /></button></div></div>
          <div ref={viewport} className={`scene-viewport ${zoomed ? 'scene-zoomed' : ''}`}><StationScene deck={deck} allAgents={demo ? PREVIEW_CREW : agents} rows={rows} scale={scale} onOpenTeam={demo ? undefined : onOpenTeam} theme={theme} paused={paused} selectedId={demo ? demoId : selectedId} onSelect={demo ? setDemoId : onSelect} subagents={helpers} /></div>
          {!deck.length && <div className="world-empty"><Icon name="planet" size={24} /><h3>{authError ? 'Your station is waiting' : connected ? 'Room for your first explorer' : 'Finding your crew…'}</h3><p>{authError ? 'Open the daemon’s access link to connect your agents.' : connected ? 'Launch an agent and watch it settle into the station.' : 'The crew will arrive when the daemon connects.'}</p>{connected && <button className="btn btn-go" onClick={onLaunch}><Icon name="plus" size={15} />Launch an agent</button>}</div>}
          {preview && demo && <div className="demo-inspector" role="status"><CrewAvatar id={preview.id} status={preview.status} size={38} /><div><strong>{preview.name} · {STATUS_LABEL[preview.status]}</strong><span>A sample session avatar. No agent is running in this demo.</span></div><button className="icon-btn" aria-label="Close demo details" onClick={() => setDemoId(undefined)}><Icon name="close" size={14} /></button></div>}
          <div className="world-scene-footer"><span><Icon name="cursor" size={13} />Click a crewmate to check in · drag to look around · {rows} rows of desks</span><div className="deck-controls"><button aria-label="Previous deck" onClick={() => setPage(currentPage - 1)} disabled={currentPage === 0}><Icon name="chevronLeft" size={14} /></button><span>DECK {String(currentPage + 1).padStart(2, '0')}{pages > 1 ? ` / ${String(pages).padStart(2, '0')}` : ''}</span><button aria-label="Next deck" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pages - 1}><Icon name="chevronRight" size={14} /></button></div></div>
        </div>

        <aside className="crew-panel" aria-label="Station crew">
          <div className="crew-panel-heading"><div><span className="eyebrow">{demo ? 'Sample sessions' : 'Your sessions'}</span><h3>Agent sessions<span>{crewCount}</span></h3></div><span className="crew-panel-badge"><Icon name="crew" size={18} /></span></div>
          <label className="crew-project-label" htmlFor="crew-project">Office crew</label>
          <select id="crew-project" className="crew-project-select" aria-label="Office crew" value={activeProject} disabled={demo || !floorTeams.length} onChange={e => { setProject(e.target.value); setPage(0); }}><option value="all">All in this office</option>{floorTeams.map(t => <option key={t.id} value={`${TEAM_FILTER}${t.id}`}>Team · {t.name} ({t.members.length})</option>)}</select>
          <div className="crew-panel-list">
            {deck.map(placement => placement.kind === 'agent' ? (
              <div key={placement.agent.id} className={`crew-family ${(helpers.get(placement.agent.id)?.length ?? 0) > 0 ? 'crew-family-linked' : ''}`} style={{ '--family-color': characterFor(placement.agent.id).color } as CSSProperties}>
                <CrewRow agent={placement.agent} parentName={parentName(placement.agent)} helperCount={helpers.get(placement.agent.id)?.length} selected={placement.agent.id === (demo ? demoId : selectedId)} onSelect={demo ? setDemoId : onSelect} />
                {(helpers.get(placement.agent.id) ?? []).map(helper => <CrewRow key={helper.id} agent={helper} parentName={placement.agent.name} nested selected={helper.id === selectedId} onSelect={onSelect} />)}
              </div>
            ) : (
              <div key={placement.team.id} className="crew-team">
                <button className="crew-team-head" disabled={demo} onClick={() => onOpenTeam?.(placement.team.id)} aria-label={`Open team ${placement.team.name}`} style={{ '--team-accent': characterFor(placement.team.id).color } as CSSProperties}>
                  <span className="crew-team-mark" aria-hidden="true" /><span className="crew-row-text"><strong>{placement.team.name}</strong><small>Team · {placement.team.tasks.filter(t => t.status === 'done').length}/{placement.team.tasks.length} tasks</small></span><Icon name="arrow" size={13} />
                </button>
                {placement.seats.map(seat => seat.agent
                  ? <CrewRow key={seat.member.id} agent={seat.agent} parentName={parentName(seat.agent)} label={`${seat.member.name}${seat.member.role === 'lead' ? ' · lead' : ''}`} selected={seat.agent.id === (demo ? demoId : selectedId)} onSelect={demo ? setDemoId : onSelect} />
                  : <div key={seat.member.id} className="crew-row crew-row-waiting"><CrewAvatar id={`${placement.team.id}:${seat.member.name}`} status="stopped" size={36} animated={false} /><span className="crew-row-text"><strong>{seat.member.name}{seat.member.role === 'lead' ? ' · lead' : ''}</strong><small>Joins on first task <span>· {seat.member.vendor === 'claude' ? 'Claude' : 'Codex'}</span></small></span></div>)}
              </div>
            ))}
            {!deck.length && <p className="crew-panel-empty">A good team starts with one little explorer.</p>}
          </div>
          <div className="world-legend" aria-label="Character states"><span><i className="legend-working" />Working</span><span><i className="legend-waiting" />Needs you</span><span><i className="legend-idle" />Idle</span><span><i className="legend-family" />Spawned subagent</span></div>
          <div className="world-demo-card"><span className="demo-mini-crew">{CREW.slice(0, 3).map(c => <CrewAvatar key={c.name} character={c} size={25} animated={false} />)}</span><strong>{demo ? 'Ready for the real crew?' : 'Meet the little explorers'}</strong><p>{demo ? 'Return to your live sessions whenever you’re ready.' : 'Take a look around with a sample crew. No agents are launched.'}</p><button onClick={toggleDemo}>{demo ? 'Back to live workspace' : 'Explore the demo'}<Icon name="arrow" size={14} /></button></div>
        </aside>
      </div>
      <footer className="world-bottomline"><span><Icon name="cursor" size={13} />Avatars show these same sessions. Select one to open its controls.</span><span>{demo ? 'Sample data · No live actions' : `${crewCount} ${crewCount === 1 ? 'agent' : 'agents'}${visibleTeams.length ? ` · ${visibleTeams.length} ${visibleTeams.length === 1 ? 'team' : 'teams'}` : ''} · ${workingCount} working`}</span></footer>
    </section>
  );
}
