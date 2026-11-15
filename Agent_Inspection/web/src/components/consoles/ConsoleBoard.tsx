import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Agent, type AgentEvent, type ConsoleInfo, type ConsoleKind, type TeamView } from '../../api.ts';
import type { TeamLogItem } from '../../useTower.ts';
import { BoardTeamsSheet } from './BoardTeamsSheet.tsx';
import { activeTeamCount, managedTeamFrames } from './managedTeams.ts';
import { Icon } from '../Icon.tsx';
import { Confirm } from '../Modal.tsx';
import { BoardItemBody } from './BoardItemBody.tsx';
import { ChannelsPanel } from './ChannelsPanel.tsx';
import { ConsoleCanvas } from './ConsoleCanvas.tsx';
import { ConsoleHeader } from './ConsoleHeader.tsx';
import { renameConsole } from './filesApi.ts';
import { LaunchComposer } from './LaunchComposer.tsx';
import { SavedConsoles } from './SavedConsoles.tsx';
import { FolderSections } from './FolderSections.tsx';
import { ALL_PROJECTS, ProjectStrip } from './ProjectStrip.tsx';
import { UNASSIGNED_KEY, groupByFolder, pickFolder } from './boardFolders.ts';
import { savedPlanningProjects } from './planningBoard.ts';
import type { CanvasReveal } from '../../../../shared/canvasReveal.ts';
import { canvasApi } from './canvasApi.ts';
import { revealHandled } from './canvasReveals.ts';
import { addGroup, loadGroups, pruneGroups, saveGroups, type CanvasGroup } from './canvasGroups.ts';
import { folder as normalizeFolder } from '../../stationOffices.ts';
import {
  buildBoardItems, channelCandidates, countItems, filterItems, itemCwd, itemName, itemStatus, type BoardFilter, type BoardItem,
} from './boardItems.ts';

const POLL_MS = 2000;
const LAYOUT_KEY = 'waystation-console-layout';
const CWD_KEY = 'waystation-console-cwd';
const PROJECT_KEY = 'waystation-console-project';
const RESTORE_WATCH_MS = 6000;
const CANVAS_HINT = 'Canvas shows one project at a time';

const FILTERS: ReadonlyArray<{ readonly id: BoardFilter; readonly label: string }> = [
  { id: 'all', label: 'All' }, { id: 'consoles', label: 'Consoles' }, { id: 'agents', label: 'Agents' }, { id: 'observed', label: 'Observed' },
];

type Layout = 'tiles' | 'focus' | 'canvas';
type Notify = (text: string, kind?: 'ok' | 'error') => void;

/** Older saves hold only 'tiles' or 'focus'; anything unrecognised falls back to tiles. */
const storedLayout = (): Layout => {
  const value = remembered(LAYOUT_KEY, 'tiles');
  return value === 'focus' || value === 'canvas' ? value : 'tiles';
};

function remembered(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function remember(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
}

/**
 * Full-screen state: a fixed full-window board. The browser Fullscreen API is deliberately not used: it hides the
 * toast container (which lives outside the board) and swallows Esc, which Claude Code needs. F11 still works.
 */
function useFullscreen() {
  const [expanded, setExpanded] = useState(false);
  const enter = useCallback(() => setExpanded(true), []);
  const exit = useCallback(() => setExpanded(false), []);

  // Esc leaves full screen, but never while typing into a terminal, dialog or input.
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const inside = event.target instanceof Element && event.target.closest('.terminal-pane, .modal-backdrop, input, textarea, select');
      if (event.key === 'Escape' && !inside) exit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, exit]);

  return { expanded, enter, exit };
}

/** The console board: every running session at once. Real terminals, Waystation agents and observed sessions, each with a live status. */
/** Waystation-run teams: the board shows them as frames on the canvas and in the Teams sheet. The app owns which is open. */
export interface BoardTeams {
  readonly teams: readonly TeamView[];
  readonly teamLogFeed: readonly TeamLogItem[];
  readonly connected: boolean;
  readonly selectedTeamId?: string;
  readonly onSelectTeam: (teamId: string) => void;
  readonly sheetOpen: boolean;
  readonly onSheetOpen: (open: boolean) => void;
  readonly onNewTeam: () => void;
}

export function ConsoleBoard({ defaultCwd, notify, onSwitchToStation, agents, agentsReady = true, lastEvent, onSelectAgent, canvasReveal, teams }: {
  readonly teams: BoardTeams;
  readonly agentsReady?: boolean;
  readonly canvasReveal?: CanvasReveal;
  readonly defaultCwd: string | undefined;
  readonly notify: Notify;
  readonly onSwitchToStation: () => void;
  readonly agents: readonly Agent[];
  readonly lastEvent: AgentEvent | undefined;
  readonly onSelectAgent: (id: string) => void;
}) {
  // Never merge live agents with an older console poll: a session can otherwise flash as an observed tile.
  const [sessions, setSessions] = useState<{ consoles: ConsoleInfo[]; agents: Agent[] }>({ consoles: [], agents: [] });
  const { consoles, agents: boardAgents } = sessions;
  const liveAgents = useRef(agents);
  liveAgents.current = agents;
  const refreshing = useRef<Promise<void> | undefined>(undefined);
  const [tileProjects, setTileProjects] = useState<readonly string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [layout, setLayout] = useState<Layout>(storedLayout);
  const [filter, setFilter] = useState<BoardFilter>('all');
  /** ALL_PROJECTS or a folder key; remembered across visits. */
  const [project, setProject] = useState<string>(() => remembered(PROJECT_KEY, ALL_PROJECTS));
  const [channelsOpen, setChannelsOpen] = useState(false);
  /** The key of the focused item (`console:<id>` or `agent:<id>`). */
  const [focusedKey, setFocusedKey] = useState<string>();
  /** Bumped by the New tile button; the canvas makes the tile and resets it. */
  const [tileRequest, setTileRequest] = useState(0);
  /** The launch dialog: 'several' from the toolbar, 'team' from the canvas dock (team option on). */
  const [composing, setComposing] = useState<'several' | 'team'>();
  const [groups, setGroupsState] = useState<readonly CanvasGroup[]>(() => loadGroups());
  /** Keys of consoles that stopped with the daemon and can be restored; undefined until first listed. */
  const [restorable, setRestorable] = useState<readonly string[]>();
  /** Set while the daemon is unreachable, so one outage raises one toast rather than one every poll. */
  const failing = useRef(false);
  const [closing, setClosing] = useState<ConsoleInfo>();
  const [now, setNow] = useState(Date.now());
  const fullscreen = useFullscreen();

  const refresh = useCallback((): Promise<void> => {
    if (refreshing.current) return refreshing.current;
    const request = (async () => {
      try {
        const [snapshot, canvas] = await Promise.all([api.consoles(), canvasApi.list()]);
        setSessions({ consoles: snapshot.consoles, agents: snapshot.agents ?? [...liveAgents.current] });
        setTileProjects([...new Set(canvas.tiles.map(tile => tile.project))]);
        setLoaded(true);
        failing.current = false;
      } catch (error) {
        if (!failing.current) notify((error as Error).message, 'error');
        failing.current = true;
      }
      setNow(Date.now());
    })();
    refreshing.current = request;
    void request.finally(() => { refreshing.current = undefined; });
    return request;
  }, [notify]);

  // Keep agent status live, but fetch its matching console ownership before changing the board.
  useEffect(() => { void refresh(); }, [agents, refresh]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const items = useMemo(() => buildBoardItems(consoles, boardAgents), [consoles, boardAgents]);
  const allKeys = useMemo(() => items.map((item) => item.key), [items]);

  const setGroups = useCallback((next: readonly CanvasGroup[]) => {
    setGroupsState(next);
    if (!saveGroups(next)) notify('Teams could not be stored in this browser, so they will be lost on reload.', 'error');
  }, [notify]);
  // Closed consoles leave their team. Kept regardless: agent members until the agent list has arrived (so a slow
  // first load cannot dissolve a team), a just-launched team's consoles until the next poll lists them, and consoles
  // waiting to be restored (stopped with the daemon), so a restored console is back in its team.
  useEffect(() => {
    if (!loaded || !agentsReady || !restorable) return;
    const pendingAgents = agents.length === 0 ? groups.flatMap((group) => group.members.filter((key) => key.startsWith('agent:'))) : [];
    const justLaunched = groups.flatMap((group) => (group.arranged ? [] : group.members));
    const pruned = pruneGroups(groups, [...allKeys, ...pendingAgents, ...justLaunched, ...restorable]);
    if (pruned !== groups) setGroups(pruned);
  }, [loaded, agentsReady, restorable, allKeys, agents.length, groups, setGroups]);
  const launched = (ids: readonly string[], team?: string) => {
    setFocusedKey(ids[0] ? `console:${ids[0]}` : undefined);
    if (ids[0]) setReveal(`console:${ids[0]}`);
    if (team) {
      const id = globalThis.crypto?.randomUUID?.() ?? `team-${Date.now()}`;
      setGroups(addGroup(groups, { id, name: team, members: ids.map((consoleId) => `console:${consoleId}`), arranged: false }));
      chooseLayout('canvas');
    }
    void refresh();
  };
  const folders = useMemo(() => {
    const live = groupByFolder(items, now);
    for (const key of new Set([...savedPlanningProjects(), ...tileProjects])) {
      if (!live.some((entry) => entry.key === key)) live.push({ key, name: key === UNASSIGNED_KEY ? 'Unassigned' : key.split(/[\\/]/).filter(Boolean).at(-1) ?? key,
        path: key === UNASSIGNED_KEY ? undefined : key.replace(/^folder:/, ''), items: [], needsYou: 0, running: 0 });
    }
    return live;
  }, [items, now, tileProjects]);
  /** Human ideas own their scope: agents appearing or leaving must never switch a canvas underneath them. */
  const effectiveProject = (() => {
    if (layout === 'canvas') return project;
    if (project !== ALL_PROJECTS) return pickFolder(folders, project)?.key ?? ALL_PROJECTS;
    return ALL_PROJECTS;
  })();
  const currentFolder = folders.find((entry) => entry.key === effectiveProject);
  const projectItems = useMemo(() => (effectiveProject === ALL_PROJECTS ? items : folders.find((entry) => entry.key === effectiveProject)?.items ?? items), [items, folders, effectiveProject]);
  const counts = useMemo(() => countItems(projectItems), [projectItems]);
  const shown = useMemo(() => filterItems(projectItems, filter), [projectItems, filter]);
  const shownFolders = useMemo(() => groupByFolder(shown, now), [shown, now]);
  const candidates = useMemo(() => channelCandidates(items), [items]);
  const teamFrames = useMemo(() => managedTeamFrames(teams.teams, shown.map((item) => item.key)), [teams.teams, shown]);
  const openTeam = (teamId: string) => { teams.onSelectTeam(teamId); teams.onSheetOpen(true); };

  const chooseProject = (next: string) => { setProject(next); remember(PROJECT_KEY, next); };
  const chooseLayout = (next: Layout) => { setLayout(next); remember(LAYOUT_KEY, next); };
  useEffect(() => {
    if (!canvasReveal || revealHandled(canvasReveal.requestId)) return;
    chooseProject(canvasReveal.project); chooseLayout('canvas'); setFilter('all');
    // A new request may show the same tile again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasReveal]);
  /** Switches the strip to the project of an item that has just been opened, once it shows up in the list. */
  const [reveal, setReveal] = useState<string>();
  useEffect(() => {
    const target = reveal ? items.find((item) => item.key === reveal) : undefined;
    if (!target) return;
    setReveal(undefined);
    const key = normalizeFolder(itemCwd(target))?.key ?? UNASSIGNED_KEY;
    if (project !== ALL_PROJECTS) chooseProject(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, items]);
  /** Restoring saved consoles reports no ids, so the first console that appears afterwards is the one to reveal. */
  const baseline = useRef<ReadonlySet<string> | undefined>(undefined);
  useEffect(() => {
    if (!baseline.current) return;
    const fresh = items.find((item) => item.console && !baseline.current?.has(item.key));
    if (!fresh) return;
    baseline.current = undefined;
    setReveal(fresh.key);
  }, [items]);
  const watchForRestored = () => {
    const known = new Set(allKeys);
    baseline.current = known;
    setTimeout(() => { if (baseline.current === known) baseline.current = undefined; }, RESTORE_WATCH_MS);
  };
  /** Opens a console for a canvas tile; undefined (and a toast) when it could not be opened. */
  const open = async (kind: ConsoleKind, cwd: string, name?: string): Promise<ConsoleInfo | undefined> => {
    try {
      const { console: created } = await api.openConsole({ kind, cwd, ...(name ? { name } : {}) });
      remember(CWD_KEY, cwd);
      setFocusedKey(`console:${created.id}`);
      setReveal(`console:${created.id}`);
      await refresh();
      return created;
    } catch (error) {
      notify((error as Error).message, 'error');
      return undefined;
    }
  };
  /** A console's name lives in the daemon (and is kept for the next start); another agent's in the agent registry. */
  const renameItem = async (item: BoardItem, name: string): Promise<void> => {
    try {
      if (item.console) await renameConsole(item.console.id, name);
      else if (item.agent) await api.rename(item.agent.id, name);
      await refresh();
    } catch (error) {
      notify(`Could not rename ${itemName(item)}: ${(error as Error).message}`, 'error');
    }
  };
  /** Tiles live on the canvas, so asking for one also switches to it. */
  const requestTile = () => { chooseLayout('canvas'); setTileRequest((count) => count + 1); };
  const close = async (info: ConsoleInfo) => {
    try {
      await api.dismissConsole(info.id);
      setFocusedKey((current) => (current === `console:${info.id}` ? undefined : current));
      await refresh();
    } catch (error) {
      notify((error as Error).message, 'error');
    }
  };
  const requestClose = (item: BoardItem) => {
    const info = item.console;
    if (info) (info.state === 'running' ? setClosing(info) : void close(info));
  };
  const openAsTerminal = async (agentId: string) => {
    try {
      const result = await api.openAgentInConsole(agentId);
      notify(result.message);
      if (result.consoleId) { setFocusedKey(`console:${result.consoleId}`); setReveal(`console:${result.consoleId}`); }
      await refresh();
    } catch (error) {
      notify((error as Error).message, 'error');
    }
  };
  /** The details drawer sits under the expanded board, so leave full screen first. */
  const showDetails = (agentId: string) => { fullscreen.exit(); onSelectAgent(agentId); };
  const { onSheetOpen } = teams;
  const closeTeams = useCallback(() => onSheetOpen(false), [onSheetOpen]);

  /** Focus lists sessions grouped by folder, so its default (first) session is the first in that order. */
  const ordered = useMemo(() => shownFolders.flatMap((entry) => entry.items), [shownFolders]);
  const focused = shown.find((item) => item.key === focusedKey) ?? (layout === 'focus' ? ordered[0] : undefined);
  const visible = layout === 'focus' && focused ? [focused] : shown;
  const toggleFocus = (item: BoardItem) => {
    if (layout === 'focus') { chooseLayout('tiles'); return; }
    setFocusedKey(item.key);
    chooseLayout('focus');
  };
  const running = projectItems.filter((item) => itemStatus(item, now) !== 'exited').length;
  const rootClass = fullscreen.expanded ? 'console-board surface-dark console-board-expanded' : 'console-board surface-dark';
  const terminalOf = (id: string) => void openAsTerminal(id);
  const renderTile = (item: BoardItem) => <article key={item.key} className="console-tile">
    <ConsoleHeader item={item} status={itemStatus(item, now)} focused={layout === 'focus'} onFocus={() => toggleFocus(item)}
      onClose={() => requestClose(item)} onDetails={showDetails} onOpenAsTerminal={terminalOf} onRename={renameItem} />
    <BoardItemBody item={item} lastEvent={lastEvent} notify={notify} />
  </article>;
  return <section className={rootClass} aria-label="Console board">
    <div className="console-toolbar">
      <button className="btn btn-go" onClick={requestTile} title="A tile on the canvas that becomes an agent, a console or a browser"><Icon name="plus" size={16} />New tile</button>
      <button className="btn btn-ghost" onClick={() => setComposing('several')}><Icon name="grid" size={16} />Launch several</button>
      <div className="console-layout" role="group" aria-label="Layout">
        <button className={layout === 'tiles' ? 'seg-on' : ''} aria-pressed={layout === 'tiles'} onClick={() => chooseLayout('tiles')}><Icon name="grid" size={15} />Tiles</button>
        <button className={layout === 'focus' ? 'seg-on' : ''} aria-pressed={layout === 'focus'} onClick={() => chooseLayout('focus')}><Icon name="list" size={15} />Focus</button>
        <button className={layout === 'canvas' ? 'seg-on' : ''} aria-pressed={layout === 'canvas'} onClick={() => chooseLayout('canvas')}><Icon name="planet" size={15} />Canvas</button>
      </div>
      <div className="console-layout console-filters" role="group" aria-label="Show">
        {FILTERS.map((option) => <button key={option.id} className={filter === option.id ? 'seg-on' : ''} aria-pressed={filter === option.id} onClick={() => setFilter(option.id)}>
          {option.label}<span className="console-filter-count">{counts[option.id]}</span>
        </button>)}
      </div>
      <span className="console-count">{running} running</span>
      <button className={teams.sheetOpen ? 'btn btn-ghost console-switch console-toggle-on' : 'btn btn-ghost console-switch'} aria-pressed={teams.sheetOpen}
        onClick={() => teams.onSheetOpen(!teams.sheetOpen)} title="Waystation-run teams: task boards, conversations and outputs">
        <Icon name="crew" size={16} />Teams<span className="console-filter-count">{activeTeamCount(teams.teams)}</span>
      </button>
      <button className={channelsOpen ? 'btn btn-ghost console-toggle-on' : 'btn btn-ghost'} aria-pressed={channelsOpen} onClick={() => setChannelsOpen((on) => !on)}
        title="Channels: let running sessions message and wake each other"><Icon name="message" size={16} />Channels</button>
      <button className="btn btn-ghost" aria-pressed={fullscreen.expanded} onClick={fullscreen.expanded ? fullscreen.exit : fullscreen.enter}
        title={fullscreen.expanded ? 'Leave full screen (Esc)' : 'Expand the board to the whole window (press F11 for true browser full screen)'}>
        <Icon name={fullscreen.expanded ? 'collapse' : 'expand'} size={16} />{fullscreen.expanded ? 'Exit full screen' : 'Full screen'}
      </button>
      <button className="btn btn-ghost" onClick={onSwitchToStation}><Icon name="planet" size={16} />Station view</button>
    </div>

    {folders.length > 0 && <ProjectStrip folders={folders} total={items.length} value={effectiveProject} onChange={chooseProject}
      hint={layout === 'canvas' ? CANVAS_HINT : undefined} />}

    <SavedConsoles notify={notify} onList={setRestorable} onChanged={async () => { watchForRestored(); await refresh(); }} />

    {loaded && items.length === 0 && layout !== 'canvas' && <div className="console-empty">
      <Icon name="terminal" size={30} />
      <h2>No sessions yet</h2>
      <p>Make a tile on the canvas and choose what it becomes: Claude Code, Codex, a shell or a browser. Agents started from Waystation and sessions it observes show up here too.</p>
      <div className="console-empty-actions"><button className="btn" onClick={requestTile}>New tile</button></div>
    </div>}
    {items.length > 0 && shown.length === 0 && layout !== 'canvas' && <div className="console-empty"><p>Nothing in this view. Choose another filter.</p></div>}

    <div className="console-body">
      {layout === 'canvas' && <ConsoleCanvas projectKey={effectiveProject} itemsReady={loaded && agentsReady} projectName={currentFolder?.name ?? 'All projects'}
        defaultCwd={currentFolder?.path ?? remembered(CWD_KEY, defaultCwd ?? '')} items={shown} allKeys={allKeys} now={now} lastEvent={lastEvent} notify={notify}
        onFocus={toggleFocus} onClose={requestClose} onDetails={showDetails} onOpenAsTerminal={terminalOf}
        groups={groups} onGroupsChange={setGroups} onOpenConsole={open} onRename={renameItem} onSpawnTeam={() => setComposing('team')}
        tileRequest={tileRequest} onTileRequestDone={() => setTileRequest(0)} canvasReveal={canvasReveal}
        managedTeams={teamFrames} onOpenTeam={openTeam} />}

      {shown.length > 0 && layout === 'tiles' && effectiveProject === ALL_PROJECTS && <div className="console-stage console-stage-tiles">
        <FolderSections folders={shownFolders} renderTile={renderTile} />
      </div>}

      {shown.length > 0 && (layout === 'focus' || (layout === 'tiles' && effectiveProject !== ALL_PROJECTS)) && <div className={`console-stage console-stage-${layout}`}>
        {layout === 'focus' && <nav className="console-rail" aria-label="Sessions">
          {shownFolders.map((entry) => <div key={entry.key} className="console-rail-group" role="group" aria-label={entry.name}>
            {shownFolders.length > 1 && <div className="console-rail-folder" title={entry.path ?? entry.name}>{entry.name}</div>}
            {entry.items.map((item) => <button key={item.key} className={item.key === focused?.key ? 'console-rail-on' : ''} onClick={() => setFocusedKey(item.key)}>
              <span className={`console-dot console-dot-${itemStatus(item, now)}`} />{itemName(item)}
            </button>)}
          </div>)}
        </nav>}
        <div className={`console-tiles console-tiles-${layout === 'focus' ? 1 : Math.min(visible.length, 4)}`}>
          {visible.map(renderTile)}
        </div>
      </div>}

      {channelsOpen && <div className="console-side"><ChannelsPanel candidates={candidates} notify={notify} onClose={() => setChannelsOpen(false)} /></div>}
      {teams.sheetOpen && <BoardTeamsSheet teams={teams.teams} agents={agents} selectedTeamId={teams.selectedTeamId} teamLogFeed={teams.teamLogFeed} now={now}
        connected={teams.connected} onSelectTeam={teams.onSelectTeam} onSelectAgent={showDetails} onNewTeam={teams.onNewTeam} notify={notify}
        onClose={closeTeams} />}
    </div>

    {composing && <LaunchComposer defaultCwd={remembered(CWD_KEY, defaultCwd ?? '')} notify={notify} onClose={() => setComposing(undefined)}
      asTeamByDefault={composing === 'team'} onLaunched={launched} />}
    {closing && <Confirm title="End this console?" danger confirmLabel="End console" onClose={() => setClosing(undefined)} onConfirm={() => void close(closing)}
      body={<p>{closing.name} is still running. Ending it stops the process and anything it is doing.</p>} />}
  </section>;
}
