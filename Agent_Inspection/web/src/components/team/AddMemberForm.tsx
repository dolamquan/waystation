import { useState } from 'react';
import { api, type TeamView } from '../../api.ts';
import { MODEL_SUGGESTIONS, modelListId } from '../../models.ts';
import { Icon } from '../Icon.tsx';
import { NewTeamMemberRow, toNewMember, type MemberDraft } from './NewTeamMemberRow.tsx';
import type { RunAction } from './teamUi.ts';

/** Matches the daemon's MAX_MEMBERS (daemon/teams/teamInput.ts). */
export const MAX_TEAM_MEMBERS = 6;

/** First free `worker-N` name, so the form opens with something valid. */
export function nextWorkerName(taken: readonly string[]): string {
  for (let i = taken.length; ; i += 1) {
    const candidate = `worker-${i}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

const freshDraft = (team: TeamView): MemberDraft => ({
  key: 'new-member',
  name: nextWorkerName(team.members.map((m) => m.name)),
  role: 'worker',
  vendor: 'claude',
  focus: '',
  loadout: {},
});

type Props = {
  team: TeamView;
  codexAvailable: boolean;
  isUnavailable: boolean;
  run: RunAction;
  notify: (text: string, kind?: 'ok' | 'error') => void;
};

/** Adds a worker to a running (or paused) team: its own worktree, and the lead is told so it can hand out work. */
export function AddMemberForm({ team, codexAvailable, isUnavailable, run, notify }: Props) {
  const [draft, setDraft] = useState<MemberDraft>();
  const isFull = team.members.length >= MAX_TEAM_MEMBERS;

  if (!draft) {
    return (
      <button
        type="button" className="btn btn-small btn-ghost team-add-member"
        onClick={() => setDraft(freshDraft(team))} disabled={isUnavailable || isFull}
        title={isFull ? `A team has at most ${MAX_TEAM_MEMBERS} members.` : undefined}
      >
        <Icon name="plus" size={14} />Add member
      </button>
    );
  }

  const listId = `add-${modelListId(draft.vendor)}`;
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const member = toNewMember(draft);
    // run() reports errors itself; the form only closes once the member has joined.
    void run('add-member', async () => {
      const result = await api.addTeamMember(team.id, member);
      notify(result.message);
      setDraft(undefined);
    });
  };

  return (
    <form className="team-add-member-form" onSubmit={handleSubmit} aria-label="Add a member to this team">
      <NewTeamMemberRow
        member={draft}
        index={team.members.length}
        codexAvailable={codexAvailable}
        canRemove
        roleLocked
        modelListId={listId}
        onChange={(patch) => setDraft({ ...draft, ...patch })}
        onMakeLead={() => undefined}
        onRemove={() => setDraft(undefined)}
      />
      <datalist id={listId}>
        {(MODEL_SUGGESTIONS[draft.vendor] ?? []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </datalist>
      <p className="small muted">It gets its own worktree from {team.baseBranch}. The lead is told it joined and assigns it work.</p>
      <div className="team-add-member-actions">
        <button type="button" className="btn btn-small btn-ghost" onClick={() => setDraft(undefined)}>Cancel</button>
        <button type="submit" className="btn btn-small btn-go" disabled={isUnavailable || (draft.vendor === 'codex' && !codexAvailable)}>Add {draft.name || 'member'}</button>
      </div>
    </form>
  );
}
