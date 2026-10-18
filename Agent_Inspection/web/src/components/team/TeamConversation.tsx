import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TeamLogEntry, TeamView } from '../../api.ts';
import { timeAgo } from '../../format.ts';
import { Icon } from '../Icon.tsx';
import { entryHeading, isQueued, visibleEntries } from './teamLog.ts';
import { findMember } from './teamUi.ts';
import type { TeamLogState } from './useTeamLog.ts';

type IconName = Parameters<typeof Icon>[0]['name'];

const LOG_ICON: Record<TeamLogEntry['kind'], IconName> = {
  message: 'message', reply: 'message', task: 'list', activity: 'activity', system: 'info', merge: 'check',
};
const SPOKEN = new Set<TeamLogEntry['kind']>(['message', 'reply']);

interface TeamConversationProps {
  readonly team: TeamView;
  readonly logState: TeamLogState;
  readonly now: number;
  readonly connected: boolean;
  readonly active: boolean;
}

/** The team channel: messages and replies with sender → recipient, notices, and optional tool activity. */
export function TeamConversation({ team, logState, now, connected, active }: TeamConversationProps) {
  const [showActivity, setShowActivity] = useState(false);
  const [member, setMember] = useState<string>();
  const { log, loading, failed, reload } = logState;
  const rows = useMemo(() => visibleEntries(team, log, { showActivity, member }), [team, log, showActivity, member]);
  const viewport = useRef<HTMLOListElement>(null);
  const following = useRef(true);
  const dimensions = useRef({ width: 0, height: 0 });
  const [away, setAway] = useState(false);
  const latest = () => {
    following.current = true;
    setAway(false);
    const node = viewport.current;
    if (node) node.scrollTop = node.scrollHeight;
  };

  useLayoutEffect(() => { latest(); }, [team.id, member, showActivity]);
  useLayoutEffect(() => {
    if (!active) return;
    const node = viewport.current;
    if (!node) return;
    const update = () => {
      dimensions.current = { width: node.clientWidth, height: node.clientHeight };
      if (following.current) node.scrollTop = node.scrollHeight;
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    for (const row of node.children) observer.observe(row);
    return () => observer.disconnect();
  }, [rows, active, loading]);

  return (
    <>
      <div className="session-channel-head">
        <div><strong>Team channel</strong><span>Follow progress and help the team move forward.</span></div>
        <button className="session-activity-toggle" aria-pressed={showActivity} onClick={() => setShowActivity((on) => !on)}>
          <Icon name="activity" size={14} />{showActivity ? 'Hide tool activity' : 'Show tool activity'}
        </button>
      </div>
      <div className="team-filter-chips" role="group" aria-label="Show messages involving">
        <button type="button" className="team-chip" aria-pressed={!member} onClick={() => setMember(undefined)}>Everyone</button>
        <button type="button" className="team-chip" aria-pressed={member === 'operator'} onClick={() => setMember('operator')}>You</button>
        {team.members.map((m) => (
          <button key={m.id} type="button" className="team-chip" aria-pressed={member === m.id} onClick={() => setMember(m.id)}>{m.name}</button>
        ))}
      </div>
      <ol ref={viewport} className="timeline team-log" aria-live={active ? 'polite' : 'off'} aria-relevant="additions" aria-busy={loading} aria-label="Team conversation and updates" tabIndex={0} onScroll={() => {
        const node = viewport.current;
        if (!node || node.clientWidth !== dimensions.current.width || node.clientHeight !== dimensions.current.height) return;
        following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
        setAway(!following.current);
      }}>
        {rows.map(({ entry, position }) => <LogRow key={`${entry.ts}-${position}`} team={team} entry={entry} now={now} />)}
        {rows.length === 0 && <EmptyLog loading={loading} failed={failed} filtered={!!member} connected={connected} onRetry={reload} />}
      </ol>
      {away && <button type="button" className="btn btn-small session-latest" onClick={latest}>Latest messages<Icon name="chevronDown" size={15} /></button>}
    </>
  );
}

function LogRow({ team, entry, now }: { team: TeamView; entry: TeamLogEntry; now: number }) {
  const sender = findMember(team, entry.actor);
  const heading = entryHeading(team, entry);
  const queued = isQueued(team, entry);
  const initial = (sender?.name ?? (entry.actor === 'operator' ? 'You' : entry.actor)).slice(0, 1).toUpperCase();
  const replyClass = entry.kind === 'reply' && entry.to !== 'operator' ? ' team-log-reply-private' : '';
  return (
    <li className={`tl team-log-${entry.kind}${replyClass}`}>
      <span className={`session-log-avatar ${sender ? `avatar-${sender.vendor}` : ''}`} aria-hidden="true">
        {SPOKEN.has(entry.kind) ? initial : <Icon name={LOG_ICON[entry.kind]} size={15} />}
      </span>
      <div className="session-log-body">
        <div className="session-log-meta">
          <strong>{heading.title}</strong>
          <span>{heading.kind}</span>
          {queued && <span className="team-queued-badge" title="Waiting to be delivered">Queued</span>}
          <time dateTime={new Date(entry.ts).toISOString()} title={new Date(entry.ts).toLocaleString()}>{timeAgo(entry.ts, now)}</time>
        </div>
        <p>{entry.summary}</p>
      </div>
    </li>
  );
}

interface EmptyLogProps {
  readonly loading: boolean;
  readonly failed: boolean;
  readonly filtered: boolean;
  readonly connected: boolean;
  readonly onRetry: () => void;
}

function EmptyLog({ loading, failed, filtered, connected, onRetry }: EmptyLogProps) {
  const title = loading ? 'Loading conversation…' : failed ? 'Conversation couldn’t load' : filtered ? 'Nothing here yet' : 'A space for your team';
  const body = loading
    ? 'Getting the latest team updates.'
    : failed
      ? 'Try loading the conversation again. New updates will still appear here.'
      : filtered
        ? 'No messages involve this member yet. Choose Everyone to see the whole channel.'
        : 'Updates will appear here as the team gets started. Send a message to share direction or ask a question.';
  return (
    <li className="session-empty">
      <span className="session-empty-icon"><Icon name={failed ? 'alert' : 'message'} size={27} /></span>
      <strong>{title}</strong>
      <p>{body}</p>
      {failed && <button className="btn btn-small" disabled={!connected} onClick={onRetry}>Try again</button>}
    </li>
  );
}
