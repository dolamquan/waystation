import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../Icon.tsx';
import type { BoardItem } from './boardItems.ts';
import type { CanvasGroup } from './canvasGroups.ts';
import { toggleId } from './OrchestratorConnectLayer.tsx';
import { addMember, createChannel, listChannels, postMessage, removeMember, type ChannelView } from './channelsApi.ts';
import { statusLabel } from './consoleStatus.ts';
import { tileLabel, type LocalTile } from './canvasTiles.ts';
import {
  MAX_GOAL, buildRoster, connectPlan, describeRecipients, loadOrchestration, missingMembers, orchestratorHubKey, saveOrchestration, scopeRoster,
  type Mode, type OrchestrationState, type RosterAgent, type Target, type Wired,
} from './orchestration.ts';
import { connect, dispatch, type ChannelsClient } from './orchestratorActions.ts';
import './orchestrator.css';

const POLL_MS = 5000;
/** Told to every orchestrator tile in this window when one of them changes the shared leads or briefings. */
const MEMORY_EVENT = 'waystation-orchestration-changed';
const client: ChannelsClient = { list: listChannels, create: createChannel, addMember, removeMember, post: postMessage };

type Notify = (text: string, kind?: 'ok' | 'error') => void;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The recipient select's value: "all", "team:<id>" or "agent:<agent id>". */
function parseTarget(value: string): Target {
  if (value.startsWith('team:')) return { kind: 'team', id: value.slice(5) };
  if (value.startsWith('agent:')) return { kind: 'agent', agentId: value.slice(6) };
  return { kind: 'all' };
}

function AgentRow({ agent, lead, targeted, onMakeLead, onShow, onMessage, onUnwire }: {
  readonly agent: RosterAgent;
  readonly lead?: boolean;
  readonly targeted: boolean;
  /** Only for team members: makes this agent the one that receives the team's goals. */
  readonly onMakeLead?: () => void;
  readonly onShow: () => void;
  readonly onMessage: () => void;
  /** Only for agents wired on their own (not through a team). */
  readonly onUnwire?: () => void;
}) {
  return <li className={targeted ? 'orch-row orch-row-to' : 'orch-row'}>
    <button type="button" className="orch-who" onClick={onShow} title="Show it on the canvas">
      <span className={`console-dot console-dot-${agent.status}`} aria-hidden="true" />
      <span className="orch-name">{agent.name}</span>
      <small>{agent.agentId ? agent.vendor : `${agent.vendor} · connecting…`}</small>
    </button>
    {lead && <span className="orch-lead-badge" title="Gets the team's goals and splits them among its teammates">Lead</span>}
    {!lead && onMakeLead && <button type="button" className="orch-make-lead" onClick={onMakeLead}
      title="Make this agent the team lead: it gets the team's goals and splits them">Make lead</button>}
    <span className={`orch-pill orch-pill-${agent.status}`}>{statusLabel(agent.status)}</span>
    <button type="button" className="orch-icon" onClick={onMessage} disabled={!agent.agentId}
      aria-label={`Message ${agent.name} only`} title={agent.agentId ? `Message ${agent.name} only` : 'Still connecting to this session'}>
      <Icon name="message" size={14} />
    </button>
    {onUnwire && <UnwireButton label={agent.name} onClick={onUnwire} />}
  </li>;
}

function UnwireButton({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return <button type="button" className="orch-icon orch-unwire" onClick={onClick} aria-label={`Disconnect ${label}`} title={`Disconnect ${label} from this orchestrator`}>
    <Icon name="close" size={13} />
  </button>;
}

/** Shown until something is connected: pick agents and teams on the canvas, or launch a new agent for this orchestrator. */
function EmptyWiring({ connecting, onConnect, onSpawn }: { readonly connecting: boolean; readonly onConnect: () => void; readonly onSpawn: () => void }) {
  return <div className="orch-blank">
    <span className="orch-blank-mark" aria-hidden="true"><Icon name="planet" size={26} /></span>
    <span className="orch-eyebrow">{connecting ? 'Connecting' : 'Standby'}</span>
    <strong>No crew aboard yet</strong>
    <p>{connecting ? 'Click agent tiles or team labels on the canvas. Each one you pick joins this orchestrator.'
      : 'Bring in agents and teams already on the canvas, or launch a new agent for this orchestrator.'}</p>
    <div className="orch-choices">
      <button type="button" className={connecting ? 'orch-choice orch-choice-on' : 'orch-choice'} aria-pressed={connecting} onClick={onConnect}>
        <Icon name="link" size={18} /><span>{connecting ? 'Picking on canvas…' : 'Connect'}</span><small>Pick agents and teams on the canvas</small>
      </button>
      <button type="button" className="orch-choice" onClick={onSpawn}>
        <Icon name="terminal" size={18} /><span>Launch agent</span><small>Start a new Claude Code or Codex session</small>
      </button>
    </div>
  </div>;
}

/**
 * An orchestrator tile. It starts blank: Connect wires agents and teams from the canvas (or Spawn adds a fresh one),
 * then one goal goes to the teams and agents it directs. Each team's lead gets the goal and splits it among its
 * teammates (or every agent gets the same words). Teams are linked into channels so leads can hand out work; sending
 * links them first if needed. Several orchestrators can share a canvas, each with its own teams and hub channel.
 */
export function OrchestratorPanel({ tile, items, groups, projectKey, now, notify, onShow, wired, onWiringChange, connecting, onConnect, onSpawn }: {
  readonly tile: LocalTile;
  readonly items: readonly BoardItem[];
  readonly groups: readonly CanvasGroup[];
  readonly projectKey: string;
  readonly now: number;
  readonly notify: Notify;
  /** Brings a tile into view. */
  readonly onShow: (key: string) => void;
  /** The teams and single agents wired to this orchestrator. */
  readonly wired: Wired;
  readonly onWiringChange: (wired: Wired) => void;
  /** This orchestrator is in Connect mode: clicks on the canvas wire agents and teams to it. */
  readonly connecting: boolean;
  readonly onConnect: () => void;
  /** Makes a blank tile beside this orchestrator; the agent started in it is wired here. */
  readonly onSpawn: () => void;
}) {
  const [memory, setMemoryState] = useState<OrchestrationState>(() => loadOrchestration());
  /** Leads and briefings are shared by every orchestrator: change the saved copy, never a stale one held by this tile. */
  const setMemory = useCallback((change: (current: OrchestrationState) => OrchestrationState) => {
    const next = change(loadOrchestration());
    saveOrchestration(next);
    setMemoryState(next);
    window.dispatchEvent(new Event(MEMORY_EVENT));
  }, []);
  useEffect(() => {
    const reload = () => setMemoryState(loadOrchestration());
    window.addEventListener(MEMORY_EVENT, reload);
    window.addEventListener('storage', reload);
    return () => { window.removeEventListener(MEMORY_EVENT, reload); window.removeEventListener('storage', reload); };
  }, []);
  const name = tileLabel(tile);
  const wiredKey = `${wired.teams.join('|')}>${wired.agents.join('|')}`;
  const [channels, setChannels] = useState<readonly ChannelView[]>();
  const [busy, setBusy] = useState<'link' | 'send'>();
  const [draft, setDraft] = useState('');
  const [targetValue, setTargetValue] = useState('all');
  const [mode, setMode] = useState<Mode>('delegate');
  const [result, setResult] = useState<{ readonly text: string; readonly ok: boolean }>();
  const composer = useRef<HTMLTextAreaElement>(null);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const refresh = useCallback(async () => {
    try { setChannels(await listChannels()); } catch { /* the daemon is briefly away; keep the last list */ }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const roster = useMemo(() => scopeRoster(buildRoster(items, groups, memory.leads, now), wired),
    // `wired` is a fresh object each render; its contents are keyed by wiredKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, groups, memory.leads, now, wiredKey]);
  const wiredCount = wired.teams.length + wired.agents.length;
  const unwireTeam = (id: string) => onWiringChange({ ...wired, teams: toggleId(wired.teams, id) });
  const unwireAgent = (key: string) => onWiringChange({ ...wired, agents: toggleId(wired.agents, key) });
  const plan = useMemo(() => connectPlan(roster, orchestratorHubKey(projectKey, tile.id), name), [roster, projectKey, tile.id, name]);
  const everyone = [...roster.teams.flatMap((team) => team.members), ...roster.solos];
  const reachable = plan.teams.length + plan.solos.length;
  const linked = reachable > 0 && channels !== undefined && missingMembers(plan, channels) === 0;
  const parsed = parseTarget(targetValue);
  const stillThere = parsed.kind === 'all'
    || (parsed.kind === 'team' && roster.teams.some((team) => team.id === parsed.id))
    || (parsed.kind === 'agent' && everyone.some((agent) => agent.agentId === parsed.agentId));
  const target: Target = stillThere ? parsed : { kind: 'all' };
  const preview = describeRecipients(plan, target, mode);

  const setLead = (teamId: string, key: string) => setMemory((current) => ({ ...current, leads: { ...current.leads, [teamId]: key } }));
  /** Points the composer at one team or agent, and puts the cursor there. */
  const aimAt = (value: string) => { setTargetValue(value); composer.current?.focus(); };

  const report = (text: string, ok: boolean) => { setResult({ text, ok }); notifyRef.current(text, ok ? 'ok' : 'error'); };

  const link = async () => {
    setBusy('link');
    try {
      const outcome = await connect(plan, client, memory.briefed);
      setMemory((current) => ({ ...current, briefed: outcome.briefed }));
      report(outcome.notes.length > 0 ? `Linked, with problems: ${outcome.notes.join(' ')}` : 'Teams linked. Leads can now hand out work.', outcome.notes.length === 0);
    } catch (error) {
      report(`Could not link the teams: ${messageOf(error)}`, false);
    } finally {
      setBusy(undefined);
      void refresh();
    }
  };

  const send = async () => {
    const goal = draft.trim();
    if (!goal || busy || reachable === 0) return;
    setBusy('send');
    try {
      const outcome = await dispatch({ goal, target, mode, plan, client, briefed: memory.briefed });
      setMemory((current) => ({ ...current, briefed: outcome.briefed }));
      const sent = outcome.sentTo.length > 0 ? `Sent to ${outcome.sentTo.join(', ')}.` : 'Nobody received it.';
      report([sent, ...outcome.notes].join(' '), outcome.sentTo.length > 0 && outcome.notes.length === 0);
      if (outcome.sentTo.length > 0) setDraft('');
    } catch (error) {
      report(`Could not send: ${messageOf(error)}`, false);
    } finally {
      setBusy(undefined);
      void refresh();
    }
  };

  const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const linkState = busy === 'link' ? <span className="orch-state">Linking…</span>
    : linked ? <span className="orch-state orch-state-on" title="Each team has a channel and every lead is in the hub">● Teams linked</span>
    : <>
      <span className="orch-state" title="Sending a goal links them first">Not linked yet</span>
      <button type="button" className="orch-text-btn" onClick={() => void link()} disabled={reachable === 0 || busy !== undefined}
        title="Give each team a channel so its lead can hand out work. Sending a goal does this for you.">Link now</button>
    </>;

  return <section className="orch-panel orch-tile" aria-label={name}>
    <div className="orch-head">
      <span className="orch-eyebrow orch-head-state">{wiredCount === 0 ? 'No crew connected'
        : <>{roster.total} agent{roster.total === 1 ? '' : 's'}{roster.teams.length > 0 ? ` · ${roster.teams.length} team${roster.teams.length === 1 ? '' : 's'}` : ''}
          {' · '}<span className="orch-busy-text" title={`${roster.working} of ${roster.total} agents are working`}>{roster.working} working</span></>}</span>
      <button type="button" className="orch-head-btn" onClick={onSpawn} title="Launch a new agent connected to this orchestrator">
        <Icon name="plus" size={13} />Launch
      </button>
      <button type="button" className={connecting ? 'orch-head-btn orch-head-btn-primary orch-head-btn-on' : 'orch-head-btn orch-head-btn-primary'} aria-pressed={connecting}
        onClick={onConnect} title={connecting ? 'Stop picking (Esc)' : 'Pick agents and teams on the canvas to connect here'}>
        <Icon name={connecting ? 'check' : 'link'} size={13} />{connecting ? 'Done' : 'Connect'}
      </button>
    </div>

    {wiredCount === 0 ? <EmptyWiring connecting={connecting} onConnect={onConnect} onSpawn={onSpawn} /> : <>
      {roster.total > 0 && <div className="orch-summary"><span className="orch-summary-link">{linkState}</span></div>}
      {plan.waiting > 0 && <p className="orch-note">{plan.waiting} new session{plan.waiting === 1 ? ' is' : 's are'} still connecting and will be included in a few seconds.</p>}
      <div className="orch-list">
        {roster.total === 0 && <p className="orch-empty">Nothing connected here is running right now.</p>}
        {roster.teams.map((team) => {
          const busyCount = team.members.filter((agent) => agent.status === 'working').length;
          return <div key={team.id} className="orch-team">
            <div className="orch-section">
              <span className="orch-team-dot" aria-hidden="true" />
              <span className="orch-section-name" title={team.name}>{team.name}</span>
              <span className="orch-section-count">{busyCount}/{team.members.length} working</span>
              <button type="button" className="orch-icon" onClick={() => aimAt(`team:${team.id}`)} aria-label={`Message team ${team.name}`} title={`Message team ${team.name}`}>
                <Icon name="message" size={14} />
              </button>
              <UnwireButton label={`team ${team.name}`} onClick={() => unwireTeam(team.id)} />
            </div>
            <ul className="orch-group" aria-label={`Team ${team.name}`}>
              {team.members.map((agent) => <AgentRow key={agent.key} agent={agent} lead={team.leadKey === agent.key}
                targeted={target.kind === 'agent' && target.agentId === agent.agentId}
                onMakeLead={() => setLead(team.id, agent.key)} onShow={() => onShow(agent.key)} onMessage={() => aimAt(`agent:${agent.agentId}`)} />)}
            </ul>
          </div>;
        })}
        {roster.solos.length > 0 && <div className="orch-team">
          <div className="orch-section">
            <span className="orch-section-name">{roster.teams.length > 0 ? 'Single agents' : 'Agents'}</span>
            <span className="orch-section-count">{roster.solos.length}</span>
          </div>
          <ul className="orch-group" aria-label="Agents wired on their own">
            {roster.solos.map((agent) => <AgentRow key={agent.key} agent={agent} targeted={target.kind === 'agent' && target.agentId === agent.agentId}
              onShow={() => onShow(agent.key)} onMessage={() => aimAt(`agent:${agent.agentId}`)} onUnwire={() => unwireAgent(agent.key)} />)}
          </ul>
        </div>}
      </div>
    </>}

    <div className="orch-compose">
      {reachable > 0 && <label className="orch-to">
        <span>To</span>
        <select value={stillThere ? targetValue : 'all'} onChange={(event) => setTargetValue(event.target.value)}>
          <option value="all">Every team and agent</option>
          {roster.teams.length > 0 && <optgroup label="One team">
            {roster.teams.map((team) => <option key={team.id} value={`team:${team.id}`}>{team.name}</option>)}
          </optgroup>}
          <optgroup label="One agent">
            {everyone.flatMap((agent) => (agent.agentId ? [<option key={agent.key} value={`agent:${agent.agentId}`}>{agent.name}</option>] : []))}
          </optgroup>
        </select>
      </label>}
      {reachable > 0 && target.kind !== 'agent' && <div className="orch-mode" role="radiogroup" aria-label="How the goal is shared">
        <button type="button" role="radio" aria-checked={mode === 'delegate'} className={mode === 'delegate' ? 'orch-mode-on' : ''} onClick={() => setMode('delegate')}
          title="Each team's lead gets the goal and hands out tasks to its teammates">Leads split it</button>
        <button type="button" role="radio" aria-checked={mode === 'everyone'} className={mode === 'everyone' ? 'orch-mode-on' : ''} onClick={() => setMode('everyone')}
          title="Every agent gets the goal word for word">Same to everyone</button>
      </div>}
      <textarea ref={composer} className="orch-textarea" value={draft} rows={2} maxLength={MAX_GOAL} disabled={busy === 'send'}
        onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKey} title="Enter sends · Shift+Enter starts a new line"
        placeholder={reachable > 0 ? 'Give the crew a mission, e.g. build the landing page and write its tests' : 'Connect or launch an agent first'}
        aria-label="Goal (Enter sends, Shift+Enter for a new line)" aria-describedby="orch-preview" />
      <div className="orch-send-row">
        <p id="orch-preview" className="orch-preview" title={preview}>{reachable > 0 ? preview : 'Nobody to send to yet.'}</p>
        <button type="button" className="orch-send" onClick={() => void send()} disabled={!draft.trim() || busy !== undefined || reachable === 0}>
          {busy === 'send' ? 'Sending…' : 'Send'}<Icon name="send" size={14} />
        </button>
      </div>
      {result && <p className={result.ok ? 'orch-result' : 'orch-result orch-result-bad'} role="status">{result.text}</p>}
    </div>
  </section>;
}
