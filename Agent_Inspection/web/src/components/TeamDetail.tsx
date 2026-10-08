import { AnimatePresence } from 'framer-motion';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, type Agent, type MemberDiff, type TeamLogEntry, type TeamMember, type TeamTask, type TeamView } from '../api.ts';
import { STATUS_LABEL, timeAgo } from '../format.ts';
import type { TeamLogItem } from '../useTower.ts';
import { Icon } from './Icon.tsx';
import { Confirm, Modal } from './Modal.tsx';

interface TeamDetailProps {
  readonly team: TeamView;
  readonly agents: readonly Agent[];
  readonly teamLogFeed: readonly TeamLogItem[];
  readonly now: number;
  readonly connected: boolean;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
  readonly onSelectAgent: (agentId: string) => void;
}

type LogFilter = 'conversation' | 'everything';
type Pending = { title: string; body: string; label: string; danger?: boolean; action: () => Promise<void> };

const MAX_LOG = 400;
const TASK_COLUMNS: ReadonlyArray<{ status: TeamTask['status']; label: string }> = [
  { status: 'open', label: 'Open' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
];
const LOG_ICON: Record<TeamLogEntry['kind'], Parameters<typeof Icon>[0]['name']> = { message: 'message', task: 'list', activity: 'activity', system: 'info', merge: 'check' };

export const TEAM_STATUS_LABEL: Record<TeamView['status'], string> = {
  running: 'Running', paused: 'Paused', done: 'Ready to merge', stopped: 'Stopped', disbanded: 'Disbanded',
};

const sameEntry = (a: TeamLogEntry, b: TeamLogEntry) => a.ts === b.ts && a.summary === b.summary && a.actor === b.actor;

function memberStatus(member: TeamMember, agents: readonly Agent[]): { label: string; pill: string } {
  if (member.terminal) return { label: 'In your CLI', pill: 'pill-waiting' };
  if (!member.agentId) return { label: 'Not started', pill: 'pill-stopped' };
  const agent = agents.find((a) => a.id === member.agentId);
  if (!agent) return { label: 'Exited', pill: 'pill-stopped' };
  return { label: STATUS_LABEL[agent.status], pill: `pill-${agent.status}` };
}

export function TeamDetail({ team, agents, teamLogFeed, now, connected, notify, onSelectAgent }: TeamDetailProps) {
  const sessionId = useId();
  const [tab, setTab] = useState<'conversation' | 'tasks'>('conversation');
  const [log, setLog] = useState<TeamLogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(true);
  const [logError, setLogError] = useState(false);
  const [logReload, setLogReload] = useState(0);
  const [filter, setFilter] = useState<LogFilter>('conversation');
  const [to, setTo] = useState('all');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string>();
  const [confirm, setConfirm] = useState<Pending>();
  const [diff, setDiff] = useState<{ member: TeamMember; diff: MemberDiff }>();
  const [removeWorktrees, setRemoveWorktrees] = useState(true);
  const messageInput = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let ignore = false;
    setLog([]);
    setLogLoading(true);
    setLogError(false);
    api.teamLog(team.id).then(
      (result) => {
        if (!ignore) {
          setLog((previous) => [...result.entries, ...previous.filter((entry) => !result.entries.some((e) => sameEntry(e, entry)))].sort((a, b) => a.ts - b.ts).slice(-MAX_LOG));
          setLogLoading(false);
        }
      },
      (error: Error) => { if (!ignore) { setLogLoading(false); setLogError(true); notify(error.message, 'error'); } },
    );
    return () => { ignore = true; };
  }, [team.id, notify, logReload]);

  // Consume every feed item newer than the last one seen, so bursts between renders are kept.
  const seenSeq = useRef(teamLogFeed.at(-1)?.seq ?? 0);
  useEffect(() => {
    const fresh = teamLogFeed.filter((item) => item.seq > seenSeq.current);
    if (fresh.length === 0) return;
    seenSeq.current = fresh[fresh.length - 1].seq;
    const mine = fresh.map((item) => item.entry).filter((entry) => entry.teamId === team.id);
    if (mine.length === 0) return;
    // Entries can also arrive in the initial fetch; skip those already present.
    setLog((previous) => [...previous, ...mine.filter((entry) => !previous.some((e) => sameEntry(e, entry)))].slice(-MAX_LOG));
  }, [teamLogFeed, team.id]);

  // Number rows by position in the full log so keys stay stable as new entries are prepended on screen.
  const visibleLog = useMemo(
    () => log
      .map((entry, position) => ({ entry, position }))
      .filter(({ entry }) => filter === 'everything' || entry.kind !== 'activity')
      .reverse(),
    [log, filter],
  );

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    if (busy || !connected) return;
    setBusy(key);
    try {
      await fn();
      if (ok) notify(ok);
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setBusy(undefined);
    }
  };

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    void run('send', async () => {
      const result = await api.messageTeam(team.id, to, text.trim());
      setText('');
      notify(result.message);
    });
  };

  const openDiff = (member: TeamMember) => void run(`diff:${member.id}`, async () => {
    const result = await api.memberDiff(team.id, member.id);
    setDiff({ member, diff: result.diff });
  });

  const askMerge = (member: TeamMember) => setConfirm({
    title: `Merge ${member.name}'s work?`,
    body: `Commits everything in ${member.name}'s worktree, then merges ${member.branch} into ${team.baseBranch} in ${team.repoRoot}. Your project must be on ${team.baseBranch} with no uncommitted changes. On a conflict nothing is changed.`,
    label: 'Merge',
    action: async () => notify((await api.mergeMember(team.id, member.id)).message),
  });

  const askOpenCli = (member: TeamMember) => {
    const cli = member.vendor === 'codex' ? 'Codex' : 'Claude Code';
    setConfirm({
      title: `Open ${member.name} in ${cli}?`,
      body: `Waystation stops its copy of ${member.name} and opens the same session in ${cli} in a new terminal tab, with its team tools. The team won't wake ${member.name} while it is open there; messages wait. Close the session (or use Take back) and ${member.name} rejoins the team where it left off. ${member.name} must be idle.`,
      label: `Open in ${cli}`,
      action: async () => notify((await api.openCli(member.agentId!)).message),
    });
  };

  const askDisband = () => setConfirm({
    title: `Disband ${team.name}?`,
    body: 'Stops every member agent. Unmerged branches are kept, so no work is lost.',
    label: 'Disband',
    danger: true,
    action: async () => {
      const result = await api.disbandTeam(team.id, removeWorktrees);
      notify(result.keptBranches.length ? `Team disbanded. Kept branches: ${result.keptBranches.join(', ')}` : 'Team disbanded.');
    },
  });

  const canResume = team.status === 'paused' || team.status === 'stopped' || team.status === 'done';
  const minutesLeft = Math.max(0, Math.round((team.budget.deadline - now) / 60_000));
  const wakePercent = team.budget.maxWakes > 0 ? Math.max(0, Math.min(100, Math.round((team.budget.wakesUsed / team.budget.maxWakes) * 100))) : 0;
  const doneTasks = team.tasks.filter((task) => task.status === 'done').length;
  const workingMembers = team.members.filter((member) => !member.terminal && agents.some((agent) => agent.id === member.agentId && agent.status === 'busy')).length;
  const unavailable = !!busy || !connected;
  const disbanded = team.status === 'disbanded';
  const messageMember = (member: TeamMember) => {
    setTo(member.name);
    setTab('conversation');
    requestAnimationFrame(() => messageInput.current?.focus());
  };

  return (
    <section className="team-detail team-session" aria-label={`Team ${team.name}`}>
      <header className="team-detail-head">
        <div>
          <h2>{team.name} <span className={`team-status team-${team.status}`}>{TEAM_STATUS_LABEL[team.status]}</span></h2>
          <p className="team-goal">{team.goal}</p>
          <p className="session-started"><Icon name="clock" size={14} />Started {timeAgo(team.createdAt, now)}</p>
        </div>
        <div className="team-actions">
          {team.status === 'running' && <button className="btn btn-small" disabled={unavailable} onClick={() => void run('pause', () => api.pauseTeam(team.id), 'Team paused.')}><Icon name="pause" size={14} />{busy === 'pause' ? 'Pausing…' : 'Pause team'}</button>}
          {canResume && <button className="btn btn-small btn-go" disabled={unavailable} onClick={() => void run('resume', () => api.resumeTeam(team.id), 'Team resumed.')}><Icon name="play" size={14} />{busy === 'resume' ? 'Resuming…' : 'Resume team'}</button>}
          <details className="session-menu">
            <summary aria-label="More team actions"><Icon name="chevronDown" size={16} />More</summary>
            <div className="session-menu-items">
              <button className="btn btn-small" disabled={unavailable || disbanded} title="Open a Claude Code session that can read and steer this team" onClick={() => void run('operator', async () => notify((await api.openTeamOperator(team.id)).message))}><Icon name="terminal" size={14} />Open in Claude Code</button>
              <button className="btn btn-small btn-danger" disabled={unavailable || disbanded} onClick={askDisband}><Icon name="trash" size={14} />Disband team</button>
            </div>
          </details>
        </div>
      </header>

      {!connected && <div className="session-notice" role="status"><Icon name="link" size={16} />Reconnecting. Team controls will be available when the connection returns.</div>}
      {team.statusReason && <div className="session-notice"><Icon name="info" size={16} /><span>{team.statusReason}</span></div>}
      {team.summary && <div className="session-summary"><Icon name="check" size={18} /><div><strong>Lead’s summary</strong><p>{team.summary}</p></div></div>}

      <div className="session-stats" aria-label="Session overview">
        <div className="session-stat"><span><Icon name="crew" size={15} />Team members</span><strong>{team.members.length}<small>{workingMembers ? `${workingMembers} working now` : 'None working now'}</small></strong></div>
        <div className="session-stat"><span><Icon name="check" size={15} />Tasks completed</span><strong>{doneTasks}<small>of {team.tasks.length} {team.tasks.length === 1 ? 'task' : 'tasks'}</small></strong></div>
        <div className="session-stat"><span title="Each automatic agent turn uses one wake-up"><Icon name="activity" size={15} />Wake-ups used</span><strong>{team.budget.wakesUsed}<small>of {team.budget.maxWakes}</small></strong><div className="meter" role="meter" aria-label="Wake-ups used" aria-valuemin={0} aria-valuemax={Math.max(1, team.budget.maxWakes)} aria-valuenow={Math.max(0, Math.min(team.budget.wakesUsed, Math.max(1, team.budget.maxWakes)))}><span style={{ transform: `scaleX(${wakePercent / 100})` }} /></div></div>
        <div className="session-stat"><span><Icon name="clock" size={15} />Time remaining</span><strong>{team.status === 'running' ? minutesLeft : '—'}<small>{team.status === 'running' ? 'minutes' : TEAM_STATUS_LABEL[team.status]}</small></strong></div>
      </div>

      <div className="session-workspace">
        <div className="session-main">
          <div className="session-tabs" role="tablist" aria-label="Session views">
            {(['conversation', 'tasks'] as const).map((view) => (
              <button key={view} id={`${sessionId}-${view}-tab`} role="tab" aria-selected={tab === view} aria-controls={`${sessionId}-${view}-panel`} tabIndex={tab === view ? 0 : -1} onClick={() => setTab(view)} onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? 'conversation' : event.key === 'End' ? 'tasks' : view === 'conversation' ? 'tasks' : 'conversation';
                setTab(next);
                document.getElementById(`${sessionId}-${next}-tab`)?.focus();
              }}><Icon name={view === 'conversation' ? 'message' : 'grid'} size={17} />{view === 'conversation' ? 'Conversation' : 'Task board'}{view === 'tasks' && <span className="session-count">{team.tasks.length}</span>}</button>
            ))}
          </div>

          <div id={`${sessionId}-conversation-panel`} role="tabpanel" aria-labelledby={`${sessionId}-conversation-tab`} hidden={tab !== 'conversation'} tabIndex={0}>
            <div className="session-channel-head"><div><strong>Team channel</strong><span>Follow progress and help the team move forward.</span></div><button className="session-activity-toggle" aria-pressed={filter === 'everything'} onClick={() => setFilter(filter === 'everything' ? 'conversation' : 'everything')}><Icon name="activity" size={14} />{filter === 'everything' ? 'Hide tool activity' : 'Show tool activity'}</button></div>
            <ol className="timeline team-log" aria-live="polite" aria-busy={logLoading} aria-label="Team conversation and updates" tabIndex={0}>
              {visibleLog.map(({ entry, position }) => {
                const member = team.members.find((m) => m.id === entry.actor || m.name === entry.actor);
                const actor = member?.name ?? (entry.actor === 'operator' ? 'You' : entry.actor === 'tower' ? 'Waystation' : entry.actor);
                return (
                  <li key={`${entry.ts}-${position}`} className={`tl team-log-${entry.kind}`}>
                    <span className={`session-log-avatar ${member ? `avatar-${member.vendor}` : ''}`} aria-hidden="true">{entry.kind === 'message' ? actor.slice(0, 1).toUpperCase() : <Icon name={LOG_ICON[entry.kind]} size={15} />}</span>
                    <div className="session-log-body"><div className="session-log-meta"><strong>{actor}</strong><span>{entry.kind === 'message' ? 'Message' : entry.kind === 'task' ? 'Task update' : entry.kind === 'merge' ? 'Work merged' : entry.kind === 'activity' ? 'Tool activity' : 'Team update'}</span><time dateTime={new Date(entry.ts).toISOString()} title={new Date(entry.ts).toLocaleString()}>{timeAgo(entry.ts, now)}</time></div><p>{entry.summary}</p></div>
                  </li>
                );
              })}
              {visibleLog.length === 0 && <li className="session-empty"><span className="session-empty-icon"><Icon name={logError ? 'alert' : 'message'} size={27} /></span><strong>{logLoading ? 'Loading conversation…' : logError ? 'Conversation couldn’t load' : 'A space for your team'}</strong><p>{logLoading ? 'Getting the latest team updates.' : logError ? 'Try loading the conversation again. New updates will still appear here.' : 'Updates will appear here as the team gets started. Send a message to share direction or ask a question.'}</p>{logError && <button className="btn btn-small" disabled={!connected} onClick={() => setLogReload((value) => value + 1)}>Try again</button>}</li>}
            </ol>
            <form className="team-composer" onSubmit={send}>
              <label className="session-message-label" htmlFor={`${sessionId}-message`}>Message {to === 'all' ? 'the team' : to}</label>
              <textarea ref={messageInput} id={`${sessionId}-message`} className="text-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Share direction, ask a question, or add context…" aria-label="Message" maxLength={8000} rows={3} disabled={disbanded} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (!unavailable && !disbanded) event.currentTarget.form?.requestSubmit(); } }} />
              <div className="session-composer-footer"><label className="session-recipient"><Icon name="crew" size={15} /><span>To</span><select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Recipient" disabled={disbanded}><option value="all">Everyone</option>{team.members.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}</select></label><span className="session-send-hint">Ctrl / ⌘ + Enter to send</span><button className="btn btn-go" type="submit" disabled={!text.trim() || unavailable || disbanded}><Icon name="send" size={15} />{busy === 'send' ? 'Sending…' : 'Send message'}</button></div>
              {disbanded && <p className="session-composer-note">This team has been disbanded. Its conversation is saved here.</p>}
            </form>
          </div>

          <div id={`${sessionId}-tasks-panel`} role="tabpanel" aria-labelledby={`${sessionId}-tasks-tab`} hidden={tab !== 'tasks'} tabIndex={0}>
            <div className="session-channel-head"><div><strong>From plan to progress</strong><span>The lead creates tasks and assigns work to the team.</span></div><span className="session-task-total">{doneTasks} / {team.tasks.length} complete</span></div>
            {team.tasks.length === 0 && <div className="session-board-empty"><Icon name="list" size={23} /><div><strong>No tasks yet</strong><p>The lead will add tasks after planning. You can share more context in the conversation.</p></div></div>}
            <div className="team-board">
              {TASK_COLUMNS.map((column) => {
                const tasks = team.tasks.filter((task) => task.status === column.status);
                return <section key={column.status} className={`team-column column-${column.status}`} aria-label={`${column.label} tasks`}><h3 className="team-column-head"><span><span className="session-column-dot" />{column.label}</span><span className="session-count">{tasks.length}</span></h3>{tasks.map((task) => {
                  const assignee = team.members.find((m) => m.id === task.assignee || m.name === task.assignee);
                  return <article key={task.id} className="team-task"><div className="team-task-head"><code>{task.id}</code></div><h4 className="team-task-title">{task.title}</h4>{task.note && <p className="team-task-note">{task.note}</p>}{task.details && <details className="session-task-details"><summary>Task details</summary><p>{task.details}</p></details>}<div className="session-task-assignee"><Icon name="crew" size={13} />{assignee?.name ?? task.assignee ?? 'Unassigned'}</div></article>;
                })}{tasks.length === 0 && <p className="session-column-empty">{column.status === 'done' ? 'Completed work lands here' : column.status === 'blocked' ? 'No blockers' : column.status === 'in_progress' ? 'No active tasks' : 'No open tasks'}</p>}</section>;
              })}
            </div>
          </div>
        </div>

        <aside className="session-sidebar" aria-label="Team members and project">
          <section className="session-members-panel">
            <div className="session-panel-head"><h3><Icon name="crew" size={17} />Members <span className="session-count">{team.members.length}</span></h3><span>Each member has their own workspace.</span></div>
            <ul className="team-member-list">
              {team.members.map((member) => {
                const status = memberStatus(member, agents);
                const agent = agents.find((a) => a.id === member.agentId);
                return (
                  <li key={member.id} className="team-member">
                    <div className="session-member-heading"><span className={`session-member-avatar avatar-${member.vendor}`} aria-hidden="true">{member.name.slice(0, 1).toUpperCase()}</span><div className="team-member-main"><strong>{member.name}{member.role === 'lead' && <span className="session-lead-badge">Lead</span>}</strong><span>{member.vendor === 'claude' ? 'Claude' : 'Codex'}{member.model ? ` · ${member.model}` : ''}</span></div><span className={`status-pill ${status.pill}`}>{member.merged ? 'Merged' : status.label}</span></div>
                    <div className="team-member-actions">{agent && <button className="btn btn-small" onClick={() => onSelectAgent(agent.id)}><Icon name="expand" size={13} />View session</button>}<button className="btn btn-small btn-ghost" disabled={disbanded} onClick={() => messageMember(member)}><Icon name="message" size={14} />Message</button></div>
                    <details className="session-member-workspace"><summary>Workspace &amp; changes<Icon name="chevronDown" size={13} /></summary><code className="team-branch" title={member.worktree}>{member.branch}</code><div className="session-workspace-actions">
                      {member.terminal ? <button className="btn btn-small" disabled={unavailable || disbanded} title="Bring this member back to the team now" onClick={() => setConfirm({ title: `Take ${member.name} back?`, body: `Close ${member.name}'s CLI tab first if it is still open. Taking it back while that session keeps running would leave two copies of ${member.name} working on the same conversation. The old tab loses team access either way.`, label: 'Take back', action: async () => notify((await api.returnMember(team.id, member.id)).message) })}>Take back</button> : agent?.sessionId && <button className="btn btn-small" disabled={unavailable || disbanded} title={`Continue in ${member.vendor === 'codex' ? 'Codex' : 'Claude Code'}`} onClick={() => askOpenCli(member)}><Icon name="terminal" size={13} />Open CLI</button>}
                      <button className="btn btn-small" disabled={unavailable} onClick={() => openDiff(member)}>{busy === `diff:${member.id}` ? 'Loading…' : 'View changes'}</button><button className="btn btn-small btn-ok" disabled={unavailable || member.merged} onClick={() => askMerge(member)}>{member.merged ? 'Merged' : 'Merge work'}</button>
                    </div></details>
                  </li>
                );
              })}
            </ul>
          </section>
          <section className="session-project"><h3><Icon name="folder" size={17} />Project workspace</h3><span title={team.repoRoot}>{team.repoRoot.split(/[\\/]/).filter(Boolean).at(-1) || team.repoRoot}</span><code title={team.repoRoot}>{team.repoRoot}</code><div><Icon name="link" size={14} />Base branch <strong>{team.baseBranch}</strong></div></section>
        </aside>
      </div>

      <AnimatePresence>
        {confirm && (
          <Confirm
            title={confirm.title}
            body={(
              <>
                <p>{confirm.body}</p>
                {confirm.label === 'Disband' && (
                  <label className="check"><input type="checkbox" checked={removeWorktrees} onChange={(e) => setRemoveWorktrees(e.target.checked)} />Also delete the members' worktree folders</label>
                )}
              </>
            )}
            confirmLabel={confirm.label}
            danger={confirm.danger}
            onConfirm={() => void run(confirm.label, confirm.action)}
            onClose={() => setConfirm(undefined)}
          />
        )}
        {diff && (
          <Modal title={`${diff.member.name} · changes since the team started`} onClose={() => setDiff(undefined)}>
            {diff.diff.stat ? (
              <>
                <pre className="code-view">{diff.diff.stat}</pre>
                <pre className="code-view diff-view">{diff.diff.patch}</pre>
                {diff.diff.truncated && <p className="small muted">Diff truncated. Open {diff.member.worktree} to see everything.</p>}
              </>
            ) : <p className="modal-body">No changes yet.</p>}
          </Modal>
        )}
      </AnimatePresence>
    </section>
  );
}
