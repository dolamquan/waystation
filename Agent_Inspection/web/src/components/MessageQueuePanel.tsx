import { useEffect, useId, useState } from 'react';
import { api, type Agent } from '../api.ts';
import type { QueuedMessage } from '../../../daemon/sessions/types.ts';
import '../session-history.css';

const labels = { queued: 'Queued', delivering: 'Submitting', delivered: 'Delivered to agent', cancelled: 'Cancelled', review: 'Needs your review' };

export function MessageQueuePanel({ agent }: { readonly agent: Agent }) {
  const uid = useId();
  const [messages, setMessages] = useState<QueuedMessage[]>([]);
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState('');
  const [confirmed, setConfirmed] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try { const result = await api.messageQueue(agent.id); if (active) { setMessages(result.messages ?? []); setLoadError(undefined); } }
      catch (failure) { if (active) setLoadError((failure as Error).message); }
      finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, [agent.id, agent.lastEventAt, refresh]);
  const change = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); setEditing(undefined); setConfirmed(undefined); setRefresh(value => value + 1); setError(undefined); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const pending = messages.filter(message => ['queued', 'review', 'delivering'].includes(message.state));
  const completed = messages.filter(message => ['delivered', 'cancelled'].includes(message.state)).slice(-10).reverse();
  const row = (message: QueuedMessage) => <li key={message.id} className="message-queue-row">
    <span className={`message-state message-state-${message.state}`}>{labels[message.state]}</span>
    {editing === message.id ? <form onSubmit={event => { event.preventDefault(); void change(() => api.editQueuedMessage(agent.id, message.id, draft)); }}>
      <label htmlFor={`${uid}-edit`}>Edit queued message</label>
      <textarea id={`${uid}-edit`} className="text-input" rows={3} value={draft} onChange={event => setDraft(event.target.value)} maxLength={8000} disabled={busy} autoFocus />
      <div className="session-actions"><button className="btn btn-small" type="submit" disabled={busy || !draft.trim()}>Save message</button><button className="btn btn-small btn-ghost" type="button" onClick={() => setEditing(undefined)} disabled={busy}>Keep original</button></div>
    </form> : <p className="queue-message-text">{message.text}</p>}
    {message.reason && <p className="session-help">{message.reason}</p>}
    {['queued', 'review'].includes(message.state) && editing !== message.id && <div className="session-actions">
      <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => { setEditing(message.id); setDraft(message.text); }}>Edit</button>
      <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => void change(() => api.cancelQueuedMessage(agent.id, message.id))}>Cancel message</button>
      {message.state === 'review' && <button className="btn btn-small" disabled={busy || !agent.canInstruct} onClick={() => setConfirmed(message.id)}>Review delivery</button>}
    </div>}
    {confirmed === message.id && <div className="queue-confirmation"><p>Check the conversation to make sure this message was not already received. Sending it again can repeat the task.</p><button className="btn btn-small" disabled={busy} onClick={() => void change(() => api.sendReviewedMessage(agent.id, message.id))}>I checked — send this message</button><button className="btn btn-small btn-ghost" onClick={() => setConfirmed(undefined)} disabled={busy}>Keep on hold</button></div>}
  </li>;
  if (!messages.length && !error && !loadError) return null;
  return <details className="message-queue" open={pending.length > 0}>
    <summary>Message queue <span>{pending.length ? `${pending.length} pending` : 'Recent delivery'}</span></summary>
    <div className="message-queue-content">
      {loadError && <div role="alert"><p className="outputs-error">Couldn’t load the message queue. {loadError}</p><button className="btn btn-small" onClick={() => setRefresh(value => value + 1)}>Try again</button></div>}
      {error && <p className="outputs-error" role="alert">{error}</p>}
      {pending.length > 0 && <ol className="message-queue-list">{pending.map(row)}</ol>}
      {!agent.canInstruct && pending.length > 0 && <p className="session-help">Resume this conversation from Session history before sending saved messages.</p>}
      {completed.length > 0 && <details className="queue-delivery-history"><summary>Delivery history</summary><ol className="message-queue-list">{completed.map(row)}</ol><p className="session-help">Delivered means the agent accepted the message, not that it completed the task.</p></details>}
    </div>
  </details>;
}
