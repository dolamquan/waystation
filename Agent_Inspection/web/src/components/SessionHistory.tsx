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

type SessionState = SessionView['state'];

const STATE_LABEL: Record<SessionState, string> = { active: 'Active', interrupted: 'Interrupted', finished: 'Ended' };
const STATE_FILTERS: readonly { readonly value: '' | SessionState; readonly label: string }[] = [
  { value: '', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'interrupted', label: 'Interrupted' }, { value: 'finished', label: 'Ended' },
];
const DAY_MS = 86_400_000;
/** Requests longer than this get a "Show more" toggle; shorter ones fit inside the three-line clamp. */
const LONG_REQUEST_CHARS = 260;

function dayGroup(updatedAt: number, now: number): string {
  const today = new Date(now).setHours(0, 0, 0, 0);
  if (updatedAt >= today) return 'Today';
  if (updatedAt >= today - DAY_MS) return 'Yesterday';
  if (updatedAt >= today - 6 * DAY_MS) return 'Earlier this week';
  return 'Older';
}

function groupByDay(sessions: readonly SessionView[], now: number): [string, SessionView[]][] {
  const groups = new Map<string, SessionView[]>();
  for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const label = dayGroup(session.updatedAt, now);
    groups.set(label, [...(groups.get(label) ?? []), session]);
  }
  return [...groups];
}

function historicalAgent(session: SessionView): Agent {
  if (session.live) return session.agent;
  return { ...session.agent, status: 'stopped', canInstruct: false, pid: undefined, intercepting: false, inTerminal: false, source: 'Session history', stopBlockedReason: 'Resume this session from Session history to continue.' };
}

export function SessionHistory({ now, onOpen, notify }: Props) {
  const uid = useId();
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('');
  const [state, setState] = useState<'' | SessionState>('');
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
  const inProject = sessions.filter(session => !project || session.agent.cwd === project);
  const needle = query.trim().toLowerCase();
  const visible = inProject.filter(session => (!state || session.state === state)
    && `${session.agent.name} ${session.agent.cwd ?? ''} ${session.agent.project} ${session.originalRequest ?? ''} ${session.latestResult ?? ''}`.toLowerCase().includes(needle));
  const countFor = (value: '' | SessionState) => inProject.filter(session => !value || session.state === value).length;
  const clearFilters = () => { setQuery(''); setProject(''); setState(''); };
  const resume = async (session: SessionView) => {
    setResuming(session.id);
    try { const result = await api.resumeSession(session.id); onOpen(result.agent); setRefresh(value => value + 1); notify('Conversation restored. Saved messages stay on hold until you review them.'); }
    catch (failure) { notify((failure as Error).message, 'error'); setError((failure as Error).message); }
    finally { setResuming(undefined); }
  };
  const interrupted = sessions.filter(session => session.state === 'interrupted' && !session.live).length;
  return <section className="session-history" aria-label="Session history">
    {interrupted > 0 && <div className="session-recovery-note"><span className="session-recovery-icon"><Icon name="info" size={20} /></span><div><strong>{interrupted} {interrupted === 1 ? 'conversation is' : 'conversations are'} available for recovery</strong><p>Restore a conversation when you’re ready. Recovery waits for your next instruction.</p></div><button className="btn btn-small" onClick={() => { setState('interrupted'); setProject(''); setQuery(''); }}>Show interrupted</button></div>}
    <div className="history-toolbar">
      <label className="search-field"><Icon name="search" size={16} /><input aria-label="Search session history" placeholder="Search requests, replies, or projects" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label className="history-project" htmlFor={`${uid}-project`}><Icon name="folder" size={16} /><select id={`${uid}-project`} aria-label="Project" value={project} onChange={event => setProject(event.target.value)}><option value="">All projects</option>{projects.map(path => <option key={path} value={path}>{path}</option>)}</select></label>
      <button className="icon-btn" aria-label="Refresh session history" title="Refresh" onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" size={16} /></button>
    </div>
    <div className="history-filters" role="group" aria-label="Status">
      {STATE_FILTERS.map(filter => <button key={filter.value || 'all'} className={`history-filter history-filter-${filter.value || 'all'}`} aria-pressed={state === filter.value} onClick={() => setState(filter.value)}>{filter.label}<span className="history-filter-count">{countFor(filter.value)}</span></button>)}
    </div>
    {error && <div className="detail-load-error" role="alert"><p>{error}</p><button className="btn" onClick={() => setRefresh(value => value + 1)}>Try again</button></div>}
    {loading ? <p className="history-loading">Loading session history…</p> : visible.length
      ? groupByDay(visible, now).map(([label, group]) => <section key={label} className="history-group" aria-label={label}>
        <h2 className="history-group-label">{label}<span>{group.length}</span></h2>
        <ol className="history-list">{group.map(session => <SessionCard key={session.id} session={session} now={now} resuming={resuming} onOpen={() => onOpen(historicalAgent(session))} onResume={() => void resume(session)} />)}</ol>
      </section>)
      : <div className="detail-feed-empty"><Icon name="search" size={25} /><h2>{sessions.length ? 'No matching sessions' : 'Your session history starts here'}</h2><p>{sessions.length ? 'Try another search or clear the project and status filters.' : 'Conversations discovered or launched in Waystation will remain here after they end.'}</p>{sessions.length > 0 && <button className="btn" onClick={clearFilters}>Clear filters</button>}</div>}
  </section>;
}

interface CardProps {
  readonly session: SessionView;
  readonly now: number;
  readonly resuming?: string;
  readonly onOpen: () => void;
  readonly onResume: () => void;
}

function SessionCard({ session, now, resuming, onOpen, onResume }: CardProps) {
  const [expanded, setExpanded] = useState(false);
  const { agent } = session;
  const request = session.originalRequest;
  const isLong = !!request && (request.length > LONG_REQUEST_CHARS || request.split('\n').length > 3);
  return <li className={`history-card history-card-${session.state}`}>
    <header className="history-card-head">
      <span className={`history-avatar vendor-${agent.vendor}`} aria-hidden="true">{agent.name.trim().charAt(0).toUpperCase() || '?'}</span>
      <div className="history-card-title">
        <h3>{agent.name}</h3>
        <p className="history-meta">{VENDOR_LABEL[agent.vendor]}<span aria-hidden="true">·</span>{agent.project}</p>
      </div>
      <div className="history-card-aside">
        <span className={`history-status history-status-${session.state}`}>{STATE_LABEL[session.state]}</span>
        <time dateTime={new Date(session.updatedAt).toISOString()} title={new Date(session.updatedAt).toLocaleString()}>{readableTime(session.updatedAt, now)}</time>
      </div>
    </header>
    {request && <div className="history-request">
      <p className={isLong && !expanded ? 'is-clamped' : undefined}>{request}</p>
      {isLong && <button className="history-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Show full request'}</button>}
    </div>}
    {session.latestResult && <details className="history-result"><summary>Latest result</summary><p>{session.latestResult}</p></details>}
    <footer className="history-card-foot">
      <span className="history-path" title={agent.cwd}><Icon name="folder" size={14} />{agent.cwd ?? 'Project folder unknown'}</span>
      <div className="session-actions">
        {!session.canResume && !session.live && session.resumeBlockedReason && <span className="session-help">{session.resumeBlockedReason}</span>}
        <button className="btn btn-small" onClick={onOpen}>Open conversation</button>
        {session.canResume && <button className="btn btn-small btn-go" disabled={!!resuming} onClick={onResume}>{resuming === session.id ? 'Restoring…' : 'Resume conversation'}</button>}
      </div>
    </footer>
  </li>;
}
