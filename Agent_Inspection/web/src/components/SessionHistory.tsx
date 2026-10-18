import { useEffect, useId, useState } from 'react';
import { api, type Agent } from '../api.ts';
import type { SessionView } from '../../../daemon/sessions/types.ts';
import { readableTime } from '../activity.ts';
import { VENDOR_LABEL } from '../format.ts';
import { Icon } from './Icon.tsx';
import '../session-history.css';

interface Props {
  readonly now: number;
  readonly onOpen: (agent: Agent) => void;
  readonly notify: (message: string, kind?: 'ok' | 'error') => void;
}

export function SessionHistory({ now, onOpen, notify }: Props) {
  const uid = useId();
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('');
  const [state, setState] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [resuming, setResuming] = useState<string>();
  useEffect(() => {
    let ignore = false;
    api.sessions().then(result => { if (!ignore) { setSessions(result.sessions); setLoading(false); setError(undefined); } }, failure => { if (!ignore) { setError(failure.message); setLoading(false); } });
    return () => { ignore = true; };
  }, [now, refresh]);
  const projects = [...new Set(sessions.flatMap(session => session.agent.cwd ? [session.agent.cwd] : []))].sort();
  const visible = sessions.filter(session => (!state || session.state === state) && (!project || session.agent.cwd === project)
    && `${session.agent.name} ${session.agent.cwd ?? ''} ${session.agent.project} ${session.originalRequest ?? ''} ${session.latestResult ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const resume = async (session: SessionView) => {
    setResuming(session.id);
    try { const result = await api.resumeSession(session.id); onOpen(result.agent); setRefresh(value => value + 1); notify('Conversation restored. Saved messages stay on hold until you review them.'); }
    catch (failure) { notify((failure as Error).message, 'error'); setError((failure as Error).message); }
    finally { setResuming(undefined); }
  };
  const interrupted = sessions.filter(session => session.state === 'interrupted' && !session.live).length;
  return <section className="session-history" aria-label="Session history">
    {interrupted > 0 && <div className="session-recovery-note"><Icon name="info" size={20} /><div><strong>{interrupted} {interrupted === 1 ? 'conversation is' : 'conversations are'} available for recovery</strong><p>Restore a conversation when you’re ready. Recovery waits for your next instruction.</p></div><button className="btn btn-small" onClick={() => { setState('interrupted'); setProject(''); setQuery(''); }}>Show interrupted</button></div>}
    <div className="history-toolbar">
      <label className="search-field"><Icon name="search" size={16} /><input aria-label="Search session history" placeholder="Search requests, replies, or projects" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label htmlFor={`${uid}-project`}>Project<select id={`${uid}-project`} aria-label="Project" className="sort-select" value={project} onChange={event => setProject(event.target.value)}><option value="">All projects</option>{projects.map(path => <option key={path} value={path}>{path}</option>)}</select></label>
      <label htmlFor={`${uid}-state`}>Status<select id={`${uid}-state`} aria-label="Status" className="sort-select" value={state} onChange={event => setState(event.target.value)}><option value="">All sessions</option><option value="active">Active</option><option value="finished">Finished</option><option value="interrupted">Interrupted</option></select></label>
      <button className="icon-btn" aria-label="Refresh session history" onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" size={16} /></button>
    </div>
    {error && <div className="detail-load-error" role="alert"><p>{error}</p><button className="btn" onClick={() => setRefresh(value => value + 1)}>Try again</button></div>}
    {loading ? <p>Loading session history…</p> : visible.length ? <ol className="history-list">{visible.map(session => <li key={session.id} className="history-row">
      <div className="history-row-heading"><h2>{session.agent.name}</h2><span className={`message-state message-state-${session.state === 'interrupted' ? 'review' : session.state === 'active' ? 'queued' : 'delivered'}`}>{session.state === 'active' ? 'Active' : session.state === 'interrupted' ? 'Interrupted' : 'Session ended'}</span></div>
      <p className="session-help">{VENDOR_LABEL[session.agent.vendor]} · {session.agent.project} · {readableTime(session.updatedAt, now)}</p>
      <p className="history-path">{session.agent.cwd ?? 'Project folder unknown'}</p>
      {session.originalRequest && <p className="history-request">{session.originalRequest}</p>}
      {session.latestResult && <details className="history-result"><summary>Latest result</summary><p>{session.latestResult}</p></details>}
      <div className="session-actions"><button className="btn btn-small" onClick={() => onOpen(session.live ? session.agent : { ...session.agent, status: 'stopped', canInstruct: false, pid: undefined, intercepting: false, inTerminal: false, source: 'Session history', stopBlockedReason: 'Resume this session from Session history to continue.' })}>Open conversation</button>
        {session.canResume && <button className="btn btn-small btn-go" disabled={!!resuming} onClick={() => void resume(session)}>{resuming === session.id ? 'Restoring…' : 'Resume conversation'}</button>}
        {!session.canResume && !session.live && <span className="session-help">{session.resumeBlockedReason}</span>}
      </div>
    </li>)}</ol> : <div className="detail-feed-empty"><Icon name="search" size={25} /><h2>{sessions.length ? 'No matching sessions' : 'Your session history starts here'}</h2><p>{sessions.length ? 'Try another search or clear the project and status filters.' : 'Conversations discovered or launched in Waystation will remain here after they end.'}</p>{sessions.length > 0 && <button className="btn" onClick={() => { setQuery(''); setProject(''); setState(''); }}>Clear filters</button>}</div>}
  </section>;
}
