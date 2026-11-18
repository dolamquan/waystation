import { providerKey, providerLabel } from '../../shared/agentProviders.ts';
import { useProviders } from './useProviders.ts';
import { AnimatePresence, motion } from 'framer-motion';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { api, autostart, isRemote, type Agent } from './api.ts';
import { useTower } from './useTower.ts';
import { PowerOn } from './components/PowerOn.tsx';
import { AgentCard } from './components/AgentCard.tsx';
import { AgentDrawer } from './components/AgentDrawer.tsx';
import { ApprovalPanel } from './components/ApprovalPanel.tsx';
import { NewAgentDialog } from './components/NewAgentDialog.tsx';
import { Confirm } from './components/Modal.tsx';
import { Icon } from './components/Icon.tsx';
import { AgentWorld } from './components/AgentWorld.tsx';
import { AwayRecap } from './components/AwayRecap.tsx';
import { NewTeamDialog } from './components/NewTeamDialog.tsx';
import { OpsView } from './components/OpsView.tsx';
import { LibraryView } from './components/library/LibraryView.tsx';
import { UpdatesBadge } from './components/library/UpdatesBadge.tsx';
import { nestSubagents } from './crew.ts';
import { desktop } from './desktop.ts';
import { DesktopSetup } from './components/DesktopSetup.tsx';
import { SessionHistory } from './components/SessionHistory.tsx';
import { unseenReady } from './readyToLook.ts';
import { useNeedsYou } from './components/consoles/useNeedsYou.ts';
import { FactoryView, FactoryAttention } from './components/factory/FactoryView.tsx';
import { useFactory } from './components/factory/useFactory.ts';
import { FACTORY_ATTENTION } from '../../shared/factory.ts';
import { useUiTheme } from './uiTheme.ts';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette.tsx';
import { ContentionPanel } from './components/ContentionPanel.tsx';
import { SpendBanner } from './components/SpendCapPanel.tsx';
import { useSpendCap } from './useSpendCap.ts';
import { isTypingTarget, stepQueue, triageQueue, type TriageItem } from './triage.ts';

/** Loaded on first use: the terminal engine is a sizeable bundle that the station view never needs. */
const ConsoleBoard = lazy(() => import('./components/consoles/ConsoleBoard.tsx').then((module) => ({ default: module.ConsoleBoard })));
const ArchitectureView = lazy(() => import('./components/architecture/ArchitectureView.tsx').then(module => ({ default: module.ArchitectureView })));

type Toast = { id: number; text: string; kind: 'ok' | 'error' };
type Filter = string;
type View = 'fleet' | 'consoles' | 'attention' | 'ops' | 'library' | 'setup' | 'history' | 'factory' | 'architecture';
const MODE_KEY = 'waystation-mode';

/** The view the operator last chose between the station and the console board. */
function savedView(): View {
  try { return localStorage.getItem(MODE_KEY) === 'consoles' ? 'consoles' : 'fleet'; } catch { return 'fleet'; }
}
const VIEW_TITLE: Record<View, { crumb: string; title: string; subtitle: string }> = {
  architecture: { crumb: 'Architecture', title: 'Build your agent architecture', subtitle: 'Define roles, connect LLM brains, and shape how your agents work together.' },
  fleet: { crumb: 'Overview', title: 'Your workspace', subtitle: 'See your coding agents together, with each session’s available controls in one place.' },
  factory: { crumb: 'Software factory', title: 'Your software factory', subtitle: 'A reusable crew and process, from a scoped request to a change you can trust.' },
  consoles: { crumb: 'Console board', title: 'Console board', subtitle: 'Real Claude Code, Codex and shell terminals, side by side.' },
  attention: { crumb: 'Needs attention', title: 'Needs attention', subtitle: 'Sessions waiting for your input or approval.' },
  ops: { crumb: 'Usage & schedules', title: 'Usage & schedules', subtitle: 'The numbers so far, and what’s on the calendar.' },
  library: { crumb: 'Library', title: 'The library', subtitle: 'Your shelf of skills, notes and useful tools.' },
  setup: { crumb: 'Desktop setup', title: 'Set up your station', subtitle: 'Connect the tools you use, then make yourself at home.' },
  history: { crumb: 'Session history', title: 'Session history', subtitle: 'Find past work, review its results, and recover interrupted conversations.' },
};
const TOAST_MS = 4200;
/** Views that show the approvals list, where a held tool call can take keyboard focus. */
const APPROVAL_VIEWS: readonly View[] = ['fleet', 'attention'];
/** Terminals and code editors keep Ctrl+K for themselves. */
const KEY_OWNERS = '.xterm, .monaco-editor';
const CLOCK_MS = 5000;

export function App() {
  useProviders();
  const uiTheme = useUiTheme();
  // A paired remote device has already been through the pairing screen: go straight in.
  const [powered, setPowered] = useState(() => Boolean(desktop()) || autostart() || isRemote());
  const tower = useTower(powered);
  const factory = useFactory(powered);
  const [factoryItemId, setFactoryItemId] = useState<string>();
  const factoryAttentionCount = factory.data?.items.filter(item => FACTORY_ATTENTION.includes(item.status)).length ?? 0;
  const consolesNeedingYou = useNeedsYou(powered);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [historicalAgent, setHistoricalAgent] = useState<Agent>();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [hookConfirm, setHookConfirm] = useState<'install' | 'uninstall' | undefined>();
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<View>(savedView);
  useEffect(() => { if (tower.canvasReveal) { setView('consoles'); setSelectedId(undefined); } }, [tower.canvasReveal]);
  const [showNewTeam, setShowNewTeam] = useState(false);
  const [selectedTeamId, setSelectedTeamId] = useState<string | undefined>();
  /** Teams live on the console board: its Teams sheet shows the selected team's tasks, conversation and outputs. */
  const [teamsSheetOpen, setTeamsSheetOpen] = useState(false);
  const openTeamOnBoard = (teamId: string) => { setSelectedTeamId(teamId); setTeamsSheetOpen(true); setView('consoles'); };
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  const [now, setNow] = useState(Date.now());
  /** When the operator last opened each agent: a "Ready to look" card hides once its result has been seen. */
  const [lookedAt, setLookedAt] = useState<Readonly<Record<string, number>>>({});
  const [previewRequest, setPreviewRequest] = useState<{ readonly id: string; readonly seq: number }>();
  const [showPalette, setShowPalette] = useState(false);
  /** The "needs you" item keyboard triage last moved to (N / Shift+N). */
  const [triageKey, setTriageKey] = useState<string>();
  const spend = useSpendCap(powered);

  useEffect(() => {
    const bridge = desktop();
    if (!bridge) return;
    let cancelled = false;
    void bridge.getSettings().then((settings) => { if (!cancelled && !settings.setupComplete) setView('setup'); }, () => undefined);
    const unsubscribe = bridge.onNavigate((destination) => { setPowered(true); setView(destination); setSelectedId(undefined); });
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (view !== 'fleet' && view !== 'consoles') return;
    try { localStorage.setItem(MODE_KEY, view === 'consoles' ? 'consoles' : 'station'); } catch { /* storage blocked */ }
  }, [view]);

  const notify = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TOAST_MS);
  }, []);

  const sharedFiles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of tower.contention) for (const { agentId } of entry.agents) counts.set(agentId, (counts.get(agentId) ?? 0) + 1);
    return counts;
  }, [tower.contention]);
  const scopedAgents = useMemo(
    () => tower.agents.filter((a) => view === 'fleet' || a.status === 'waiting' || (a.breaker && a.breaker.level !== 'ok') || tower.pending.some((p) => p.agentId === a.id) || sharedFiles.has(a.id)),
    [tower.agents, tower.pending, view, sharedFiles],
  );
  const agents = useMemo(
    () => scopedAgents.filter((a) =>
      (filter === 'all' || providerKey(a) === filter) &&
      `${providerLabel(a)} ${a.name} ${a.project} ${a.cwd ?? ''} ${a.currentActivity ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
    ).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : (b.lastEventAt ?? b.startedAt ?? 0) - (a.lastEventAt ?? a.startedAt ?? 0)),
    [scopedAgents, filter, query, sort],
  );
  const providers = [...new Map(scopedAgents.map(agent => [providerKey(agent), providerLabel(agent)])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  useEffect(() => {
    if (filter !== 'all' && !scopedAgents.some(agent => providerKey(agent) === filter)) setFilter('all');
  }, [filter, scopedAgents]);
  const selected = tower.agents.find((a) => a.id === selectedId) ?? (historicalAgent?.id === selectedId ? historicalAgent : undefined);
  const ready = useMemo(() => unseenReady(tower.turns.ready, lookedAt, selectedId), [tower.turns.ready, lookedAt, selectedId]);
  // Opening an agent (any way) counts as seeing its newest result.
  const readyAt = selectedId ? tower.turns.ready.get(selectedId) : undefined;
  useEffect(() => {
    if (selectedId && readyAt !== undefined) setLookedAt((seen) => ((seen[selectedId] ?? 0) >= readyAt ? seen : { ...seen, [selectedId]: readyAt }));
  }, [selectedId, readyAt]);
  const lookAt = useCallback((id: string) => {
    setSelectedId(id);
    setPreviewRequest((request) => ({ id, seq: (request?.seq ?? 0) + 1 }));
  }, []);
  const counts = {
    total: tower.agents.length,
    busy: tower.agents.filter((a) => a.status === 'busy').length,
    waiting: tower.pending.length,
    attention: tower.agents.filter((a) => a.status === 'waiting' || (a.breaker && a.breaker.level !== 'ok') || tower.pending.some((p) => p.agentId === a.id) || sharedFiles.has(a.id)).length,
    controlled: tower.agents.filter((a) => a.tier === 'A' || (a.tier === 'B' && tower.hooksInstalled)).length,
  };

  const queue = useMemo(() => triageQueue(tower.pending, tower.agents, tower.contention), [tower.pending, tower.agents, tower.contention]);

  /** Shows a triage item where it can be acted on: approvals and shared files in a list, agents in their drawer. */
  const goTo = useCallback((item: TriageItem) => {
    setTriageKey(item.key);
    if (item.kind === 'guard' || item.kind === 'waiting') { setSelectedId(item.agentId); return; }
    const showsItem = item.kind === 'contention' ? view === 'fleet' || view === 'attention' : APPROVAL_VIEWS.includes(view);
    if (!showsItem) { setView('attention'); setFilter('all'); setQuery(''); }
  }, [view]);

  const stepTriage = useCallback((direction: 1 | -1) => {
    const next = stepQueue(queue, triageKey, direction);
    if (next) goTo(next);
    else notify('Nothing needs you right now.');
  }, [queue, triageKey, goTo, notify]);

  useEffect(() => {
    if (!powered) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        if (target?.closest?.(KEY_OWNERS)) return;
        event.preventDefault();
        setShowPalette((open) => !open);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || isTypingTarget(target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        stepTriage(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [powered, stepTriage]);

  const toggleHooks = async (action: 'install' | 'uninstall') => {
    try {
      if (action === 'install') {
        const r = await api.installHooks();
        notify(`Hooks installed${r.backup ? ' (settings backed up)' : ''}. New Claude sessions are covered; restart older ones if needed.`);
      } else {
        await api.uninstallHooks();
        notify('Hooks removed from ~/.claude/settings.json');
      }
    } catch (error) {
      notify((error as Error).message, 'error');
    }
  };

  const go = (destination: View) => () => {
    setView(destination);
    setSelectedId(undefined);
    if (destination === 'fleet' || destination === 'attention') { setFilter('all'); setQuery(''); }
  };
  const paletteCommands: PaletteCommand[] = [
    { id: 'next', group: 'Actions', label: 'Next item needing you', hint: queue.length ? `${queue.length} waiting · N` : 'All caught up', run: () => stepTriage(1) },
    { id: 'new-agent', group: 'Actions', label: 'New agent', run: () => setShowNew(true) },
    { id: 'new-team', group: 'Actions', label: 'New team', run: () => setShowNewTeam(true) },
    { id: 'theme', group: 'Actions', label: uiTheme.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', run: uiTheme.toggle },
    { id: 'hooks', group: 'Actions', label: tower.hooksInstalled ? 'Manage hooks' : 'Install hooks', keywords: 'claude intercept', run: () => setHookConfirm(tower.hooksInstalled ? 'uninstall' : 'install') },
    { id: 'spend-cap', group: 'Actions', label: 'Set the daily spend cap', keywords: 'budget cost quota limit', run: go('ops') },
    ...queue.map((item): PaletteCommand => ({ id: `triage:${item.key}`, group: 'Needs you', label: item.label, run: () => goTo(item) })),
    ...(Object.keys(VIEW_TITLE) as View[]).filter((id) => id !== 'setup' || desktop())
      .map((id): PaletteCommand => ({ id: `view:${id}`, group: 'Go to', label: VIEW_TITLE[id].crumb, run: go(id) })),
    ...tower.agents.map((agent): PaletteCommand => ({
      id: `agent:${agent.id}`, group: 'Agents', label: agent.name, hint: `${agent.project} · ${agent.status}`,
      keywords: `${providerLabel(agent)} ${agent.model ?? ''}`, run: () => setSelectedId(agent.id),
    })),
    ...tower.teams.filter((team) => team.status !== 'disbanded').map((team): PaletteCommand => ({
      id: `team:${team.id}`, group: 'Teams', label: team.name, hint: team.status, run: () => openTeamOnBoard(team.id),
    })),
  ];
  const focusedItem = queue.find((item) => item.key === triageKey);

  return (
    <>
      <AnimatePresence mode="wait">
        {!powered ? (
          <PowerOn key="standby" onReady={() => setPowered(true)} />
        ) : (
          <motion.div key="tower" className="tower workbench-content" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}>
            <aside className="sidebar">
              <div className="sidebar-brand"><span className="brand-mark" aria-hidden="true" /><div>Waystation<span>Agent workspace</span></div></div>
              <div className="workspace-label"><span className="workspace-avatar"><Icon name="terminal" size={17} /></span><div>Local workspace<small>This machine</small></div><span className={`connection-dot ${tower.connected ? 'live' : ''}`} /></div>
              <div className="nav-label">Workspace</div>
              <nav className="sidebar-nav" aria-label="Workspace">
                <button className={view === 'fleet' ? 'nav-active' : ''} aria-current={view === 'fleet' ? 'page' : undefined} onClick={() => { setView('fleet'); setFilter('all'); setQuery(''); }}><Icon name="grid" />Agent overview<span className="nav-count">{counts.total}</span></button>
                <button className={view === 'consoles' ? 'nav-active' : ''} aria-current={view === 'consoles' ? 'page' : undefined} onClick={() => { setView('consoles'); setSelectedId(undefined); }}><Icon name="terminal" />Console board{consolesNeedingYou > 0 && <span className="nav-count nav-alert">{consolesNeedingYou}</span>}</button>
                <button className={view === 'factory' ? 'nav-active' : ''} aria-current={view === 'factory' ? 'page' : undefined} onClick={() => { setFactoryItemId(undefined); setView('factory'); setSelectedId(undefined); }}><Icon name="tower" />Software factory{factoryAttentionCount > 0 && <span className="nav-count nav-alert">{factoryAttentionCount}</span>}</button>
                <button className={view === 'architecture' ? 'nav-active' : ''} aria-current={view === 'architecture' ? 'page' : undefined} onClick={() => { setView('architecture'); setSelectedId(undefined); }}><Icon name="git" />Architecture</button>
                <button className={view === 'attention' ? 'nav-active' : ''} aria-current={view === 'attention' ? 'page' : undefined} onClick={() => { setView('attention'); setFilter('all'); setQuery(''); }}><Icon name="alert" />Needs attention<span className={`nav-count ${counts.attention + factoryAttentionCount ? 'nav-alert' : ''}`}>{counts.attention + factoryAttentionCount}</span></button>
                <button className={view === 'ops' ? 'nav-active' : ''} aria-current={view === 'ops' ? 'page' : undefined} onClick={() => setView('ops')}><Icon name="activity" />Usage &amp; schedules</button>
                <button className={view === 'history' ? 'nav-active' : ''} aria-current={view === 'history' ? 'page' : undefined} onClick={() => setView('history')}><Icon name="list" />Session history</button>
                <button className={view === 'library' ? 'nav-active' : ''} aria-current={view === 'library' ? 'page' : undefined} onClick={() => setView('library')}><Icon name="book" />Library<UpdatesBadge /></button>
                {desktop() && <button className={view === 'setup' ? 'nav-active' : ''} aria-current={view === 'setup' ? 'page' : undefined} onClick={() => setView('setup')}><Icon name="shield" />Desktop setup</button>}
              </nav>
              <div className="sidebar-bottom">
                <div className="integration-card"><Icon name="link" /><strong>Connect your sessions</strong><p>Use Claude Code hooks to review tools and send instructions.</p><button onClick={() => setHookConfirm(tower.hooksInstalled ? 'uninstall' : 'install')}>{tower.hooksInstalled ? 'Manage hooks' : 'Set up hooks'}<Icon name="arrow" size={15} /></button></div>
                <div className="sidebar-status"><span className={`connection-dot ${tower.connected ? 'live' : ''}`} />{tower.connected ? 'Daemon connected' : tower.authError ? 'Access token required' : 'Connecting to daemon'}<small>v0.1</small></div>
              </div>
            </aside>
            <div className={`main-shell ${selected ? 'shell-with-drawer' : ''}`}>
            <header className="topbar">
              <div className="breadcrumb">Workspace<span>/</span><strong>{VIEW_TITLE[view].crumb}</strong></div>
              <div className="topbar-actions">
                <button className="btn btn-small palette-trigger" onClick={() => setShowPalette(true)} title="Jump to an agent, team or action" aria-keyshortcuts="Control+K">
                  <Icon name="search" size={15} />Search<kbd>Ctrl K</kbd>
                </button>
                <button
                  className="btn btn-small"
                  onClick={() => { setView(view === 'consoles' ? 'fleet' : 'consoles'); setSelectedId(undefined); }}
                  title={view === 'consoles' ? 'Back to the station' : 'Switch to real terminals side by side'}
                >
                  <Icon name={view === 'consoles' ? 'grid' : 'terminal'} size={15} />{view === 'consoles' ? 'Station view' : 'Console view'}
                </button>
                <button
                  className={`btn btn-small ${tower.hooksInstalled ? 'btn-ok' : ''}`}
                  onClick={() => setHookConfirm(tower.hooksInstalled ? 'uninstall' : 'install')}
                  title="Claude Code hooks let the tower intercept and instruct existing sessions"
                >
                  <Icon name="link" size={15} />{tower.hooksInstalled ? 'Hooks connected' : 'Install hooks'}
                </button>
                <button className="icon-btn theme-toggle" onClick={uiTheme.toggle} aria-label={uiTheme.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title={uiTheme.theme === 'dark' ? 'Light theme' : 'Dark theme'}><Icon name={uiTheme.theme === 'dark' ? 'sun' : 'moon'} size={16} /></button>
                <button className="icon-btn power-off" onClick={() => { setPowered(false); setSelectedId(undefined); }} aria-label="Power off view" title="Back to standby"><Icon name="power" size={17} /></button>
              </div>
            </header>

            <div className="dashboard-content" data-view={view}>
              {view !== 'ops' && <SpendBanner status={spend.view?.status} onReview={() => setView('ops')} />}
              <section className="page-heading">
                <div><h1>{VIEW_TITLE[view].title}</h1><p>{VIEW_TITLE[view].subtitle}</p></div>
                <div className="page-heading-tools">
                {(view === 'fleet' || view === 'attention') && <button className="btn btn-go" onClick={() => setShowNew(true)}><Icon name="plus" size={17} />New agent</button>}
                </div>
              </section>

              {view === 'ops' && <OpsView agents={tower.agents} onSelect={setSelectedId} defaultCwd={selected?.cwd} notify={notify} onNewAgent={() => setShowNew(true)} />}
              {view === 'setup' && <DesktopSetup onDone={() => setView('fleet')} />}
              {view === 'library' && <LibraryView notify={notify} />}
              {view === 'architecture' && <Suspense fallback={<p role="status">Loading architecture workspace…</p>}><ArchitectureView agents={tower.agents} pending={tower.pending} onOpenAgent={setSelectedId} /></Suspense>}
              {view === 'consoles' && <Suspense fallback={<p className="console-note">Loading the console board…</p>}>
                <ConsoleBoard defaultCwd={selected?.cwd} notify={notify} onSwitchToStation={() => setView('fleet')} agents={tower.agents} agentsReady={tower.connected && tower.snapshotReady} lastEvent={tower.lastEvent} onSelectAgent={setSelectedId} canvasReveal={tower.canvasReveal}
                  teams={{ teams: tower.teams, teamLogFeed: tower.teamLogFeed, connected: tower.connected, selectedTeamId, onSelectTeam: setSelectedTeamId,
                    sheetOpen: teamsSheetOpen, onSheetOpen: setTeamsSheetOpen, onNewTeam: () => setShowNewTeam(true) }} />
              </Suspense>}
              {view === 'history' && <SessionHistory now={now} notify={notify} onOpen={agent => { setHistoricalAgent(agent); setSelectedId(agent.id); }} />}
              {view === 'factory' && <FactoryView data={factory.data} error={factory.error} refresh={factory.refresh} initialItemId={factoryItemId} onOpenAgent={setSelectedId} agents={tower.agents} connected={tower.connected} />}
              {view === 'attention' && <FactoryAttention items={factory.data?.items ?? []} onOpen={id => { setFactoryItemId(id); setView('factory'); }} />}
              {(view === 'fleet' || view === 'attention') && <>
              {view === 'fleet' && <AgentWorld agents={tower.agents} teams={tower.teams} onOpenTeam={openTeamOnBoard} selectedId={selectedId} connected={tower.connected} authError={tower.authError} onSelect={setSelectedId} onLaunch={() => setShowNew(true)} pending={tower.pending} notify={notify} ready={ready} onLook={lookAt} />}

              {view === 'fleet' && tower.connected && <AwayRecap agents={tower.agents} pending={tower.pending} now={now} onSelect={setSelectedId} />}
              <section className="metric-grid fleet-metrics" aria-label="Fleet summary">
                <div className="metric"><div className="metric-label">Total agents<Icon name="grid" /></div><div className="metric-value">{counts.total}</div><div className="metric-note">Across your local workspace</div></div>
                <div className="metric"><div className="metric-label">Working now<Icon name="activity" /></div><div className="metric-value">{counts.busy}<span className="metric-indicator"><span className="connection-dot live" />{counts.busy ? 'Active' : 'Quiet'}</span></div><div className="metric-note">Agents currently on a task</div></div>
                <button className={`metric metric-button ${counts.waiting ? 'metric-attention' : ''}`} onClick={() => { setView('attention'); setFilter('all'); setQuery(''); }}><div className="metric-label">Pending approvals<Icon name="alert" /></div><div className="metric-value">{counts.waiting}</div><div className="metric-note">{counts.waiting ? 'Tool calls waiting for your review' : 'No tool calls waiting for review'}<Icon name="arrow" size={14} /></div></button>
                <div className="metric"><div className="metric-label">With control<Icon name="shield" /></div><div className="metric-value">{counts.controlled}</div><div className="metric-note">Managed or connected through hooks</div></div>
              </section>

            <ApprovalPanel pending={tower.pending} agents={tower.agents} notify={notify} focusedId={focusedItem?.pendingId} />
            <ContentionPanel contention={tower.contention} agents={tower.agents} now={now} notify={notify} onSelect={setSelectedId} focusedPath={focusedItem?.path} />

            <section className="fleet-section" aria-label="Agents">
            <div className="section-heading"><div><h2>{view === 'fleet' ? 'Your agents' : 'Waiting agents'}<span className="section-count">{agents.length}</span></h2><p>Select a session to view its activity and available actions.</p></div><span className="live-label"><span className={`connection-dot ${tower.connected ? 'live' : ''}`} />{tower.connected ? 'Updating live' : tower.authError ? 'Authentication needed' : 'Reconnecting'}</span></div>
            <div className="fleet-toolbar">
            <nav className="filters" aria-label="Filter agents">
              {[['all', 'All'], ...providers].map(([f, label]) => (
                <button key={f} className={`chip ${filter === f ? 'chip-on' : ''}`} onClick={() => setFilter(f)} aria-pressed={filter === f}>
                  {label}
                  <span className="chip-count">{f === 'all' ? scopedAgents.length : scopedAgents.filter((a) => providerKey(a) === f).length}</span>
                </button>
              ))}
            </nav>
              <div className="fleet-tools"><label className="search-field"><Icon name="search" size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search agents…" aria-label="Search agents" />{query && <button className="search-clear" onClick={() => setQuery('')} aria-label="Clear search"><Icon name="close" size={13} /></button>}</label><select className="sort-select" value={sort} onChange={(e) => setSort(e.target.value as 'recent' | 'name')} aria-label="Sort agents"><option value="recent">Recent activity</option><option value="name">Name A–Z</option></select><div className="view-toggle" aria-label="Agent layout"><button className={layout === 'grid' ? 'view-active' : ''} aria-label="Grid view" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><Icon name="grid" size={16} /></button><button className={layout === 'list' ? 'view-active' : ''} aria-label="List view" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><Icon name="list" size={17} /></button></div></div>
            </div>

            <main className={`grid ${layout === 'list' ? 'agent-list' : ''}`}>
              <AnimatePresence>
                {nestSubagents(agents).map(({ agent, nested, depth, subagentCount }) => (
                  <AgentCard key={agent.id} agent={agent} sharedFiles={sharedFiles.get(agent.id)} nested={nested} depth={depth} parentName={tower.agents.find(parent => parent.id === agent.parentId)?.name} subagentCount={subagentCount} selected={agent.id === selectedId} now={now} onSelect={setSelectedId} />
                ))}
              </AnimatePresence>
              {agents.length === 0 && (
                <motion.div className="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <div className="empty-icon"><Icon name={query || filter !== 'all' ? 'search' : view === 'attention' ? 'check' : 'tower'} size={30} /></div>
                  <h3>{tower.authError ? 'Connect to your workspace' : !tower.connected ? 'Connecting to your workspace' : query || filter !== 'all' ? 'No matching agents' : view === 'attention' ? 'You’re all caught up' : 'Your workspace is ready'}</h3>
                  <p>
                    {tower.authError
                      ? 'This page has no access token. Open the link printed by the daemon, or run `npm run open`.'
                      : !tower.connected ? 'Waiting for a connection to the local daemon.' : query || filter !== 'all' ? 'Try another search or choose a different provider.' : view === 'attention' ? 'Agents that need a decision will appear here.' : 'Start a coding session, or launch your first agent here.'}
                  </p>
                  {tower.connected && view === 'fleet' && !query && filter === 'all' && <button className="btn" onClick={() => setShowNew(true)}><Icon name="plus" size={16} />Launch an agent</button>}
                  {(query || filter !== 'all') && <button className="btn" onClick={() => { setQuery(''); setFilter('all'); }}>Clear filters</button>}
                </motion.div>
              )}
            </main>
            </section>
            </>}
            <footer className="dashboard-footer"><span><Icon name="shield" size={14} />Running on your machine</span><span>Waystation</span></footer>
            </div>
            </div>

            <AnimatePresence>
              {selected && (
                <AgentDrawer
                  key={selected.id}
                  agent={selected}
                  agents={tower.agents}
                  hooksInstalled={tower.hooksInstalled}
                  lastEvent={tower.lastEvent}
                  now={now}
                  onClose={() => { setSelectedId(undefined); setPreviewRequest(undefined); }}
                  onSelect={setSelectedId}
                  notify={notify}
                  pending={tower.pending}
                  previewRequest={previewRequest?.id === selected.id ? previewRequest.seq : undefined}
                />
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showNew && (
          <NewAgentDialog defaultCwd={selected?.cwd} onClose={() => setShowNew(false)} onLaunched={setSelectedId} notify={notify} />
        )}
        {showNewTeam && (
          <NewTeamDialog defaultCwd={selected?.cwd} onClose={() => setShowNewTeam(false)} onCreated={(team) => openTeamOnBoard(team.id)} notify={notify} />
        )}
        {showPalette && <CommandPalette key="palette" commands={paletteCommands} onClose={() => setShowPalette(false)} />}
        {hookConfirm && (
          <Confirm
            title={hookConfirm === 'install' ? 'Install tower hooks?' : 'Remove tower hooks?'}
            body={hookConfirm === 'install'
              ? 'Adds Waystation hooks to ~/.claude/settings.json (a backup is saved first). Hooks fail open: if Waystation is not running, Claude Code behaves normally. Already-running sessions may need a restart to pick them up.'
              : 'Removes only the Waystation entries from ~/.claude/settings.json. Other hooks are left untouched.'}
            confirmLabel={hookConfirm === 'install' ? 'Install' : 'Remove'}
            onConfirm={() => void toggleHooks(hookConfirm)}
            onClose={() => setHookConfirm(undefined)}
          />
        )}
      </AnimatePresence>

      <div className="toasts" aria-live="polite">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div key={t.id} className={`toast toast-${t.kind}`} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 40 }}>
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}
