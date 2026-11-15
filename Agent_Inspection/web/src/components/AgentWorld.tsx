import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { providerLabel } from '../../../shared/agentProviders.ts';
import type { Agent, PendingInterception, TeamView } from '../api.ts';
import { CREW, subagentsByParent } from '../crew.ts';
import { STATUS_LABEL } from '../format.ts';
import { stationOffices } from '../stationOffices.ts';
import { teamAgentIds, teamSeats } from '../stationLayout.ts';
import { useDragPan } from '../useStationViewport.ts';
import { CrewAvatar } from './CrewAvatar.tsx';
import { Icon } from './Icon.tsx';
import type { Notify } from './StationApproval.tsx';
import { StationGraph, type GraphCluster } from './StationGraph.tsx';

interface AgentWorldProps {
  readonly agents: readonly Agent[];
  readonly selectedId?: string;
  readonly connected: boolean;
  readonly authError: boolean;
  readonly onSelect: (id: string) => void;
  readonly onLaunch: () => void;
  readonly teams?: readonly TeamView[];
  readonly onOpenTeam?: (teamId: string) => void;
  /** Held tool calls, shown as Approve / Deny panels on their agents' nodes. */
  readonly pending?: readonly PendingInterception[];
  readonly notify?: Notify;
  /** Agents with a fresh result to see, and how to open it. */
  readonly ready?: ReadonlySet<string>;
  readonly onLook?: (id: string) => void;
}

const ZOOM_IN = 1.25;

export const PREVIEW_CREW: Agent[] = CREW.map((character, i) => ({
  id: `demo-${character.name}`,
  vendor: i % 2 ? 'codex' : 'claude',
  tier: 'C',
  name: ['Demo reviewer', 'Demo builder', 'Demo planner', 'Demo tester', 'Demo researcher', 'Demo writer'][i],
  project: 'Demo workspace',
  status: (['busy', 'busy', 'waiting', 'idle', 'unknown', 'stopped'] as const)[i],
  currentActivity: character.detail,
  source: 'Sample',
  hooked: false,
  intercepting: false,
  canInstruct: false,
}));

/** One sample held call, so the demo shows an approval panel (its buttons only explain themselves). */
const DEMO_PENDING: readonly PendingInterception[] = [{ id: 'demo-pending', agentId: PREVIEW_CREW[2].id, sessionId: 'demo', toolName: 'Bash', input: { command: 'npm test' }, createdAt: 0, origin: 'hook' }];

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
  const helpers = helperCount > 0 ? ` · ${helperCount} ${helperCount === 1 ? 'subagent' : 'subagents'}` : '';
  const detail = `${relationship ?? `${providerLabel(agent)} · ${STATUS_LABEL[agent.status]}`}${helpers}`;
  return (
    <button className={`crew-row ${selected ? 'crew-row-selected' : ''} ${nested ? 'crew-row-subagent' : ''}`} onClick={() => onSelect(agent.id)} aria-label={nested ? `Open subagent ${name}` : `Open ${name}`} title={relationship}>
      <CrewAvatar id={agent.id} status={agent.status} size={22} animated={false} />
      <span className="crew-row-text"><strong>{name}</strong><small>{detail}</small></span>
      <span className={`crew-status crew-status-${agent.status}`} title={STATUS_LABEL[agent.status]} aria-label={STATUS_LABEL[agent.status]} />
    </button>
  );
}

const demoMember = (name: string, role: 'lead' | 'worker', vendor: 'claude' | 'codex', agentId?: string) =>
  ({ id: name, name, role, vendor, agentId, worktree: '', branch: `team/demo/${name}`, merged: false });

/** A labeled sample team for the demo: three of the demo sessions work as one team. */
export const PREVIEW_TEAM: TeamView = {
  id: 'demo-team',
  name: 'Launch squad',
  goal: 'A sample team: a lead plans, two workers build and test.',
  repoRoot: '',
  baseBranch: 'main',
  status: 'running',
  createdAt: 0,
  members: [
    // Vendors match the demo sessions (PREVIEW_CREW alternates Claude, Codex).
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
  requirePlanApproval: true,
  pending: {},
  pendingIds: {},
  resumeGrant: { wakes: 20, minutes: 30 },
  spend: { costUsd: 0, turns: 0 },
};

/** Teams first (oldest first), then solo sessions with their subagents branching from them. */
export function buildClusters(agents: readonly Agent[], teams: readonly TeamView[]): GraphCluster[] {
  const seated = teamAgentIds(teams);
  const deskIds = new Set(agents.filter(a => !seated.has(a.id) && !a.parentId).map(a => a.id));
  const hosted = (a: Agent) => !!a.parentId && deskIds.has(a.parentId);
  const helpers = subagentsByParent(agents.filter(hosted));
  const solos = agents.filter(a => !seated.has(a.id) && !hosted(a))
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id));
  return [
    ...[...teams].sort((a, b) => a.createdAt - b.createdAt).map(team => ({ kind: 'team' as const, team, seats: teamSeats(team, agents) })),
    ...solos.map(agent => ({ kind: 'agent' as const, agent, helpers: helpers.get(agent.id) ?? [] })),
  ];
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(preference.matches);
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** Expanded fills the window: lock page scroll, and let Esc return (unless a drawer or dialog has it). */
function useExpandedLock(expanded: boolean, collapse: () => void) {
  useEffect(() => {
    if (!expanded) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"], .drawer')) collapse();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [expanded, collapse]);
}

function liveLabel(demo: boolean, connected: boolean, authError: boolean): string {
  if (demo) return 'Sample crew';
  if (connected) return 'Live';
  return authError ? 'Access token required' : 'Connecting';
}

export function AgentWorld({ agents, selectedId, connected, authError, onSelect, onLaunch, teams = [], onOpenTeam, pending = [], notify, ready, onLook }: AgentWorldProps) {
  const [officeKey, setOfficeKey] = useState<string>();
  const officeId = useId();
  const [motionPaused, setMotionPaused] = useState(false);
  const [demo, setDemo] = useState(false);
  const [demoId, setDemoId] = useState<string>();
  const [zoomed, setZoomed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const viewport = useDragPan<HTMLDivElement>();
  const reducedMotion = useReducedMotion();
  const collapse = useCallback(() => setExpanded(false), []);
  useExpandedLock(expanded, collapse);
  const paused = motionPaused || reducedMotion;
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
    if (selectedOffice && selectedOffice.key !== activeOfficeKey) setOfficeKey(selectedOffice.key);
  }, [selectedId, offices, activeOfficeKey]);
  useEffect(() => { viewport.current?.scrollTo(0, 0); }, [activeOfficeKey, demo, viewport]);

  const crewAgents = demo ? PREVIEW_CREW : office?.agents ?? [];
  const floorTeams = useMemo(() => (demo ? [PREVIEW_TEAM] : office?.teams ?? []), [office, demo]);
  const clusters = useMemo(() => buildClusters(crewAgents, floorTeams), [crewAgents, floorTeams]);
  const listed = clusters.flatMap(c => c.kind === 'team' ? c.seats.flatMap(s => s.agent ? [s.agent] : []) : [c.agent, ...c.helpers]);
  const crewCount = clusters.reduce((n, c) => n + (c.kind === 'team' ? c.seats.length : 1 + c.helpers.length), 0);
  const workingCount = listed.filter(a => a.status === 'busy').length;
  const shownPending = demo ? DEMO_PENDING : pending;
  const needsYou = listed.filter(a => a.status === 'waiting' || shownPending.some(p => p.agentId === a.id)).length;
  const preview = PREVIEW_CREW.find(a => a.id === demoId);
  const parentName = (agent: Agent) => agents.find(parent => parent.id === agent.parentId)?.name;
  const select = demo ? setDemoId : onSelect;
  const activeSelection = demo ? demoId : selectedId;
  const toggleDemo = () => { setDemo(!demo); setDemoId(undefined); };

  return (
    <section className={`agent-world ${paused ? 'motion-paused' : ''} ${expanded ? 'world-expanded' : ''}`} aria-label="Waystation station">
      <header className="world-toolbar">
        <div className="world-title">
          <h2>Station</h2>
          <span className={`world-live ${demo ? 'world-demo' : ''}`}><span className={`connection-dot ${connected && !demo ? 'live' : ''}`} />{liveLabel(demo, connected, authError)}</span>
        </div>
        <div className="world-stats" aria-label="Station summary">
          <span><b>{crewCount}</b> {crewCount === 1 ? 'session' : 'sessions'}</span>
          <span><b>{workingCount}</b> working</span>
          <span className={needsYou ? 'world-stat-alert' : ''}><b>{needsYou}</b> need you</span>
        </div>
        <div className="world-controls">
          <button className={`world-tool world-tool-text ${demo ? 'world-tool-on' : ''}`} onClick={toggleDemo} aria-pressed={demo} title={demo ? 'Back to your live sessions' : 'Show a labeled sample crew; nothing is launched'}>{demo ? 'Exit demo' : 'Demo'}</button>
          <button className="world-tool" onClick={() => setZoomed(!zoomed)} aria-pressed={zoomed} aria-label={zoomed ? 'Fit station to view' : 'Zoom in on station'} title={zoomed ? 'Fit to view' : 'Zoom in'}><Icon name={zoomed ? 'fit' : 'zoom'} size={15} /></button>
          <button className="world-tool" onClick={() => setMotionPaused(!motionPaused)} disabled={reducedMotion} aria-label={paused ? 'Resume animations' : 'Pause animations'} aria-pressed={paused} title={reducedMotion ? 'Animations are off because of your system motion preference' : paused ? 'Resume animations' : 'Pause animations'}><Icon name={paused ? 'play' : 'pause'} size={15} /></button>
          <button className="world-tool" onClick={() => setExpanded(!expanded)} aria-pressed={expanded} aria-label={expanded ? 'Exit full screen station' : 'Expand station to full screen'} title={expanded ? 'Exit full screen (Esc)' : 'Full screen'}><Icon name={expanded ? 'collapse' : 'expand'} size={15} /></button>
        </div>
      </header>

      {!demo && offices.length > 0 && <div className="office-switcher">
        <div className="office-tabs" role="tablist" aria-label="Working folders">
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
          ><Icon name="folder" size={13} /><span className="office-tab-name">{candidate.name}</span><span className="office-tab-count" aria-label={`${candidate.agents.length} agents`}>{candidate.agents.length}</span></button>)}
        </div>
        <span className="office-location" title={office?.path}>{office?.path ?? 'Working folder unknown'}</span>
      </div>}

      <div className="world-body" id={`${officeId}-panel`} role={!demo && office ? 'tabpanel' : undefined} aria-labelledby={!demo && office ? `${officeId}-tab-${offices.indexOf(office)}` : undefined}>
        <div ref={viewport} className={`graph-canvas ${zoomed ? 'graph-zoomed' : ''}`}>
          {clusters.length > 0
            ? <div className="graph-stage" style={{ zoom: zoomed ? ZOOM_IN : 1 }}>
              <StationGraph clusters={clusters} allAgents={demo ? PREVIEW_CREW : agents} selectedId={activeSelection} onSelect={select} onOpenTeam={demo ? undefined : onOpenTeam} pending={shownPending} notify={notify} demo={demo} ready={demo ? undefined : ready} onLook={demo ? undefined : onLook} />
            </div>
            : <div className="world-empty">
              <span className="world-empty-mark"><CrewAvatar character={CREW[2]} size={36} animated={false} /></span>
              <h3>{authError ? 'Connect to your workspace' : connected ? 'No sessions here yet' : 'Connecting to the daemon…'}</h3>
              <p>{authError ? 'Open the daemon’s access link to connect your agents.' : connected ? 'Launch an agent, or start Claude Code or Codex in a terminal. Each session appears here as a node.' : 'Sessions appear here as soon as the local daemon connects.'}</p>
              <div className="world-empty-actions">
                {connected && <button className="btn btn-go" onClick={onLaunch}><Icon name="plus" size={15} />Launch an agent</button>}
                <button className="btn" onClick={toggleDemo}>Explore the demo</button>
              </div>
            </div>}
          {preview && demo && <div className="demo-inspector" role="status"><CrewAvatar id={preview.id} status={preview.status} size={28} /><div><strong>{preview.name} · {STATUS_LABEL[preview.status]}</strong><span>A sample session. No agent is running in this demo.</span></div><button className="icon-btn" aria-label="Close demo details" onClick={() => setDemoId(undefined)}><Icon name="close" size={14} /></button></div>}
        </div>

        <aside className="crew-panel" aria-label="Sessions in this station">
          <div className="crew-panel-heading"><h3>Sessions</h3><span>{crewCount}</span></div>
          <div className="crew-panel-list">
            {clusters.map(cluster => cluster.kind === 'agent' ? (
              <div key={cluster.agent.id} className="crew-family">
                <CrewRow agent={cluster.agent} parentName={parentName(cluster.agent)} helperCount={cluster.helpers.length} selected={cluster.agent.id === activeSelection} onSelect={select} />
                {cluster.helpers.map(helper => <CrewRow key={helper.id} agent={helper} parentName={cluster.agent.name} nested selected={helper.id === activeSelection} onSelect={select} />)}
              </div>
            ) : (
              <div key={cluster.team.id} className="crew-team">
                <button className="crew-team-head" disabled={demo} onClick={() => onOpenTeam?.(cluster.team.id)} aria-label={`Open team ${cluster.team.name}`}>
                  <span className="crew-row-text"><strong>{cluster.team.name}</strong><small>Team · {cluster.team.tasks.filter(t => t.status === 'done').length}/{cluster.team.tasks.length} tasks</small></span><Icon name="arrow" size={13} />
                </button>
                {cluster.seats.map(seat => {
                  const seatLabel = `${seat.member.name}${seat.member.role === 'lead' ? ' · lead' : ''}`;
                  if (seat.agent) return <CrewRow key={seat.member.id} agent={seat.agent} parentName={parentName(seat.agent)} label={seatLabel} selected={seat.agent.id === activeSelection} onSelect={select} />;
                  return <div key={seat.member.id} className="crew-row crew-row-waiting"><CrewAvatar id={`${cluster.team.id}:${seat.member.name}`} status="stopped" size={22} animated={false} /><span className="crew-row-text"><strong>{seatLabel}</strong><small>Joins on first task · {providerLabel(seat.member)}</small></span></div>;
                })}
              </div>
            ))}
            {clusters.length === 0 && <p className="crew-panel-empty">Nothing here yet.</p>}
          </div>
          <div className="world-legend" aria-label="Status key"><span><i className="legend-working" />Working</span><span><i className="legend-waiting" />Needs you</span><span><i className="legend-idle" />Idle</span></div>
        </aside>
      </div>
    </section>
  );
}
