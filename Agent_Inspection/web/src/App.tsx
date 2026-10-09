import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, autostart } from './api.ts';
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
import { TeamsView } from './components/TeamsView.tsx';
import { OpsView } from './components/OpsView.tsx';
import { LibraryView } from './components/library/LibraryView.tsx';
import { WorkspaceDoodle, type WorkspaceDoodleKind } from './components/WorkspaceDoodle.tsx';
import { UpdatesBadge } from './components/library/UpdatesBadge.tsx';
import { nestSubagents } from './crew.ts';
import { desktop } from './desktop.ts';
import { DesktopSetup } from './components/DesktopSetup.tsx';

type Toast = { id: number; text: string; kind: 'ok' | 'error' };
type Filter = 'all' | 'claude' | 'codex' | 'other';
type View = 'fleet' | 'attention' | 'teams' | 'ops' | 'library' | 'setup';
const VIEW_TITLE: Record<View, { crumb: string; title: string; subtitle: string }> = {
  fleet: { crumb: 'Overview', title: 'Your workspace', subtitle: 'See and steer every coding agent on this machine — Claude Code, Codex and more — from one place.' },
  attention: { crumb: 'Needs attention', title: 'Needs attention', subtitle: 'Sessions waiting for your input or approval.' },
  teams: { crumb: 'Teams', title: 'Agent teams', subtitle: 'A shared goal, a task board, and room for everyone’s work.' },
  ops: { crumb: 'Usage & schedules', title: 'Usage & schedules', subtitle: 'The numbers so far, and what’s on the calendar.' },
  library: { crumb: 'Library', title: 'The library', subtitle: 'Your shelf of skills, notes and useful tools.' },
  setup: { crumb: 'Desktop setup', title: 'Set up your station', subtitle: 'Connect the tools you use, then make yourself at home.' },
};
const VIEW_DOODLE: Record<View, WorkspaceDoodleKind> = { fleet: 'desk', attention: 'notice', teams: 'team', ops: 'planner', library: 'books', setup: 'desk' };
const TOAST_MS = 4200;
const CLOCK_MS = 5000;

export function App() {
  const [powered, setPowered] = useState(() => Boolean(desktop()) || autostart());
  const tower = useTower(powered);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [hookConfirm, setHookConfirm] = useState<'install' | 'uninstall' | undefined>();
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<View>('fleet');
  const [showNewTeam, setShowNewTeam] = useState(false);
  const [selectedTeamId, setSelectedTeamId] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  const [now, setNow] = useState(Date.now());

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

  const notify = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TOAST_MS);
  }, []);

  const scopedAgents = useMemo(
    () => tower.agents.filter((a) => view === 'fleet' || a.status === 'waiting' || (a.breaker && a.breaker.level !== 'ok') || tower.pending.some((p) => p.agentId === a.id)),
    [tower.agents, tower.pending, view],
  );
  const agents = useMemo(
    () => scopedAgents.filter((a) =>
      (filter === 'all' || a.vendor === filter) &&
      `${a.name} ${a.project} ${a.cwd ?? ''} ${a.currentActivity ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
    ).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : (b.lastEventAt ?? b.startedAt ?? 0) - (a.lastEventAt ?? a.startedAt ?? 0)),
    [scopedAgents, filter, query, sort],
  );
  const selected = tower.agents.find((a) => a.id === selectedId);
  const counts = {
    total: tower.agents.length,
    busy: tower.agents.filter((a) => a.status === 'busy').length,
    waiting: tower.pending.length,
    attention: tower.agents.filter((a) => a.status === 'waiting' || (a.breaker && a.breaker.level !== 'ok') || tower.pending.some((p) => p.agentId === a.id)).length,
    controlled: tower.agents.filter((a) => a.tier === 'A' || (a.tier === 'B' && tower.hooksInstalled)).length,
  };

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

  return (
    <>
      <AnimatePresence mode="wait">
        {!powered ? (
          <PowerOn key="standby" onReady={() => setPowered(true)} />
        ) : (
          <motion.div key="tower" className="tower workbench-content" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}>
            <aside className="sidebar">
              <div className="sidebar-brand"><span className="brand-mark"><Icon name="planet" size={24} /></span><div>Waystation<span>Your agent workspace</span></div></div>
              <div className="workspace-label"><span className="workspace-avatar"><Icon name="terminal" size={17} /></span><div>Local workspace<small>This machine</small></div><span className={`connection-dot ${tower.connected ? 'live' : ''}`} /></div>
              <div className="nav-label">Workspace</div>
              <nav className="sidebar-nav" aria-label="Workspace">
                <button className={view === 'fleet' ? 'nav-active' : ''} aria-current={view === 'fleet' ? 'page' : undefined} onClick={() => { setView('fleet'); setFilter('all'); setQuery(''); }}><Icon name="grid" />Agent overview<span className="nav-count">{counts.total}</span></button>
                <button className={view === 'attention' ? 'nav-active' : ''} aria-current={view === 'attention' ? 'page' : undefined} onClick={() => { setView('attention'); setFilter('all'); setQuery(''); }}><Icon name="alert" />Needs attention<span className={`nav-count ${counts.attention ? 'nav-alert' : ''}`}>{counts.attention}</span></button>
                <button className={view === 'teams' ? 'nav-active' : ''} aria-current={view === 'teams' ? 'page' : undefined} onClick={() => setView('teams')}><Icon name="crew" />Teams<span className="nav-count">{tower.teams.length}</span></button>
                <button className={view === 'ops' ? 'nav-active' : ''} aria-current={view === 'ops' ? 'page' : undefined} onClick={() => setView('ops')}><Icon name="activity" />Usage &amp; schedules</button>
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
                <button
                  className={`btn btn-small ${tower.hooksInstalled ? 'btn-ok' : ''}`}
                  onClick={() => setHookConfirm(tower.hooksInstalled ? 'uninstall' : 'install')}
                  title="Claude Code hooks let the tower intercept and instruct existing sessions"
                >
                  <Icon name="link" size={15} />{tower.hooksInstalled ? 'Hooks connected' : 'Install hooks'}
                </button>
                <button className="icon-btn power-off" onClick={() => { setPowered(false); setSelectedId(undefined); }} aria-label="Power off view" title="Back to standby"><Icon name="power" size={17} /></button>
              </div>
            </header>

            <div className="dashboard-content" data-view={view}>
              <section className="page-heading">
                <div><h1>{VIEW_TITLE[view].title}</h1><p>{VIEW_TITLE[view].subtitle}</p></div>
                <div className="page-heading-tools">
                <WorkspaceDoodle kind={VIEW_DOODLE[view]} />
                {view === 'teams'
                  ? <button className="btn btn-go" onClick={() => setShowNewTeam(true)}><Icon name="plus" size={17} />New team</button>
                  : (view === 'fleet' || view === 'attention') && <button className="btn btn-go" onClick={() => setShowNew(true)}><Icon name="plus" size={17} />New agent</button>}
                </div>
              </section>

              {view === 'teams' && (
                <>
                  <ApprovalPanel pending={tower.pending} agents={tower.agents} notify={notify} />
                  <TeamsView
                    teams={tower.teams}
                    agents={tower.agents}
                    selectedTeamId={selectedTeamId}
                    teamLogFeed={tower.teamLogFeed}
                    now={now}
                    connected={tower.connected}
                    onSelectTeam={setSelectedTeamId}
                    onSelectAgent={setSelectedId}
                    onNewTeam={() => setShowNewTeam(true)}
                    notify={notify}
                  />
                </>
              )}
              {view === 'ops' && <OpsView defaultCwd={selected?.cwd} notify={notify} onNewAgent={() => setShowNew(true)} />}
              {view === 'setup' && <DesktopSetup onDone={() => setView('fleet')} />}
              {view === 'library' && <LibraryView notify={notify} />}
              {(view === 'fleet' || view === 'attention') && <>
              {view === 'fleet' && <AgentWorld agents={tower.agents} teams={tower.teams} onOpenTeam={(teamId) => { setView('teams'); setSelectedTeamId(teamId); }} selectedId={selectedId} connected={tower.connected} authError={tower.authError} onSelect={setSelectedId} onLaunch={() => setShowNew(true)} pending={tower.pending} notify={notify} />}

              {view === 'fleet' && tower.connected && <AwayRecap agents={tower.agents} pending={tower.pending} now={now} onSelect={setSelectedId} />}
              <section className="metric-grid fleet-metrics" aria-label="Fleet summary">
                <div className="metric"><div className="metric-label">Total agents<Icon name="grid" /></div><div className="metric-value">{counts.total.toString().padStart(2, '0')}</div><div className="metric-note">Across your local workspace</div></div>
                <div className="metric"><div className="metric-label">Working now<Icon name="activity" /></div><div className="metric-value">{counts.busy.toString().padStart(2, '0')}<span className="metric-indicator"><span className="connection-dot live" />{counts.busy ? 'Active' : 'Quiet'}</span></div><div className="metric-note">Agents currently on a task</div></div>
                <button className={`metric metric-button ${counts.waiting ? 'metric-attention' : ''}`} onClick={() => { setView('attention'); setFilter('all'); setQuery(''); }}><div className="metric-label">Pending approvals<Icon name="alert" /></div><div className="metric-value">{counts.waiting.toString().padStart(2, '0')}</div><div className="metric-note">{counts.waiting ? 'Tool calls waiting for your review' : 'No tool calls waiting for review'}<Icon name="arrow" size={14} /></div></button>
                <div className="metric"><div className="metric-label">With control<Icon name="shield" /></div><div className="metric-value">{counts.controlled.toString().padStart(2, '0')}</div><div className="metric-note">Managed or connected through hooks</div></div>
              </section>

            <ApprovalPanel pending={tower.pending} agents={tower.agents} notify={notify} />

            <section className="fleet-section" aria-label="Agents">
            <div className="section-heading"><div><h2>{view === 'fleet' ? 'Your agents' : 'Waiting agents'}<span className="section-count">{agents.length}</span></h2><p>Select a session to view its activity and available actions.</p></div><span className="live-label"><span className={`connection-dot ${tower.connected ? 'live' : ''}`} />{tower.connected ? 'Updating live' : tower.authError ? 'Authentication needed' : 'Reconnecting'}</span></div>
            <div className="fleet-toolbar">
            <nav className="filters" aria-label="Filter agents">
              {(['all', 'claude', 'codex', 'other'] as const).map((f) => (
                <button key={f} className={`chip ${filter === f ? 'chip-on' : ''}`} onClick={() => setFilter(f)} aria-pressed={filter === f}>
                  {f === 'all' ? 'All' : f === 'claude' ? 'Claude Code' : f === 'codex' ? 'Codex' : 'Other'}
                  <span className="chip-count">{f === 'all' ? scopedAgents.length : scopedAgents.filter((a) => a.vendor === f).length}</span>
                </button>
              ))}
            </nav>
              <div className="fleet-tools"><label className="search-field"><Icon name="search" size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search agents…" aria-label="Search agents" />{query && <button className="search-clear" onClick={() => setQuery('')} aria-label="Clear search"><Icon name="close" size={13} /></button>}</label><select className="sort-select" value={sort} onChange={(e) => setSort(e.target.value as 'recent' | 'name')} aria-label="Sort agents"><option value="recent">Recent activity</option><option value="name">Name A–Z</option></select><div className="view-toggle" aria-label="Agent layout"><button className={layout === 'grid' ? 'view-active' : ''} aria-label="Grid view" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><Icon name="grid" size={16} /></button><button className={layout === 'list' ? 'view-active' : ''} aria-label="List view" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><Icon name="list" size={17} /></button></div></div>
            </div>

            <main className={`grid ${layout === 'list' ? 'agent-list' : ''}`}>
              <AnimatePresence>
                {nestSubagents(agents).map(({ agent, nested, depth, subagentCount }) => (
                  <AgentCard key={agent.id} agent={agent} nested={nested} depth={depth} parentName={tower.agents.find(parent => parent.id === agent.parentId)?.name} subagentCount={subagentCount} selected={agent.id === selectedId} now={now} onSelect={setSelectedId} />
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
                  onClose={() => setSelectedId(undefined)}
                  onSelect={setSelectedId}
                  notify={notify}
                  pending={tower.pending}
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
          <NewTeamDialog defaultCwd={selected?.cwd} onClose={() => setShowNewTeam(false)} onCreated={(team) => { setView('teams'); setSelectedTeamId(team.id); }} notify={notify} />
        )}
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
