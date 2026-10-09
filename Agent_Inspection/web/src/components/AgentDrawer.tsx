import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, request, type Agent, type AgentEvent, type PendingInterception, type SkillSummary } from '../api.ts';
import type { ContextDoc } from '../library/loadoutApi.ts';
import { currentActivity, filterActivity, mergeActivity, readableTime, sessionSource, type ActivityFilter } from '../activity.ts';
import { STATUS_LABEL, VENDOR_LABEL } from '../format.ts';
import { ActivityFeed } from './ActivityFeed.tsx';
import { AgentManage } from './AgentManage.tsx';
import { AgentRelationships } from './AgentRelationships.tsx';
import { CrewAvatar } from './CrewAvatar.tsx';
import { DocPicker } from './DocPicker.tsx';
import { Confirm } from './Modal.tsx';
import { SkillPicker } from './SkillPicker.tsx';
import { Icon } from './Icon.tsx';
import { AgentOutputs } from './AgentOutputs.tsx';
import { MessageComposer } from '../composer/MessageComposer.tsx';
import { availableCommands, type WaystationCommand } from '../composer/commands.ts';
import type { CommandResult } from '../../../shared/claudeCommands.ts';
import { cliUnavailableReason, useToolAvailability } from '../useToolAvailability.ts';

interface AgentDrawerProps {
  readonly agent: Agent;
  readonly agents?: readonly Agent[];
  readonly hooksInstalled: boolean;
  readonly lastEvent?: AgentEvent;
  readonly now: number;
  readonly onClose: () => void;
  readonly onSelect: (id: string) => void;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
  /** Held tool calls across all agents; the composer answers this agent's oldest one. */
  readonly pending?: readonly PendingInterception[];
}

type Tab = 'overview' | 'activity' | 'outputs' | 'details';
type Composer = 'message' | 'followup' | 'skills' | 'docs' | undefined;
type Pending = { title: string; body: string; label: string; danger?: boolean; action: () => Promise<void> };
type NumberedEvent = AgentEvent & { readonly seq: number };
let nextSeq = 0;
const numbered = (event: AgentEvent): NumberedEvent => ({ ...event, seq: nextSeq++ });
const TABS: readonly Tab[] = ['overview', 'activity', 'outputs', 'details'];

export function AgentDrawer({ agent, agents = [], hooksInstalled, lastEvent, now, onClose, onSelect, notify, pending = [] }: AgentDrawerProps) {
  const cliMissing = cliUnavailableReason(useToolAvailability(), agent.vendor);
  const uid = useId();
  const scrollArea = useRef<HTMLDivElement>(null);
  const [events, setEvents] = useState<NumberedEvent[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [composer, setComposer] = useState<Composer>();
  const [message, setMessage] = useState('');
  const [task, setTask] = useState('');
  const [stopOriginal, setStopOriginal] = useState(false);
  const [confirm, setConfirm] = useState<Pending>();
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<ActivityFilter>('messages');
  const [search, setSearch] = useState('');

  useEffect(() => { scrollArea.current?.scrollTo({ top: 0 }); }, [tab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setLoadError(undefined);
    api.events(agent.id).then(
      (result) => {
        if (ignore) return;
        setEvents(previous => mergeActivity(previous, result.events.map(numbered)));
        setLoading(false);
      },
      (error: Error) => {
        if (ignore) return;
        setLoadError(error.message);
        setLoading(false);
      },
    );
    return () => { ignore = true; };
  }, [agent.id, refresh]);

  useEffect(() => {
    if (lastEvent?.agentId === agent.id) setEvents(previous => mergeActivity(previous, [numbered(lastEvent)]));
  }, [lastEvent, agent.id]);

  const run = async (action: string, fn: () => Promise<unknown>, ok: string) => {
    if (busy) return false;
    setBusy(action);
    setActionError(undefined);
    try {
      const result = await fn();
      notify((result as { message?: string } | undefined)?.message ?? ok);
      return true;
    } catch (error) {
      const text = (error as Error).message;
      setActionError(text);
      notify(text, 'error');
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const isClaude = agent.vendor === 'claude';
  const ended = agent.status === 'stopped';
  const canIntercept = !ended && isClaude && (agent.tier === 'A' || (agent.tier === 'B' && hooksInstalled));
  const canMessage = agent.canInstruct && !ended;
  const stopReason = agent.stopBlockedReason ?? (ended ? 'This session has already ended.' : undefined);
  const messages = useMemo(() => filterActivity(events, 'messages'), [events]);
  const visibleEvents = useMemo(() => filterActivity(events, filter).filter(event =>
    event.summary.toLowerCase().includes(search.trim().toLowerCase()),
  ), [events, filter, search]);
  const newest = events[events.length - 1];

  const openComposer = (next: Composer) => {
    setTab('overview');
    setComposer(composer === next ? undefined : next);
    setActionError(undefined);
  };

  const pickSkill = (skill: SkillSummary) => setConfirm({
    title: `Add ${skill.name} to this project?`,
    body: `This adds the skill to ${agent.project || 'this project'} for Claude agents to use.${agent.canInstruct ? ' This agent will also receive an instruction to read it.' : ''}`,
    label: 'Add skill',
    action: async () => {
      if (await run('skill', () => api.attachSkill(agent.id, skill.id), `Added ${skill.name}`)) setComposer(undefined);
    },
  });

  const pickDoc = (doc: ContextDoc) => setConfirm({
    title: `Send ${doc.title} to ${agent.name}?`,
    body: 'The agent is told to read this context doc before it carries on with its task.',
    label: 'Send doc',
    action: async () => {
      const sent = await run('doc', () => request<{ ok: true }>('POST', `/api/agents/${encodeURIComponent(agent.id)}/docs`, { docId: doc.id }), `Sent ${doc.title}`);
      if (sent) setComposer(undefined);
    },
  });

  const cliName = agent.vendor === 'codex' ? 'Codex' : 'Claude Code';
  // Agents launched here move into the CLI; sessions running elsewhere (your own) open as a copy.
  const handsOff = agent.tier === 'A';
  const canOpenInCli = !ended && !agent.inTerminal && !!agent.sessionId && agent.vendor !== 'other' && (handsOff || !!agent.cwd);
  const confirmCli = () => setConfirm(handsOff ? {
    title: `Continue in ${cliName}?`,
    body: `Waystation stops its copy of this agent and opens the same conversation in ${cliName} in a new terminal tab, where you use it like any ${cliName} session (/usage, /model and so on). The agent must be idle. Team members rejoin their team when you close that session.`,
    label: `Open in ${cliName}`,
    action: async () => { if (await run('cli', () => api.openCli(agent.id), `Opened in ${cliName}`)) onClose(); },
  } : {
    title: `Open in ${cliName}?`,
    body: `Opens this conversation in ${cliName} in a new terminal tab, where you use it like any ${cliName} session (/usage, /model and so on). This session keeps running where it is, so the new tab is a copy: from here on the two are separate.`,
    label: `Open in ${cliName}`,
    action: async () => { await run('cli', () => api.openCli(agent.id), `Opened in ${cliName}`); },
  });

  const confirmStop = () => setConfirm({
    title: `Stop ${agent.name}?`,
    body: agent.inTerminal ? `This closes its ${cliName} session in your terminal and ends the agent. It won't come back to Waystation.`
      : agent.tier === 'A' ? 'This ends the managed agent session and cancels its current task.' : 'This ends the agent process and its child processes. Any unsaved work in that session will be lost.',
    label: 'Stop agent',
    danger: true,
    action: async () => { await run('stop', () => api.stop(agent.id), 'Agent stopped'); },
  });

  const held = pending.filter(item => item.agentId === agent.id).sort((a, b) => a.createdAt - b.createdAt)[0];
  const composerCommandList = availableCommands({ agent, hasPending: !!held, canIntercept, canOpenCli: canOpenInCli });

  /** Slash commands typed in the composer; returns whether the input can be cleared. */
  const runCommand = async (name: WaystationCommand, arg: string): Promise<boolean> => {
    switch (name) {
      case 'help': return true;
      case 'approve': return held ? run('decide', () => api.decide(held.id, { behavior: 'allow' }), 'Approved') : false;
      case 'deny': return held ? run('decide', () => api.decide(held.id, { behavior: 'deny', message: arg || 'Denied by the operator.' }), 'Denied') : false;
      case 'ask': return held ? run('decide', () => api.decide(held.id, { behavior: 'ask' }), 'Handed back to Claude Code’s prompt') : false;
      case 'interrupt': return run('interrupt', () => api.interrupt(agent.id), 'Interrupted');
      case 'intercept': return run('intercept', () => api.intercept(agent.id, arg === 'on'), arg === 'on' ? 'Intercept on' : 'Intercept off');
      case 'rename': return run('rename', () => api.rename(agent.id, arg), `Renamed to ${arg}`);
      case 'delegate': return run('delegate', () => api.delegate(agent.id, arg, false), 'Delegated to a new agent');
      case 'clear-guard': return run('guard', () => api.resetBreaker(agent.id), 'Runaway guard cleared');
      case 'stop': confirmStop(); return true;
      case 'cli': confirmCli(); return true;
    }
  };

  /** Claude Code commands Waystation answers itself (/usage, /mcp, /model…). */
  const runNative = async (name: string, arg: string): Promise<CommandResult | undefined> => {
    setActionError(undefined);
    try {
      const { result } = await api.command(agent.id, name, arg);
      if (result.done) notify(result.done);
      return result;
    } catch (error) {
      notify((error as Error).message, 'error');
      return undefined;
    }
  };

  const selectTabWithKeyboard = (e: React.KeyboardEvent<HTMLButtonElement>, current: Tab) => {
    const index = TABS.indexOf(current);
    const next = e.key === 'ArrowRight' ? TABS[(index + 1) % TABS.length]
      : e.key === 'ArrowLeft' ? TABS[(index + TABS.length - 1) % TABS.length]
      : e.key === 'Home' ? TABS[0] : e.key === 'End' ? TABS[TABS.length - 1] : undefined;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    document.getElementById(`${uid}-${next}`)?.focus();
  };

  return (
    <motion.aside className="drawer agent-details" initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
      transition={{ type: 'spring', stiffness: 300, damping: 34 }} aria-label={`Details for ${agent.name}`}>
      <header className="agent-detail-header">
        <div className="detail-header-top"><span>Agent details</span><button className="icon-btn" onClick={onClose} aria-label="Close details"><Icon name="close" size={18} /></button></div>
        <div className="detail-identity">
          <span className="detail-avatar"><CrewAvatar id={agent.id} status={agent.status} size={48} animated={false} /></span>
          <div><h2>{agent.name}</h2><p>{VENDOR_LABEL[agent.vendor]}<span>·</span>{sessionSource(agent)}</p></div>
        </div>
        <div className="detail-status"><span className={`status-pill pill-${agent.inTerminal ? 'waiting' : agent.status}`}>{agent.inTerminal ? 'In your terminal' : STATUS_LABEL[agent.status]}</span><span className="detail-access-label"><Icon name={agent.tier === 'C' ? 'info' : 'shield'} size={14} />{agent.tier === 'A' ? 'Managed session' : agent.tier === 'B' && hooksInstalled ? 'Hooks connected' : 'Activity only'}</span></div>
      </header>

      <nav className="detail-tabs" role="tablist" aria-label="Agent sections">
        {TABS.map(item => <button key={item} role="tab" id={`${uid}-${item}`} aria-selected={tab === item} aria-controls={`${uid}-panel`} tabIndex={tab === item ? 0 : -1} onClick={() => setTab(item)} onKeyDown={e => selectTabWithKeyboard(e, item)}>{item === 'overview' ? 'Overview' : item === 'activity' ? 'Activity' : item === 'outputs' ? 'Outputs' : 'Details'}</button>)}
      </nav>

      <div ref={scrollArea} className="detail-scroll" role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-${tab}`} tabIndex={0}>
        {tab === 'overview' && <div className="detail-overview">
          <div className="detail-project"><Icon name="folder" size={17} /><div><span>Project</span><strong>{agent.project || 'Unknown project'}</strong></div><span className="detail-last-seen">{readableTime(agent.lastEventAt ?? agent.startedAt, now)}</span></div>
          <div className={`detail-now detail-now-${agent.status}`}><span className="detail-section-label">{ended ? 'Session ended' : 'Right now'}</span><p>{currentActivity(agent, newest)}</p></div>
          <AgentRelationships agent={agent} agents={agents} onSelect={onSelect} />
          <AgentManage agent={agent} notify={notify} />
          {agent.inTerminal && <div className="detail-access-note"><Icon name="terminal" size={18} /><div><strong>Open in your terminal</strong><p>Work with it there in {cliName}. When you close that terminal, it comes back here and waits for instructions. Only Stop ends it.</p></div></div>}

          {!canMessage && !ended && <div className="detail-access-note"><Icon name="info" size={18} /><div><strong>{agent.tier === 'B' && !hooksInstalled ? 'Connect this Claude Code session' : 'This session runs outside Waystation'}</strong><p>{agent.tier === 'B' && !hooksInstalled ? 'Install hooks from the top bar to send messages and review tool calls.' : 'You can follow its activity here. To send a message, use the app where you started it.'}</p><button onClick={() => setTab('activity')}>View activity<Icon name="arrow" size={13} /></button></div></div>}

          {canMessage && composer !== 'followup' && composer !== 'skills' && composer !== 'docs' && <MessageComposer
            commands={composerCommandList}
            hint={agent.tier === 'B' ? 'Delivered after the next tool call.' : isClaude ? 'Sent to this running session.' : 'Delivered between turns.'}
            busy={!!busy}
            onSend={text => run('message', () => api.instruct(agent.id, text), 'Message sent')}
            onRun={runCommand}
            onNative={runNative}
            onOpenCli={canOpenInCli ? confirmCli : undefined} />}

          {(canOpenInCli || agent.cwd || canMessage) && <div className="detail-action-list">
            {canOpenInCli && <button className="detail-action" onClick={confirmCli} disabled={!!busy || !!cliMissing}><span className="detail-action-icon"><Icon name="terminal" size={19} /></span><span><strong>{busy === 'cli' ? 'Opening…' : handsOff ? `Continue in ${cliName}` : `Open in ${cliName}`}</strong><small>{cliMissing ?? (handsOff ? `Move this session into the real ${cliName} CLI, with /usage, /model and everything else.` : `Open this conversation in the real ${cliName} CLI, as a copy. This session keeps running.`)}</small></span><Icon name="chevronRight" size={16} /></button>}
            {agent.cwd && <button className={`detail-action ${composer === 'followup' ? 'detail-action-selected' : ''}`} onClick={() => openComposer('followup')} aria-expanded={composer === 'followup'} disabled={!!busy}><span className="detail-action-icon"><Icon name="plus" size={19} /></span><span><strong>Start a follow-up</strong><small>Create another agent for a new task in this project.</small></span><Icon name="chevronRight" size={16} /></button>}
            {agent.cwd && <button className={`detail-action ${composer === 'skills' ? 'detail-action-selected' : ''}`} onClick={() => openComposer('skills')} aria-expanded={composer === 'skills'} disabled={!!busy}><span className="detail-action-icon"><Icon name="book" size={19} /></span><span><strong>Project skills</strong><small>Add reusable instructions for Claude agents.</small></span><Icon name="chevronRight" size={16} /></button>}
            {canMessage && <button className={`detail-action ${composer === 'docs' ? 'detail-action-selected' : ''}`} onClick={() => openComposer('docs')} aria-expanded={composer === 'docs'} disabled={!!busy}><span className="detail-action-icon"><Icon name="list" size={19} /></span><span><strong>Send a context doc</strong><small>Give this agent a Library .md file to read before it continues.</small></span><Icon name="chevronRight" size={16} /></button>}
          </div>}

          {composer === 'followup' && <form className="detail-followup" onSubmit={e => {
            e.preventDefault();
            void run('followup', async () => {
              const result = await api.delegate(agent.id, task.trim(), stopOriginal);
              onSelect(result.agent.id);
              return { message: result.warning ? `Agent created. ${result.warning}` : 'Follow-up agent created' };
            }, 'Follow-up agent created');
          }}>
            <div className="detail-form-heading"><h3>New task</h3><button className="icon-btn" type="button" onClick={() => setComposer(undefined)} aria-label="Cancel follow-up"><Icon name="close" size={15} /></button></div>
            <p>{isClaude && agent.sessionId ? 'A new Claude agent will continue with this session’s context.' : 'A new Claude agent will start here with a summary of this session’s recent activity.'}</p>
            <label htmlFor={`${uid}-task`}>What should it work on?</label><textarea id={`${uid}-task`} className="text-input" rows={4} value={task} onChange={e => setTask(e.target.value)} placeholder="Describe the new task" autoFocus required disabled={!!busy} />
            {!stopReason && <label className="check"><input type="checkbox" checked={stopOriginal} onChange={e => setStopOriginal(e.target.checked)} disabled={!!busy} />Stop this agent once the new one starts</label>}
            <div className="detail-form-actions"><button type="button" className="btn btn-ghost" onClick={() => setComposer(undefined)} disabled={!!busy}>Cancel</button><button type="submit" className="btn btn-go" disabled={!!busy || !task.trim()}>{busy === 'followup' ? 'Creating…' : 'Create agent'}</button></div>
          </form>}

          {composer === 'skills' && <section className="detail-skill-panel"><div className="detail-form-heading"><h3>Choose a skill</h3><button className="icon-btn" onClick={() => setComposer(undefined)} aria-label="Close skills"><Icon name="close" size={15} /></button></div><p>Skills are saved to this project’s Claude skills folder.</p><SkillPicker onPick={pickSkill} /></section>}

          {composer === 'docs' && <section className="detail-skill-panel"><div className="detail-form-heading"><h3>Choose a context doc</h3><button className="icon-btn" onClick={() => setComposer(undefined)} aria-label="Close context docs"><Icon name="close" size={15} /></button></div><p>The agent reads it before it carries on. Manage docs in the Library.</p><DocPicker onPick={pickDoc} /></section>}

          {actionError && <p className="detail-action-error" role="alert">{actionError}</p>}

          {canIntercept && <section className="detail-review"><div><strong>Review tool calls</strong><p>{agent.intercepting ? 'Tool calls wait for your approval before running.' : 'Pause tool calls when they need your approval.'}</p></div><button className="detail-switch" role="switch" aria-label="Review tool calls" aria-checked={agent.intercepting} disabled={!!busy} onClick={() => void run('review', () => api.intercept(agent.id, !agent.intercepting), agent.intercepting ? 'Tool review off' : 'Tool review on')}><span /></button></section>}

          <section className="detail-recent"><div className="detail-section-heading"><h3>Recent conversation</h3><button onClick={() => { setFilter('messages'); setTab('activity'); }}>View all<Icon name="arrow" size={14} /></button></div>
            {loading && !messages.length ? <p className="detail-empty-text">Loading activity…</p> : messages.length ? <ActivityFeed events={messages.slice(-3)} now={now} /> : <p className="detail-empty-text">{loadError ? 'Activity couldn’t be loaded. Open Activity to try again.' : 'Messages from this session will appear here.'}</p>}
          </section>

          {(agent.tier === 'A' || !stopReason) && !ended && <details className="detail-session-controls"><summary>Session controls<Icon name="chevronDown" size={15} /></summary><p>Interrupt a task or end the session.</p><div>{agent.tier === 'A' && !agent.inTerminal && <button className="btn" onClick={() => void run('interrupt', () => api.interrupt(agent.id), 'Task interrupted')} disabled={!!busy}>{busy === 'interrupt' ? 'Interrupting…' : 'Interrupt task'}</button>}{!stopReason && <button className="btn btn-danger" onClick={confirmStop} disabled={!!busy}>Stop agent</button>}</div></details>}
        </div>}

        {tab === 'activity' && <section className="detail-activity">
          <div className="detail-section-heading"><div><h3>Activity</h3><p>Messages and recorded tool calls from this session.</p></div><button className="icon-btn" aria-label="Refresh activity" title="Refresh activity" onClick={() => setRefresh(x => x + 1)} disabled={loading}><Icon name="refresh" size={16} /></button></div>
          <div className="detail-activity-filters" aria-label="Activity type">{(['messages', 'tools', 'all'] as const).map(item => <button key={item} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item === 'messages' ? 'Messages' : item === 'tools' ? 'Tool calls' : 'Everything'}</button>)}</div>
          <label className="detail-activity-search"><Icon name="search" size={16} /><input aria-label="Search activity" placeholder="Search this session" value={search} onChange={e => setSearch(e.target.value)} />{search && <button aria-label="Clear activity search" onClick={() => setSearch('')}><Icon name="close" size={14} /></button>}</label>
          {loadError && <div className="detail-load-error" role="alert"><p>Couldn’t load activity. {loadError}</p><button className="btn" onClick={() => setRefresh(x => x + 1)} disabled={loading}>Try again</button></div>}
          {loading && !events.length ? <p className="detail-empty-text">Loading activity…</p> : visibleEvents.length ? <ActivityFeed events={visibleEvents} now={now} /> : !loadError && <div className="detail-feed-empty"><Icon name={search ? 'search' : 'message'} size={25} /><h4>{search ? 'No matches in this session' : filter === 'tools' ? 'No tool calls recorded yet' : 'No messages recorded yet'}</h4><p>{search ? 'Try a different word, or clear the search.' : 'New activity will appear here as it happens.'}</p>{search && <button className="btn" onClick={() => setSearch('')}>Clear search</button>}</div>}
        </section>}

        {tab === 'outputs' && <AgentOutputs agent={agent} now={now} />}

        {tab === 'details' && <section className="detail-information">
          <div className="detail-section-heading"><div><h3>About this session</h3><p>Where it’s running and what Waystation can do.</p></div></div>
          <dl className="detail-facts"><div><dt>Provider</dt><dd>{VENDOR_LABEL[agent.vendor]}</dd></div><div><dt>Connection</dt><dd>{sessionSource(agent)}</dd></div><div><dt>Started</dt><dd>{readableTime(agent.startedAt, now)}</dd></div><div><dt>Last activity</dt><dd>{readableTime(agent.lastEventAt, now)}</dd></div>{agent.pid && <div><dt>Process ID</dt><dd>{agent.pid}</dd></div>}</dl>
          <section className="detail-folder"><div className="detail-section-heading"><h3>Project folder</h3>{agent.cwd && <button onClick={() => {
            if (!navigator.clipboard) { notify('Clipboard access is unavailable in this browser.', 'error'); return; }
            void navigator.clipboard.writeText(agent.cwd!).then(() => notify('Folder path copied'), () => notify('Could not copy the path. You can select it below.', 'error'));
          }}><Icon name="copy" size={14} />Copy path</button>}</div><p>{agent.cwd ?? 'No project folder was recorded for this session.'}</p></section>
          <section className="detail-capabilities"><h3>Available here</h3><ul><li><Icon name="check" size={16} /><span>View recorded activity</span></li>{agent.cwd && <><li><Icon name="check" size={16} /><span>Create a follow-up agent</span></li><li><Icon name="check" size={16} /><span>Add Claude project skills</span></li></>}{canMessage && <><li><Icon name="check" size={16} /><span>Send messages</span></li><li><Icon name="check" size={16} /><span>Send context docs</span></li></>}{canIntercept && <li><Icon name="check" size={16} /><span>Review tool calls</span></li>}{!stopReason && <li><Icon name="check" size={16} /><span>Stop this agent</span></li>}</ul></section>
          {stopReason && <div className="detail-stop-note"><Icon name="info" size={18} /><div><strong>{ended ? 'Session ended' : 'Stopping this session'}</strong><p>{stopReason}</p></div></div>}
          <details className="detail-technical"><summary>Technical details<Icon name="chevronDown" size={15} /></summary><dl><dt>Session ID</dt><dd>{agent.sessionId ?? agent.id}</dd><dt>Source</dt><dd>{agent.source}</dd></dl></details>
        </section>}
      </div>

      <footer className="detail-footer"><span className={`connection-dot ${!ended ? 'live' : ''}`} /><span>{ended ? 'Session ended' : 'Activity updates automatically'}</span><span>{VENDOR_LABEL[agent.vendor]}</span></footer>
      <AnimatePresence>{confirm && <Confirm title={confirm.title} body={confirm.body} confirmLabel={confirm.label} danger={confirm.danger} onConfirm={() => void confirm.action()} onClose={() => setConfirm(undefined)} />}</AnimatePresence>
    </motion.aside>
  );
}
