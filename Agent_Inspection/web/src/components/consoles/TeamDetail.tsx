import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { timeAgo } from '../../format.ts';
import type { ChannelCandidate } from './ChannelsPanel.tsx';
import { addMember, postMessage, removeChannel, removeMember, type ChannelView, type SkillTargetStatus } from './channelsApi.ts';
import { eligibleCandidates, friendlyError, isTeamFull, recipientOptions, skillCovers } from './teamLogic.ts';

interface TeamDetailProps {
  readonly channel: ChannelView;
  readonly candidates: readonly ChannelCandidate[];
  readonly targets: readonly SkillTargetStatus[];
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
  /** Reload the channel list after a change. */
  readonly refresh: () => Promise<void>;
  readonly onBack: () => void;
}

/** One team: members (with skill state), the message log, an operator message box and delete. */
export function TeamDetail({ channel, candidates, targets, notify, refresh, onBack }: TeamDetailProps) {
  const [to, setTo] = useState('all');
  const [text, setText] = useState('');
  const [adding, setAdding] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLOListElement>(null);
  const following = useRef(true);
  const recipients = useMemo(() => recipientOptions(channel), [channel]);
  const eligible = eligibleCandidates(candidates, channel);
  const labelOf = (agentId: string) => candidates.find((c) => c.agentId === agentId)?.label;

  // Follow the newest message unless the operator scrolled up to read history.
  useLayoutEffect(() => {
    const node = log.current;
    if (node && following.current) node.scrollTop = node.scrollHeight;
  }, [channel.messages.length, channel.id]);
  // A removed member can no longer be addressed.
  useEffect(() => { if (!recipients.includes(to)) setTo('all'); }, [recipients, to]);

  const run = async (action: () => Promise<string | void>) => {
    if (busy) return;
    setBusy(true);
    try {
      const done = await action();
      if (done) notify(done);
      await refresh();
    } catch (error) {
      notify(friendlyError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const send = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const body = text.trim();
    if (!body) return;
    following.current = true;
    void run(async () => { await postMessage(channel.id, to, body); setText(''); });
  };
  const add = () => {
    const candidate = eligible.find((c) => c.agentId === adding);
    if (!candidate) return;
    void run(async () => {
      const added = await addMember(channel.id, candidate.agentId, candidate.label);
      setAdding('');
      return added.notice.startsWith('Added, but') ? added.notice : `${candidate.label} joined as ${added.member.name}.`;
    });
  };

  return (
    <div className="chan-detail">
      <div className="chan-detail-head">
        <button type="button" className="chan-btn" onClick={onBack} aria-label="Back to channels">&larr; Channels</button>
        <h3>#{channel.name}</h3>
      </div>
      {channel.purpose && <p className="chan-purpose">{channel.purpose}</p>}

      <h4 className="chan-sub">Members ({channel.members.length})</h4>
      {channel.members.length === 0 && <p className="chan-hint">No members yet. Add running sessions below.</p>}
      <ul className="chan-members">
        {channel.members.map((m) => {
          const ready = skillCovers(m.vendor, targets);
          return (
            <li key={m.name} className="chan-member">
              <span className="chan-member-name">{m.name}</span>
              <span className="chan-member-meta">{labelOf(m.agentId) ?? m.agentName} &middot; {m.vendor}</span>
              <span className={`chan-status-${m.status}`}>{m.status === 'gone' ? 'offline' : m.status}</span>
              {m.unread > 0 && <span className="chan-unread" title="Unread messages">{m.unread}</span>}
              <span className={ready ? 'chan-skill-ok' : 'chan-skill-missing'} title={ready ? 'Can message teammates' : 'The channel skill is not installed for this vendor'}>
                {ready ? 'skill ok' : 'no skill'}
              </span>
              <button type="button" className="chan-btn chan-btn-quiet" disabled={busy} aria-label={`Remove ${m.name} from the channel`}
                onClick={() => void run(async () => { await removeMember(channel.id, m.name); return `${m.name} removed.`; })}>Remove</button>
            </li>
          );
        })}
      </ul>
      <div className="chan-add">
        <select className="chan-input" value={adding} aria-label="Add a session" onChange={(e) => setAdding(e.target.value)} disabled={isTeamFull(channel)}>
          <option value="">{eligible.length ? 'Add a session...' : 'No other sessions available'}</option>
          {eligible.map((c) => <option key={c.agentId} value={c.agentId}>{c.label} ({c.origin})</option>)}
        </select>
        <button type="button" className="chan-btn chan-btn-primary" disabled={!adding || busy} onClick={add}>Add</button>
      </div>

      <h4 className="chan-sub">Messages</h4>
      <ol className="chan-log" ref={log} aria-live="polite" tabIndex={0} aria-label="Team messages"
        onScroll={(e) => { const n = e.currentTarget; following.current = n.scrollHeight - n.scrollTop - n.clientHeight < 24; }}>
        {channel.messages.length === 0 && <li className="chan-hint">Nothing said yet.</li>}
        {channel.messages.map((m) => (
          <li key={m.id} className={`chan-msg${m.from === 'operator' ? ' chan-msg-operator' : ''}`}>
            <div className="chan-msg-head">
              <strong>{m.from}</strong> <span aria-hidden="true">&rarr;</span> {m.to}
              <time dateTime={new Date(m.ts).toISOString()} title={new Date(m.ts).toLocaleString()}>{timeAgo(m.ts)}</time>
            </div>
            <p>{m.text}</p>
          </li>
        ))}
      </ol>
      <form className="chan-compose" onSubmit={send}>
        <select className="chan-input chan-to" value={to} aria-label="Send to" onChange={(e) => setTo(e.target.value)}>
          {recipients.map((r) => <option key={r} value={r}>{r === 'all' ? 'Everyone' : r}</option>)}
        </select>
        <textarea className="chan-input" rows={2} value={text} maxLength={8000} placeholder="Message the channel (Ctrl+Enter to send)"
          aria-label="Message" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e); }} />
        <button type="submit" className="chan-btn chan-btn-primary" disabled={!text.trim() || busy || channel.members.length === 0}>Send</button>
      </form>

      <div className="chan-danger">
        {confirming ? (
          <>
            <span>Delete #{channel.name} and its messages?</span>
            <button type="button" className="chan-btn" onClick={() => setConfirming(false)}>Keep</button>
            <button type="button" className="chan-btn chan-btn-danger" disabled={busy}
              onClick={() => void run(async () => { await removeChannel(channel.id); onBack(); return `#${channel.name} deleted.`; })}>Delete channel</button>
          </>
        ) : <button type="button" className="chan-btn chan-btn-quiet" onClick={() => setConfirming(true)}>Delete channel</button>}
      </div>
    </div>
  );
}
