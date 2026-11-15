import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './channelsPanel.css';
import { installSkill, listChannels, skillStatus, type ChannelView, type SkillTargetStatus } from './channelsApi.ts';
import { NewTeamForm } from './NewTeamForm.tsx';
import { TeamDetail } from './TeamDetail.tsx';
import { friendlyError, groupChannels, totalUnread } from './teamLogic.ts';

/** One session that can be put in a channel (a team of agents that message each other). */
export interface ChannelCandidate {
  /** The registry agent id: channels are made of agents, whatever started them. */
  readonly agentId: string;
  readonly label: string;
  /** Where it runs: a console from the board, a Waystation-managed agent, or a session Waystation only observes. */
  readonly origin: 'console' | 'managed' | 'observed';
}

const POLL_MS = 3000;

type View = { readonly kind: 'list' } | { readonly kind: 'new' } | { readonly kind: 'team'; readonly id: string };

/**
 * Teams on the console board: channels where running sessions message each other and work together.
 * Polls while open, because members write to the log on their own.
 */
export function ChannelsPanel({ candidates, notify, onClose }: {
  readonly candidates: readonly ChannelCandidate[];
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
  readonly onClose: () => void;
}) {
  const [channels, setChannels] = useState<readonly ChannelView[]>([]);
  const [targets, setTargets] = useState<readonly SkillTargetStatus[]>([]);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [loaded, setLoaded] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [installing, setInstalling] = useState(false);

  const inFlight = useRef(false);

  // Channels change often and are polled; skill status rarely changes, so it loads on mount and after install only.
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setChannels(await listChannels());
      setProblem(undefined);
    } catch (error) {
      setProblem(friendlyError(error));
    } finally {
      inFlight.current = false;
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    skillStatus().then(setTargets, () => { /* the channel poll surfaces connection problems */ });
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const sorted = useMemo(() => groupChannels(channels), [channels]);
  const originOf = (agentId: string) => candidates.find((c) => c.agentId === agentId)?.origin;
  const open = view.kind === 'team' ? channels.find((c) => c.id === view.id) : undefined;
  const skillMissing = targets.length > 0 && !targets.some((t) => t.installed && t.current);

  const install = async () => {
    setInstalling(true);
    try {
      setTargets(await installSkill());
      notify('Messaging skill installed. Running agents may need a restart to see it.');
    } catch (error) {
      notify(friendlyError(error), 'error');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <aside className="channels-panel" aria-label="Channels">
      <header className="chan-head">
        <h2>Channels</h2>
        {view.kind === 'list' && <button type="button" className="chan-btn chan-btn-primary" onClick={() => setView({ kind: 'new' })}>New channel</button>}
        <button type="button" className="chan-btn" onClick={onClose} aria-label="Close channels">Close</button>
      </header>
      <p className="chan-note">A channel lets running sessions message and wake each other. Each keeps its own conversation.</p>
      {problem && <p className="chan-error" role="alert">{problem}</p>}
      {skillMissing && (
        <div className="chan-skill">
          <span>Agents need the channel skill to message teammates.</span>
          <button type="button" className="chan-btn chan-btn-primary" disabled={installing} onClick={() => void install()}>
            {installing ? 'Installing...' : 'Install skill'}
          </button>
        </div>
      )}

      {view.kind === 'new' && (
        <NewTeamForm candidates={candidates} notify={notify} onCancel={() => setView({ kind: 'list' })}
          onCreated={(id) => { void refresh(); setView({ kind: 'team', id }); }} />
      )}
      {view.kind === 'team' && open && (
        <TeamDetail channel={open} candidates={candidates} targets={targets} notify={notify} refresh={refresh} onBack={() => setView({ kind: 'list' })} />
      )}
      {view.kind === 'team' && !open && loaded && (
        <p className="chan-hint">That channel no longer exists. <button type="button" className="chan-btn" onClick={() => setView({ kind: 'list' })}>Back</button></p>
      )}
      {view.kind === 'list' && (
        <>
          {candidates.length === 0 && <p className="chan-hint">No running sessions yet. Open a terminal or start an agent, then add it to a channel.</p>}
          {loaded && sorted.length === 0 && <p className="chan-hint">No channels yet. Create one to let sessions work together.</p>}
          <ul className="chan-list">
            {sorted.map((c) => (
              <li key={c.id}>
                <button type="button" className="chan-card" onClick={() => setView({ kind: 'team', id: c.id })}>
                  <span className="chan-card-title">#{c.name}{totalUnread(c) > 0 && <span className="chan-unread">{totalUnread(c)}</span>}</span>
                  {c.purpose && <span className="chan-card-purpose">{c.purpose}</span>}
                  <span className="chan-chips">
                    {c.members.length === 0 && <span className="chan-hint">no members</span>}
                    {c.members.map((m) => (
                      <span key={m.name} className={m.status === 'gone' ? 'chan-chip chan-chip-gone' : 'chan-chip'}>
                        <span className={`chan-dot chan-status-${m.status}`} aria-hidden="true" />
                        {m.name}
                        <span className={`chan-origin chan-origin-${originOf(m.agentId) ?? 'observed'}`}>{m.status === 'gone' ? 'offline' : originOf(m.agentId) ?? m.status}</span>
                        <span className="sr-only">{m.status}</span>
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
