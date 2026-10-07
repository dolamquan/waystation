import { useState } from 'react';
import { api, type NewTeamMember, type TeamView } from '../api.ts';
import { MODEL_SUGGESTIONS, modelListId } from '../models.ts';
import { Icon } from './Icon.tsx';
import { Modal } from './Modal.tsx';

interface NewTeamDialogProps {
  readonly defaultCwd?: string;
  readonly onClose: () => void;
  readonly onCreated: (team: TeamView) => void;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
}

const MAX_MEMBERS = 6;
const DEFAULT_MEMBERS: readonly NewTeamMember[] = [
  { name: 'lead', role: 'lead', vendor: 'claude' },
  { name: 'builder', role: 'worker', vendor: 'codex' },
  { name: 'reviewer', role: 'worker', vendor: 'claude' },
];

const nextName = (members: readonly NewTeamMember[]) => {
  for (let i = members.length; ; i += 1) {
    const candidate = `worker-${i}`;
    if (!members.some((m) => m.name === candidate)) return candidate;
  }
};

export function NewTeamDialog({ defaultCwd, onClose, onCreated, notify }: NewTeamDialogProps) {
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState(defaultCwd ?? '');
  const [goal, setGoal] = useState('');
  const [members, setMembers] = useState<readonly NewTeamMember[]>(DEFAULT_MEMBERS);
  const [maxWakes, setMaxWakes] = useState(40);
  const [maxMinutes, setMaxMinutes] = useState(60);
  const [initGit, setInitGit] = useState(false);
  const [intercept, setIntercept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const update = (index: number, patch: Partial<NewTeamMember>) =>
    setMembers((list) => list.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  const makeLead = (index: number) =>
    setMembers((list) => list.map((m, i) => ({ ...m, role: i === index ? 'lead' : 'worker' })));
  const remove = (index: number) =>
    setMembers((list) => {
      const next = list.filter((_, i) => i !== index);
      return next.some((m) => m.role === 'lead') ? next : next.map((m, i) => ({ ...m, role: i === 0 ? 'lead' : 'worker' }));
    });
  const add = () => setMembers((list) => [...list, { name: nextName(list), role: 'worker', vendor: 'claude' }]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { team, notes } = await api.createTeam({
        name: name.trim() || 'Team',
        goal,
        cwd: cwd.trim(),
        members: members.map((m) => ({ ...m, name: m.name.trim().toLowerCase(), model: m.model?.trim() || undefined })),
        initGit,
        intercept,
        maxWakes,
        maxMinutes,
      });
      notify(`Team "${team.name}" is starting. The lead is planning the work.${notes.length ? ` ${notes.join(' ')}` : ''}`);
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
    <Modal title="Create an agent team" onClose={onClose}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <label>Team name
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Auth refactor" maxLength={60} />
        </label>
        <label>Project folder (absolute path to a git repository)
          <input className="text-input" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="C:\Users\you\project" required />
        </label>
        <label>Goal
          <textarea className="text-input" value={goal} onChange={(e) => setGoal(e.target.value)} rows={4} required placeholder="What should the team deliver? The lead splits this into tasks." />
        </label>

        <fieldset className="team-members">
          <legend>Members <span className="muted">· one lead plans and reviews, workers build</span></legend>
          {members.map((member, index) => (
            <div className="team-member-row" key={index}>
              <button
                type="button"
                className={`lead-toggle ${member.role === 'lead' ? 'lead-on' : ''}`}
                onClick={() => makeLead(index)}
                aria-pressed={member.role === 'lead'}
                title={member.role === 'lead' ? 'Team lead' : 'Make lead'}
              >
                {member.role === 'lead' ? 'Lead' : 'Worker'}
              </button>
              <input
                className="text-input"
                aria-label={`Member ${index + 1} name`}
                value={member.name}
                onChange={(e) => update(index, { name: e.target.value.toLowerCase() })}
                pattern="[a-z][a-z0-9-]{0,23}"
                title="Lowercase letters, digits and dashes"
                required
              />
              <select className="text-input" aria-label={`Member ${index + 1} agent`} value={member.vendor} onChange={(e) => update(index, { vendor: e.target.value as NewTeamMember['vendor'] })}>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
              <input
                className="text-input"
                aria-label={`Member ${index + 1} model`}
                list={modelListId(member.vendor)}
                value={member.model ?? ''}
                onChange={(e) => update(index, { model: e.target.value })}
                placeholder="default model"
              />
              <button type="button" className="icon-btn" onClick={() => remove(index)} disabled={members.length <= 2} aria-label={`Remove ${member.name}`}>
                <Icon name="close" size={14} />
              </button>
            </div>
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
        <p className="small muted team-hint">Each automatic wake-up is one agent turn. The team pauses when either limit is reached, or when everyone goes idle, so it never loops unattended.</p>

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
        <footer className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-go" disabled={busy}>{busy ? 'Creating worktrees…' : 'Create team'}</button>
        </footer>
      </form>
    </Modal>
  );
}
