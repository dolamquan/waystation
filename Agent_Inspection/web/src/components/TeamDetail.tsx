import { AnimatePresence } from 'framer-motion';
import { useId, useRef, useState } from 'react';
import { api, type Agent, type MemberDiff, type TeamMember, type TeamView } from '../api.ts';
import type { TeamLogItem } from '../useTower.ts';
import { cliUnavailableReason, useToolAvailability } from '../useToolAvailability.ts';
import { Icon } from './Icon.tsx';
import { Confirm, Modal } from './Modal.tsx';
import { MemberCard } from './team/MemberCard.tsx';
import { PlanReview } from './team/PlanReview.tsx';
import { TaskBoard } from './team/TaskBoard.tsx';
import { TeamComposer } from './team/TeamComposer.tsx';
import { TeamConversation } from './team/TeamConversation.tsx';
import { TeamHeader } from './team/TeamHeader.tsx';
import { TeamOverview } from './team/TeamOverview.tsx';
import { isArchived, leadOf, resumeGrantText, type PendingConfirm, type RunAction } from './team/teamUi.ts';
import { useTeamLog } from './team/useTeamLog.ts';

export { TEAM_STATUS_LABEL } from './team/teamUi.ts';

interface TeamDetailProps {
  readonly team: TeamView;
  readonly agents: readonly Agent[];
  readonly teamLogFeed: readonly TeamLogItem[];
  readonly now: number;
  readonly connected: boolean;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
  readonly onSelectAgent: (agentId: string) => void;
}

type Tab = 'tasks' | 'conversation';
const TABS: readonly Tab[] = ['tasks', 'conversation'];

/** Runs one action at a time, reporting success or the error message. */
function useTeamAction(connected: boolean, notify: TeamDetailProps['notify']): { busy?: string; run: RunAction } {
  const [busy, setBusy] = useState<string>();
  const run: RunAction = async (key, fn, ok) => {
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
  return { busy, run };
}

function mergeAllMessage(result: Awaited<ReturnType<typeof api.mergeAll>>): string {
  const parts = [result.merged.length ? `Merged ${result.merged.join(', ')}.` : 'Nothing was merged.'];
  if (result.skipped.length) parts.push(`No changes from ${result.skipped.join(', ')}.`);
  if (result.stopped) parts.push(`Stopped at ${result.stopped.member}: ${result.stopped.reason}`);
  return parts.join(' ');
}

export function TeamDetail({ team, agents, teamLogFeed, now, connected, notify, onSelectAgent }: TeamDetailProps) {
  const tools = useToolAvailability();
  const sessionId = useId();
  const [tab, setTab] = useState<Tab>('tasks');
  const [to, setTo] = useState('all');
  const [confirm, setConfirm] = useState<PendingConfirm>();
  const [diff, setDiff] = useState<{ member: TeamMember; diff: MemberDiff }>();
  const [removeWorktrees, setRemoveWorktrees] = useState(true);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const logState = useTeamLog(team.id, teamLogFeed, notify);
  const { busy, run } = useTeamAction(connected, notify);
  const archived = isArchived(team);
  const unavailable = !!busy || !connected;

  const messageMember = (member: TeamMember) => {
    setTo(member.name);
    setTab('conversation');
    requestAnimationFrame(() => messageInput.current?.focus());
  };
  const feedbackToLead = () => { const lead = leadOf(team); if (lead) messageMember(lead); };

  const openDiff = (member: TeamMember) => void run(`diff:${member.id}`, async () => {
    setDiff({ member, diff: (await api.memberDiff(team.id, member.id)).diff });
  });
  const askMerge = (member: TeamMember) => setConfirm({
    title: `Merge ${member.name}'s work?`,
    body: `Commits everything in ${member.name}'s worktree, then merges ${member.branch} into ${team.baseBranch} in ${team.repoRoot}. Your project must be on ${team.baseBranch} with no uncommitted changes. On a conflict nothing is changed.`,
    label: 'Merge',
    action: async () => notify((await api.mergeMember(team.id, member.id)).message),
  });
  const askMergeAll = () => setConfirm({
    title: `Merge all of ${team.name}'s work?`,
    body: `Merges every member with changes into ${team.baseBranch}: workers first, one at a time, then the lead. If a merge conflicts, it stops there and leaves that member and the rest unmerged; earlier merges stay. Your project must be on ${team.baseBranch} with no uncommitted changes.`,
    label: 'Merge all',
    action: async () => notify(mergeAllMessage(await api.mergeAll(team.id))),
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
  const askTakeBack = (member: TeamMember) => setConfirm({
    title: `Take ${member.name} back?`,
    body: `Close ${member.name}'s CLI tab first if it is still open. Taking it back while that session keeps running would leave two copies of ${member.name} working on the same conversation. The old tab loses team access either way.`,
    label: 'Take back',
    action: async () => notify((await api.returnMember(team.id, member.id)).message),
  });
  const askDisband = () => setConfirm({
    title: `Disband ${team.name}?`,
    body: 'Stops every member agent and archives the team. Its board and conversation stay readable here. Unmerged branches are kept, so no work is lost.',
    label: 'Disband',
    danger: true,
    withWorktreeOption: true,
    action: async () => {
      const result = await api.disbandTeam(team.id, removeWorktrees);
      notify(result.keptBranches.length ? `Team disbanded. Kept branches: ${result.keptBranches.join(', ')}` : 'Team disbanded.');
    },
  });
  const askRemove = () => setConfirm({
    title: `Remove ${team.name} from the list?`,
    body: 'Deletes the archived board and conversation from Waystation. Branches that were kept in your repository are not touched.',
    label: 'Remove',
    danger: true,
    ok: 'Team removed.',
    action: () => api.removeTeam(team.id).then(() => undefined),
  });

  const panelProps = (view: Tab) => ({
    id: `${sessionId}-${view}-panel`, role: 'tabpanel', 'aria-labelledby': `${sessionId}-${view}-tab`, hidden: tab !== view, tabIndex: 0,
  });

  return (
    <section className="team-detail team-session" aria-label={`Team ${team.name}`}>
      <TeamHeader
        team={team} now={now} busy={busy} unavailable={unavailable} operatorCliMissing={cliUnavailableReason(tools, 'claude')}
        onPause={() => void run('pause', () => api.pauseTeam(team.id), 'Team paused.')}
        onResume={() => void run('resume', () => api.resumeTeam(team.id), `Team resumed (${resumeGrantText(team)}).`)}
        onOperatorCli={() => void run('operator', async () => notify((await api.openTeamOperator(team.id)).message))}
        onMergeAll={askMergeAll} onDisband={askDisband} onRemove={askRemove}
      />
      <TeamOverview team={team} agents={agents} now={now} connected={connected} onSelectAgent={onSelectAgent} onMessage={messageMember} />
      {!archived && <PlanReview team={team} unavailable={unavailable} busy={busy} run={run} onFeedback={feedbackToLead} />}

      <div className="session-workspace">
        <div className="session-main">
          <TeamTabs sessionId={sessionId} tab={tab} taskCount={team.tasks.length} onChange={setTab} />
          <div {...panelProps('conversation')}>
            <TeamConversation team={team} logState={logState} now={now} connected={connected} active={tab === 'conversation'} />
            {archived
              ? <p className="session-composer-note team-archived-note">This team has been disbanded. Its conversation is saved here.</p>
              : <TeamComposer team={team} to={to} onToChange={setTo} inputRef={messageInput} busy={busy} unavailable={unavailable} run={run} notify={notify} />}
          </div>
          <div {...panelProps('tasks')}>
            <TaskBoard team={team} readOnly={archived} unavailable={unavailable} run={run} ask={setConfirm} />
          </div>
        </div>

        <aside className="session-sidebar" aria-label="Team members and project">
          <section className="session-members-panel">
            <div className="session-panel-head"><h3><Icon name="crew" size={17} />Members <span className="session-count">{team.members.length}</span></h3><span>Each member has their own workspace.</span></div>
            <ul className="team-member-list">
              {team.members.map((member) => (
                <MemberCard
                  key={member.id} team={team} member={member} agents={agents} readOnly={archived} unavailable={unavailable} busy={busy}
                  cliMissing={cliUnavailableReason(tools, member.vendor)}
                  onSelectAgent={onSelectAgent} onMessage={messageMember} onDiff={openDiff} onMerge={askMerge} onOpenCli={askOpenCli} onTakeBack={askTakeBack}
                />
              ))}
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
                {confirm.withWorktreeOption && (
                  <label className="check"><input type="checkbox" checked={removeWorktrees} onChange={(e) => setRemoveWorktrees(e.target.checked)} />Also delete the members' worktree folders</label>
                )}
              </>
            )}
            confirmLabel={confirm.label}
            danger={confirm.danger}
            onConfirm={() => void run(confirm.label, confirm.action, confirm.ok)}
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

interface TeamTabsProps {
  readonly sessionId: string;
  readonly tab: Tab;
  readonly taskCount: number;
  readonly onChange: (tab: Tab) => void;
}

/** Task board / conversation tabs with arrow-key, Home and End navigation. */
function TeamTabs({ sessionId, tab, taskCount, onChange }: TeamTabsProps) {
  const move = (event: React.KeyboardEvent, view: Tab) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? TABS[0] : event.key === 'End' ? TABS[TABS.length - 1] : TABS[(TABS.indexOf(view) + 1) % TABS.length];
    onChange(next);
    document.getElementById(`${sessionId}-${next}-tab`)?.focus();
  };
  return (
    <div className="session-tabs" role="tablist" aria-label="Session views">
      {TABS.map((view) => (
        <button key={view} id={`${sessionId}-${view}-tab`} role="tab" aria-selected={tab === view} aria-controls={`${sessionId}-${view}-panel`} tabIndex={tab === view ? 0 : -1} onClick={() => onChange(view)} onKeyDown={(event) => move(event, view)}>
          <Icon name={view === 'conversation' ? 'message' : 'grid'} size={17} />{view === 'conversation' ? 'Conversation' : 'Task board'}
          {view === 'tasks' && <span className="session-count">{taskCount}</span>}
        </button>
      ))}
    </div>
  );
}
