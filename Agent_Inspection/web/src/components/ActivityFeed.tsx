import { useState, type ReactNode } from 'react';
import type { AgentEvent } from '../api.ts';
import { activityTitle, readableTime } from '../activity.ts';
import { Icon } from './Icon.tsx';
import { plainToolActivity } from '../../../shared/plainActivity.ts';

/** Render simple recorded message formatting without accepting HTML. */
export function MessageText({ text }: { readonly text: string }) {
  const pieces = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g);
  const nodes: ReactNode[] = pieces.map((piece, i) => {
    if (piece.startsWith('**') && piece.endsWith('**')) return <strong key={i}>{piece.slice(2, -2)}</strong>;
    if (piece.startsWith('`') && piece.endsWith('`')) return <code key={i}>{piece.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(piece);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>;
    return piece;
  });
  return <>{nodes}</>;
}

export function ActivityItem({ event, now }: { readonly event: AgentEvent; readonly now: number }) {
  const [expanded, setExpanded] = useState(false);
  const tool = event.kind === 'tool_call' || event.kind === 'tool_result';
  const update = event.kind === 'status' || event.kind === 'system' || event.kind === 'stop';
  const canExpand = !tool && !update && event.summary.length > 200;
  const icon = event.kind === 'prompt' ? 'message' : event.kind === 'assistant' ? 'sparkle' : tool ? 'terminal' : event.kind === 'error' ? 'alert' : 'activity';
  return (
    <li className={`activity-entry entry-${event.kind} ${update ? 'entry-update' : ''}`}>
      <span className="entry-icon"><Icon name={icon} size={15} /></span>
      <div className="entry-content">
        <div className="entry-heading"><strong>{event.kind === 'tool_call' ? plainToolActivity(event.summary) : activityTitle(event)}</strong><time dateTime={new Date(event.ts).toISOString()} title={new Date(event.ts).toLocaleString()}>{readableTime(event.ts, now)}</time></div>
        {tool ? <details className="entry-tool-details"><summary>View recorded details<Icon name="chevronDown" size={13} /></summary><pre>{event.summary}</pre></details> :
          !update ? <><p className={`entry-message ${canExpand && !expanded ? 'entry-collapsed' : ''}`}><MessageText text={event.summary} /></p>{canExpand && <button className="entry-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Read more'}</button>}</> :
            event.summary !== 'turn started' && event.summary !== 'turn complete' && <p className="entry-message">{event.summary}</p>}
      </div>
    </li>
  );
}

export function ActivityFeed({ events, now }: { readonly events: readonly (AgentEvent & { seq: number })[]; readonly now: number }) {
  return <ol className="activity-feed">{[...events].reverse().slice(0, 120).map(event => <ActivityItem key={event.seq} event={event} now={now} />)}</ol>;
}
