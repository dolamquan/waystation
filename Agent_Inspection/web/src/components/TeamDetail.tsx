import { AnimatePresence } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
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
const LOG_ICON: Record<TeamLogEntry['kind'], string> = { message: '✉', task: '▣', activity: '·', system: '◇', merge: '⇲' };

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

export function TeamDetail({ team, agents, teamLogFeed, now, notify, onSelectAgent }: TeamDetailProps) {
  const [log, setLog] = useState<TeamLogEntry[]>([]);
  const [filter, setFilter] = useState<LogFilter>('conversation');
  const [to, setTo] = useState('all');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string>();
  const [confirm, setConfirm] = useState<Pending>();
  const [diff, setDiff] = useState<{ member: TeamMember; diff: MemberDiff }>();
  const [removeWorktrees, setRemoveWorktrees] = useState(true);

  useEffect(() => {
    let ignore = false;
    setLog([]);
    api.teamLog(team.id).then(
      (result) => { if (!ignore) setLog(result.entries); },
      (error: Error) => { if (!ignore) notify(error.message, 'error'); },
    );
    return () => { ignore = true; };
  }, [team.id, notify]);

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
    if (busy) return;
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
  const wakePercent = Math.min(100, Math.round((team.budget.wakesUsed / team.budget.maxWakes) * 100));

  return (
    <section className="team-detail" aria-label={`Team ${team.name}`}>
      <header className="team-detail-head">
        <div>
          <div className="eyebrow">TEAM · {team.baseBranch.toUpperCase()}</div>
          <h2>{team.name} <span className={`team-status team-${team.status}`}>{TEAM_STATUS_LABEL[team.status]}</span></h2>
          <p className="team-goal">{team.goal}</p>
          {team.statusReason && <p className="small muted">{team.statusReason}</p>}
        </div>
        <div className="team-actions">
          <button className="btn btn-small" disabled={!!busy || team.status === 'disbanded'} title="Open a Claude Code session that can read and steer this team" onClick={() => void run('operator', async () => notify((await api.openTeamOperator(team.id)).message))}><Icon name="terminal" size={14} />Open in Claude Code</button>
          {team.status === 'running' && <button className="btn btn-small" disabled={!!busy} onClick={() => void run('pause', () => api.pauseTeam(team.id), 'Team paused.')}><Icon name="pause" size={14} />Pause</button>}
          {canResume && <button className="btn btn-small btn-ok" disabled={!!busy} onClick={() => void run('resume', () => api.resumeTeam(team.id), 'Team resumed.')}><Icon name="play" size={14} />Resume</button>}
          <button className="btn btn-small btn-danger" disabled={!!busy} onClick={askDisband}>Disband</button>
        </div>
      </header>

      <div className="team-budget-meter" aria-label="Team budget">
        <div><span className="muted small">Wake-ups</span><strong>{team.budget.wakesUsed} / {team.budget.maxWakes}</strong></div>
        <div className="meter"><span style={{ width: `${wakePercent}%` }} /></div>
        <div><span className="muted small">Time left</span><strong>{team.status === 'running' ? `${minutesLeft} min` : '—'}</strong></div>
      </div>

      {team.summary && <div className="callout"><strong>Lead's summary:</strong> {team.summary}</div>}

      <h3 className="team-subhead">Members</h3>
      <ul className="team-member-list">
        {team.members.map((member) => {
          const status = memberStatus(member, agents);
          return (
            <li key={member.id} className="team-member">
              <span className={`vendor-dot vendor-${member.vendor}`} aria-hidden="true" />
              <div className="team-member-main">
                <strong>{member.name}</strong>
                <span className="small muted">{member.role} · {member.vendor === 'claude' ? 'Claude' : 'Codex'}{member.model ? ` · ${member.model}` : ''}</span>
                <code className="small muted team-branch" title={member.worktree}>{member.branch}</code>
              </div>
              <span className={`status-pill ${status.pill}`}>{member.merged ? 'Merged' : status.label}</span>
              <div className="team-member-actions">
                {member.agentId && agents.some((a) => a.id === member.agentId) && (
                  <button className="btn btn-small btn-ghost" onClick={() => onSelectAgent(member.agentId!)}>Open</button>
                )}
                {member.terminal
                  ? <button className="btn btn-small" disabled={!!busy} title="Bring this member back to the team now" onClick={() => setConfirm({
                    title: `Take ${member.name} back?`,
                    body: `Close ${member.name}'s CLI tab first if it is still open. Taking it back while that session keeps running would leave two copies of ${member.name} working on the same conversation. The old tab loses team access either way.`,
                    label: 'Take back',
                    action: async () => notify((await api.returnMember(team.id, member.id)).message),
                  })}>Take back</button>
                  : member.agentId && agents.some((a) => a.id === member.agentId && a.sessionId) && (
                    <button className="btn btn-small" disabled={!!busy} title={`Continue this member's session in the real ${member.vendor === 'codex' ? 'Codex' : 'Claude Code'} CLI`} onClick={() => askOpenCli(member)}><Icon name="terminal" size={13} />CLI</button>
                  )}
                <button className="btn btn-small" disabled={!!busy} onClick={() => openDiff(member)}>{busy === `diff:${member.id}` ? 'Loading…' : 'Diff'}</button>
                <button className="btn btn-small btn-ok" disabled={!!busy || member.merged} onClick={() => askMerge(member)}>Merge</button>
              </div>
            </li>
          );
        })}
      </ul>

      <h3 className="team-subhead">Task board <span className="section-count">{team.tasks.length}</span></h3>
      {team.tasks.length === 0
        ? <p className="small muted">No tasks yet. The lead creates them after planning.</p>
        : (
          <div className="team-board">
            {TASK_COLUMNS.map((column) => {
              const tasks = team.tasks.filter((task) => task.status === column.status);
              return (
                <div key={column.status} className={`team-column column-${column.status}`}>
                  <div className="team-column-head">{column.label}<span className="chip-count">{tasks.length}</span></div>
                  {tasks.map((task) => (
                    <article key={task.id} className="team-task">
                      <div className="team-task-head"><code>{task.id}</code>{task.assignee && <span className="small muted">@{task.assignee}</span>}</div>
                      <div className="team-task-title">{task.title}</div>
                      {task.note && <div className="small muted team-task-note">{task.note}</div>}
                    </article>
                  ))}
                </div>
              );
            })}
          </div>
        )}

      <h3 className="team-subhead">Message the team</h3>
      <form className="team-composer" onSubmit={send}>
        <select className="text-input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Recipient">
          <option value="all">Everyone</option>
          {team.members.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
        </select>
        <input className="text-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Steer the team, answer a question, add scope…" aria-label="Message" maxLength={8000} />
        <button className="btn btn-go" type="submit" disabled={!text.trim() || !!busy}><Icon name="send" size={14} />Send</button>
      </form>

      <div className="team-log-head">
        <h3 className="team-subhead">Shared log</h3>
        <div className="filters" role="group" aria-label="Log filter">
          <button className={`chip ${filter === 'conversation' ? 'chip-on' : ''}`} aria-pressed={filter === 'conversation'} onClick={() => setFilter('conversation')}>Team channel</button>
          <button className={`chip ${filter === 'everything' ? 'chip-on' : ''}`} aria-pressed={filter === 'everything'} onClick={() => setFilter('everything')}>Everything</button>
        </div>
      </div>
      <ol className="timeline team-log" aria-live="polite">
        {visibleLog.map(({ entry, position }) => (
          <li key={`${entry.ts}-${position}`} className={`tl team-log-${entry.kind}`}>
            <span className="tl-icon" aria-hidden="true">{LOG_ICON[entry.kind]}</span>
            <span className="tl-text">{entry.kind === 'activity' && <strong>{entry.actor} </strong>}{entry.summary}</span>
            <span className="tl-time">{timeAgo(entry.ts, now)}</span>
          </li>
        ))}
        {visibleLog.length === 0 && <li className="small muted">Nothing yet.</li>}
      </ol>

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
