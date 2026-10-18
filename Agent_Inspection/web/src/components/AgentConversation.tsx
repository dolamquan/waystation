import { useEffect, useRef, useState, type Ref } from 'react';
import type { AgentEvent } from '../api.ts';
import { readableTime } from '../activity.ts';
import { MessageText } from './ActivityFeed.tsx';
import { Icon } from './Icon.tsx';
import './agent-conversation.css';

interface Props {
  readonly events: readonly (AgentEvent & { seq: number })[];
  readonly name: string;
  readonly now: number;
  readonly active: boolean;
  readonly loading: boolean;
  readonly error?: string;
  readonly status: string;
  readonly onRetry: () => void;
  readonly outputRef?: Ref<HTMLDivElement>;
}

export function AgentConversation({ events, name, now, active, loading, error, status, onRetry, outputRef }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const dimensions = useRef({ width: 0, height: 0 });
  const [away, setAway] = useState(false);
  const latest = () => {
    following.current = true;
    setAway(false);
    const node = viewport.current;
    if (node) node.scrollTop = node.scrollHeight;
  };

  useEffect(() => {
    if (active && following.current) latest();
  }, [events, active, status, loading, error]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const node = viewport.current;
      if (node) dimensions.current = { width: node.clientWidth, height: node.clientHeight };
      if (following.current) latest();
    });
    if (content.current) observer.observe(content.current);
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);

  return <div className="agent-conversation">
    <div ref={viewport} className="chat-scroll" tabIndex={0} aria-label="Conversation history" onScroll={() => {
      const node = viewport.current;
      if (!node) return;
      // Layout changes can emit scroll events before the resize observer runs.
      // Keep the user's follow preference until the new viewport is measured.
      if (node.clientWidth !== dimensions.current.width || node.clientHeight !== dimensions.current.height) return;
      following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
      setAway(!following.current);
    }}>
      <div ref={content} className="chat-content">
        {error && <div className="detail-load-error" role="alert"><p>Couldn’t load conversation. {error}</p><button className="btn" onClick={onRetry} disabled={loading}>Try again</button></div>}
        {!events.length && <div className="chat-empty"><Icon name="message" size={28} /><h3>{loading ? 'Loading conversation…' : `Chat with ${name}`}</h3><p>{loading ? 'Getting the latest messages.' : 'Send a task, ask a question, or share a context doc.'}</p></div>}
        <ol className="chat-messages" role="log" aria-label="Messages" aria-live={active ? 'polite' : 'off'} aria-relevant="additions" aria-busy={loading}>
          {events.map(event => <li key={event.seq} className={`chat-message chat-${event.kind}`}>
            <div className="chat-message-meta"><strong>{event.kind === 'prompt' ? 'You' : event.kind === 'error' ? 'Something went wrong' : name}</strong><time dateTime={new Date(event.ts).toISOString()} title={new Date(event.ts).toLocaleString()}>{readableTime(event.ts, now)}</time></div>
            <div className="chat-message-body"><MessageText text={event.summary} /></div>
          </li>)}
        </ol>
        <div className="chat-command-results" ref={outputRef} />
        <p className="chat-current" role="status">{status}</p>
      </div>
    </div>
    {away && <button className="btn chat-latest" onClick={latest}>Latest messages<Icon name="chevronDown" size={15} /></button>}
  </div>;
}
