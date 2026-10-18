import { useState } from 'react';
import { TEAM_PRESETS, type TeamPreset } from '../../../shared/teamPresets.ts';
import { api, type TeamView } from '../api.ts';
import { MODEL_SUGGESTIONS, modelListId } from '../models.ts';
import { Icon } from './Icon.tsx';
import { Modal } from './Modal.tsx';
import { ProjectFolderInput } from './ProjectFolderInput.tsx';
import { useToolAvailability } from '../useToolAvailability.ts';
import { NewTeamMemberRow, toNewMember, type MemberDraft } from './team/NewTeamMemberRow.tsx';

interface NewTeamDialogProps {
  readonly defaultCwd?: string;
  readonly onClose: () => void;
  readonly onCreated: (team: TeamView) => void;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
}

const MAX_MEMBERS = 6;
const DEFAULT_PRESET = TEAM_PRESETS[0];

let draftSeq = 0;
const draft = (member: Omit<MemberDraft, 'key' | 'loadout' | 'focus'> & { focus?: string }): MemberDraft =>
  ({ focus: '', ...member, loadout: {}, key: `m${++draftSeq}` });
const fromPreset = (preset: TeamPreset | undefined): MemberDraft[] => (preset?.members ?? [
  { name: 'lead', role: 'lead', vendor: 'claude', focus: '' },
  { name: 'builder', role: 'worker', vendor: 'codex', focus: '' },
]).map((m) => draft(m));

const nextName = (members: readonly MemberDraft[]) => {
  for (let i = members.length; ; i += 1) {
    const candidate = `worker-${i}`;
    if (!members.some((m) => m.name === candidate)) return candidate;
  }
};

/** What creating the team sets in motion, in the order it happens. */
function CreateSummary({ requirePlanApproval }: { requirePlanApproval: boolean }) {
  return (
    <div className="callout team-create-summary" aria-live="polite">
      <strong>What happens when you create</strong>
      <ol>
        {requirePlanApproval ? (
          <>
            <li>The lead starts now and drafts a plan as tasks on the board.</li>
            <li>You review the plan here: approve it, edit tasks, or send the lead feedback.</li>
            <li>Once you approve, each worker starts when it is given work.</li>
          </>
        ) : (
          <>
            <li>The lead starts now, plans, and assigns tasks right away.</li>
            <li>Each worker starts when it is given work.</li>
          </>
        )}
        <li>The team pauses when it reaches the wake-up or time limit, or when everyone goes idle.</li>
      </ol>
    </div>
  );
}

export function NewTeamDialog({ defaultCwd, onClose, onCreated, notify }: NewTeamDialogProps) {
  const tools = useToolAvailability();
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState(defaultCwd ?? '');
  const [goal, setGoal] = useState('');
  const [presetId, setPresetId] = useState<string | undefined>(DEFAULT_PRESET?.id);
  const [members, setMembers] = useState<readonly MemberDraft[]>(() => fromPreset(DEFAULT_PRESET));
  const [requirePlanApproval, setRequirePlanApproval] = useState(true);
  const [presetEdited, setPresetEdited] = useState(false);
  const [maxWakes, setMaxWakes] = useState(40);
  const [maxMinutes, setMaxMinutes] = useState(60);
  const [initGit, setInitGit] = useState(false);
  const [intercept, setIntercept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const edit = (change: (list: readonly MemberDraft[]) => readonly MemberDraft[]) => {
    setPresetEdited(true);
    setMembers(change);
  };
  const choosePreset = (preset: TeamPreset) => {
    setPresetId(preset.id);
    setPresetEdited(false);
    setMembers(fromPreset(preset));
  };
  const update = (index: number, patch: Partial<MemberDraft>) =>
    edit((list) => list.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  const makeLead = (index: number) =>
    edit((list) => list.map((m, i) => ({ ...m, role: i === index ? 'lead' : 'worker' })));
  const remove = (index: number) =>
    edit((list) => {
      const next = list.filter((_, i) => i !== index);
      return next.some((m) => m.role === 'lead') ? next : next.map((m, i) => ({ ...m, role: i === 0 ? 'lead' : 'worker' }));
    });
  const add = () => edit((list) => [...list, draft({ name: nextName(list), role: 'worker', vendor: 'claude' })]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { team, notes } = await api.createTeam({
        name: name.trim() || 'Team',
        goal,
        cwd: cwd.trim(),
        members: members.map(toNewMember),
        initGit,
        intercept,
        maxWakes,
        maxMinutes,
        requirePlanApproval,
      });
      const next = requirePlanApproval ? 'The lead is drafting a plan for you to review.' : 'The lead is planning the work.';
      notify(`Team "${team.name}" is starting. ${next}${notes.length ? ` ${notes.join(' ')}` : ''}`);
      onCreated(team);
      onClose();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      notify(message, 'error');
      setBusy(false);
    }
  };

  return (
    <Modal title="Create an agent team" onClose={onClose} className="team-new-modal">
      <form className="form" onSubmit={(e) => void submit(e)}>
        <label>Team name
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Auth refactor" maxLength={60} />
        </label>
        <ProjectFolderInput value={cwd} onChange={setCwd} label="Project folder (absolute path to a git repository)" />
        <label>Goal
          <textarea className="text-input" value={goal} onChange={(e) => setGoal(e.target.value)} rows={4} required placeholder="What should the team deliver? The lead splits this into tasks." />
        </label>

        <fieldset className="team-members">
          <legend>Members <span className="muted">· one lead plans and reviews, workers build</span></legend>
          <div className="team-presets" role="group" aria-label="Start from a line-up">
            {TEAM_PRESETS.map((preset) => (
              <button key={preset.id} type="button" className="team-preset" aria-pressed={presetId === preset.id} onClick={() => choosePreset(preset)}>
                <strong>{preset.label}{presetId === preset.id && presetEdited ? ' · edited' : ''}</strong>
                <span>{preset.description}</span>
              </button>
            ))}
          </div>
          {members.map((member, index) => (
            <NewTeamMemberRow
              key={member.key}
              member={member}
              index={index}
              codexAvailable={tools.codex !== false}
              canRemove={members.length > 2}
              modelListId={modelListId(member.vendor)}
              onChange={(patch) => update(index, patch)}
              onMakeLead={() => makeLead(index)}
              onRemove={() => remove(index)}
            />
          ))}
          <button type="button" className="btn btn-small btn-ghost" onClick={add} disabled={members.length >= MAX_MEMBERS}>
            <Icon name="plus" size={14} />Add member
          </button>
          {(['claude', 'codex'] as const).map((v) => (
            <datalist key={v} id={modelListId(v)}>
              {MODEL_SUGGESTIONS[v].map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </datalist>
          ))}
        </fieldset>

        <div className="team-budget">
          <label>Wake-up budget
            <input className="text-input" type="number" min={1} max={300} value={maxWakes} onChange={(e) => setMaxWakes(Number(e.target.value))} />
          </label>
          <label>Time limit (minutes)
            <input className="text-input" type="number" min={1} max={480} value={maxMinutes} onChange={(e) => setMaxMinutes(Number(e.target.value))} />
          </label>
        </div>
        <p className="small muted team-hint">Each automatic wake-up is one agent turn, so the team never loops unattended.</p>

        <label className="check">
          <input type="checkbox" checked={requirePlanApproval} onChange={(e) => setRequirePlanApproval(e.target.checked)} />
          Review the lead’s plan before work starts
        </label>
        <CreateSummary requirePlanApproval={requirePlanApproval} />
        <label className="check">
          <input type="checkbox" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} />
          Set up git for this folder if needed (creates a repository and commits the current files)
        </label>
        <label className="check">
          <input type="checkbox" checked={intercept} onChange={(e) => setIntercept(e.target.checked)} />
          Start Claude members in Intercept mode (approve their tool calls)
        </label>
        <div className="callout">
          Each member works in its own git worktree and branch, outside your project folder. Nothing reaches your branch until you review a member's diff and merge it.
        </div>
        {error && <p className="error-text small" role="alert">{error}</p>}
        {tools.git === false && <p role="status">Teams need Git for their worktrees. Install Git and reopen this form.</p>}
        {tools.codex === false && members.some((member) => member.vendor === 'codex') && <p role="status">Codex CLI was not found. Choose Claude for those members, or install Codex and reopen this form.</p>}
        <footer className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-go" disabled={busy || tools.git === false || (tools.codex === false && members.some((member) => member.vendor === 'codex'))}>{busy ? 'Creating worktrees…' : 'Create team'}</button>
        </footer>
      </form>
    </Modal>
  );
}
