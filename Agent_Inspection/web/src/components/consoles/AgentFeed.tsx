import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, type Agent, type AgentEvent } from '../../api.ts';
import { mergeFeedEvents, toFeedLines } from './agentFeedLines.ts';
import { commandQuery, matchCommands, parseComposer } from '../../composer/commands.ts';
import { completeCommand, resultLines, tileCommands } from './tileCommands.ts';
import './agentFeed.css';

type Phase = 'loading' | 'ready' | 'error';

/** Within this many pixels of the bottom still counts as "following" (sub-pixel and rounding slack). */
const FOLLOW_SLACK_PX = 24;
const OBSERVED_HINT = 'Observed session: Waystation can watch it but not type into it. Use Open as terminal to continue a copy.';
const MAX_NOTES = 200;
const MAX_SUGGESTIONS = 6;

/** Last fetched events per agent, so a layout switch (remount) paints instantly. Bounded: oldest entries go first. */
const MAX_CACHED_FEEDS = 40;
const feedCache = new Map<string, readonly AgentEvent[]>();
function cacheFeed(agentId: string, events: readonly AgentEvent[]): void {
  feedCache.delete(agentId);
  feedCache.set(agentId, events);
  while (feedCache.size > MAX_CACHED_FEEDS) {
    const oldest = feedCache.keys().next().value;
    if (oldest === undefined) break;
    feedCache.delete(oldest);
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Defers the feed (and its events fetch) until the tile is on screen: with the "All" filter every observed agent
 * has a tile, and fetching thousands of events for each at once is wasteful. Without IntersectionObserver the
 * feed is simply shown.
 */
export function AgentFeed(props: {
  readonly agent: Agent;
  readonly lastEvent: AgentEvent | undefined;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const node = holder.current;
    if (visible || !node) return undefined;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  if (!visible) return <div ref={holder} className="agent-feed"><p className="agent-feed-note">Activity loads when this tile is in view.</p></div>;
  return <AgentFeedLive {...props} />;
}

/**
 * Terminal-style live view of an agent that has no pseudo-terminal of its own: a session Waystation runs through
 * an SDK ("New agent"), or one it only observes. The board puts it where a console's TerminalPane would go.
 * Cost is kept low: one fetch on mount, then events arrive through `lastEvent`; one refetch when a turn ends
 * (busy -> idle) heals anything missed.
 */
function AgentFeedLive({ agent, lastEvent, notify }: {
  readonly agent: Agent;
  /** The newest event the tower streamed, for any agent; the feed keeps only its own agent's. */
  readonly lastEvent: AgentEvent | undefined;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
}) {
  const [events, setEvents] = useState<readonly AgentEvent[]>(() => feedCache.get(agent.id) ?? []);
  const [phase, setPhase] = useState<Phase>(() => (feedCache.has(agent.id) ? 'ready' : 'loading'));
  const [following, setFollowing] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const previousStatus = useRef(agent.status);
  const agentId = agent.id;
  // Callers often pass a fresh closure each render; a ref keeps that from re-running the fetch effect.
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const load = useCallback((showLoading: boolean) => {
    let cancelled = false;
    if (showLoading) setPhase('loading');
    api.events(agentId).then(
      ({ events: history }) => {
        if (cancelled) return;
        setEvents(current => {
          const merged = mergeFeedEvents(current, history, agentId);
          cacheFeed(agentId, merged);
          return merged;
        });
        setPhase('ready');
      },
      (error: unknown) => {
        if (cancelled) return;
        // A failed background refetch must not blank a feed that already has content.
        setPhase(current => (showLoading || current === 'loading' ? 'error' : current));
        if (!showLoading) notifyRef.current(`Could not refresh activity: ${messageOf(error)}`, 'error');
      },
    );
    return () => { cancelled = true; };
  }, [agentId]);

  useEffect(() => {
    setEvents(feedCache.get(agentId) ?? []);
    return load(!feedCache.has(agentId));
  }, [load]);

  useEffect(() => {
    if (lastEvent && lastEvent.agentId === agentId) setEvents(current => mergeFeedEvents(current, [lastEvent], agentId));
  }, [lastEvent, agentId]);

  useEffect(() => {
    const wasBusy = previousStatus.current === 'busy';
    previousStatus.current = agent.status;
    if (wasBusy && agent.status === 'idle') return load(false);
    return undefined;
  }, [agent.status, load]);

  const lines = useMemo(() => toFeedLines(events), [events]);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (log && followingRef.current) log.scrollTop = log.scrollHeight;
  }, [lines, phase]);

  const handleScroll = () => {
    const log = logRef.current;
    if (!log) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight <= FOLLOW_SLACK_PX;
    followingRef.current = atBottom;
    setFollowing(atBottom);
  };

  const jumpToLatest = () => {
    const log = logRef.current;
    followingRef.current = true;
    setFollowing(true);
    if (log) log.scrollTop = log.scrollHeight;
  };

  const commands = useMemo(() => tileCommands(agent), [agent]);
  /** Answers to slash commands, printed under the feed like a terminal would (local to this tile). */
  const [notes, setNotes] = useState<readonly { readonly id: number; readonly text: string }[]>([]);
  const noteId = useRef(0);
  const print = (texts: readonly string[]) => {
    setNotes(current => [...current, ...texts.map(text => ({ id: ++noteId.current, text }))].slice(-MAX_NOTES));
    jumpToLatest();
  };

  /** One slash command or message; resolves to whether the input can be cleared. */
  const submit = async (raw: string): Promise<boolean> => {
    const action = parseComposer(raw, commands);
    switch (action.kind) {
      case 'none': return false;
      case 'error': case 'unavailable': print([action.message]); return false;
      case 'native': {
        const { result } = await api.command(agentId, action.name, action.arg);
        if (result.done) notifyRef.current(result.done);
        print(resultLines(raw.trim(), result));
        return true;
      }
      case 'run': return runControl(action.name, action.arg);
      case 'send':
        if (!agent.canInstruct) { print([OBSERVED_HINT]); return false; }
        notifyRef.current((await api.instruct(agentId, action.text)).message);
        jumpToLatest();
        return true;
    }
  };
  const runControl = async (name: string, arg: string): Promise<boolean> => {
    switch (name) {
      case 'help': print(['Commands here:', ...commands.map(command => `  /${command.name}${command.args ? ` ${command.args}` : ''}  ${command.description}`)]); return true;
      case 'interrupt': await api.interrupt(agentId); print(['Interrupted.']); return true;
      case 'rename': await api.rename(agentId, arg); print([`Renamed to ${arg}.`]); return true;
      case 'delegate': await api.delegate(agentId, arg, false); print(['Delegated to a new agent.']); return true;
      case 'clear-guard': await api.resetBreaker(agentId); print(['Runaway guard cleared.']); return true;
      default: print([`/${name} is in Details.`]); return false;
    }
  };

  const send = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      if (await submit(draft)) setDraft('');
    } catch (error) {
      notifyRef.current(`Could not send to ${agent.name}: ${messageOf(error)}`, 'error');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Tab' && commandQuery(draft) !== undefined) {
      event.preventDefault();
      setDraft(completeCommand(draft, commands));
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  const query = commandQuery(draft);
  const suggestions = query === undefined ? [] : matchCommands(query, commands).slice(0, MAX_SUGGESTIONS);
  const hasInput = agent.canInstruct || commands.some(command => command.kind === 'native');

  const activity = agent.currentActivity ?? '';
  return (
    <div className="agent-feed">
      <div
        ref={logRef}
        className="agent-feed-log"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={`Activity: ${agent.name}`}
        tabIndex={0}
        onScroll={handleScroll}
      >
        {phase === 'loading' && lines.length === 0 && <p className="agent-feed-note">Loading activity…</p>}
        {phase === 'error' && lines.length === 0 && (
          <div className="agent-feed-note" role="alert">
            <span>Could not load this agent’s activity.</span>
            <button type="button" className="btn btn-ghost" onClick={() => load(true)}>Retry</button>
          </div>
        )}
        {phase === 'ready' && lines.length === 0 && <p className="agent-feed-note">No activity yet.</p>}
        {lines.map(line => <p key={line.id} className={`agent-feed-line agent-feed-${line.tone}`}>{line.text}</p>)}
        {notes.map(note => <p key={`note-${note.id}`} className="agent-feed-line agent-feed-command">{note.text}</p>)}
      </div>
      {!following && <button type="button" className="agent-feed-jump" onClick={jumpToLatest}>Jump to latest ↓</button>}
      <div className="agent-feed-status-line">
        <span>{agent.status}</span>
        {agent.model && <span>{agent.model}</span>}
        {activity && <span className="agent-feed-activity" title={activity}>{activity}</span>}
      </div>
      {suggestions.length > 0 && (
        <ul className="agent-feed-suggest" aria-label="Matching commands">
          {suggestions.map(command => <li key={command.name} className={command.kind === 'unavailable' ? 'agent-feed-suggest-off' : undefined}>
            <button type="button" onClick={() => setDraft(`/${command.name} `)}>/{command.name}</button>
            <span>{command.kind === 'unavailable' ? command.reason : command.description}</span>
          </li>)}
        </ul>
      )}
      {hasInput ? (
        <div className="agent-feed-input">
          <input
            type="text"
            value={draft}
            disabled={sending}
            placeholder={agent.canInstruct ? `Send to ${agent.name}… (/ for commands)` : 'Watch-only: type / for commands like /usage'}
            aria-label={`Send a message to ${agent.name}`}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
      ) : (
        <p className="agent-feed-hint">{OBSERVED_HINT}</p>
      )}
    </div>
  );
}
