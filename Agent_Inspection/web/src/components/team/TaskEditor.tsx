import { useId, useState } from 'react';
import type { NewTask, TaskPatch, TeamTask, TeamView } from '../../api.ts';
import { TASK_STATUSES, TASK_STATUS_LABEL, findMember } from './teamUi.ts';

interface TaskEditorProps {
  readonly team: TeamView;
  /** The task being edited; omitted when adding one. */
  readonly task?: TeamTask;
  /** Hide status and note (e.g. while reviewing a plan). */
  readonly compact?: boolean;
  readonly disabled: boolean;
  readonly onSave: (change: NewTask | TaskPatch) => void;
  readonly onCancel: () => void;
}

/** Only the fields that changed, so the board records a precise update. */
function changes(task: TeamTask, draft: Required<TaskPatch>, team: TeamView): TaskPatch {
  const current = findMember(team, task.assignee)?.name ?? '';
  return {
    ...(draft.title.trim() !== task.title ? { title: draft.title.trim() } : {}),
    ...(draft.details.trim() !== task.details ? { details: draft.details.trim() } : {}),
    ...(draft.status !== task.status ? { status: draft.status } : {}),
    ...(draft.assignee && draft.assignee !== current ? { assignee: draft.assignee } : {}),
    ...(draft.note.trim() !== (task.note ?? '') ? { note: draft.note.trim() } : {}),
  };
}

/** Add or edit one task on the board. */
export function TaskEditor({ team, task, compact = false, disabled, onSave, onCancel }: TaskEditorProps) {
  const id = useId();
  const [draft, setDraft] = useState<Required<TaskPatch>>(() => ({
    title: task?.title ?? '',
    details: task?.details ?? '',
    status: task?.status ?? 'open',
    assignee: findMember(team, task?.assignee)?.name ?? '',
    note: task?.note ?? '',
  }));
  const set = (patch: Partial<Required<TaskPatch>>) => setDraft((current) => ({ ...current, ...patch }));
  // The board cannot unassign through an update, so "Unassigned" is offered only where it is true.
  const canLeaveUnassigned = !task || !task.assignee;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.title.trim()) return;
    if (!task) {
      onSave({ title: draft.title.trim(), details: draft.details.trim() || undefined, assignee: draft.assignee || undefined });
      return;
    }
    const patch = changes(task, draft, team);
    if (Object.keys(patch).length === 0) onCancel();
    else onSave(patch);
  };

  return (
    <form className="team-task-editor" onSubmit={submit} aria-label={task ? `Edit ${task.title}` : 'New task'}>
      <label htmlFor={`${id}-title`}>Title</label>
      <input id={`${id}-title`} className="text-input" value={draft.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} required autoFocus />
      <label htmlFor={`${id}-details`}>Details</label>
      <textarea id={`${id}-details`} className="text-input" value={draft.details} onChange={(e) => set({ details: e.target.value })} rows={3} maxLength={4000} placeholder="What done looks like, files to touch, constraints…" />
      <div className="team-task-editor-row">
        <label>Assignee
          <select className="text-input" value={draft.assignee} onChange={(e) => set({ assignee: e.target.value })}>
            {canLeaveUnassigned && <option value="">Unassigned</option>}
            {team.members.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
          </select>
        </label>
        {task && !compact && (
          <label>Status
            <select className="text-input" value={draft.status} onChange={(e) => set({ status: e.target.value as TeamTask['status'] })}>
              {TASK_STATUSES.map((status) => <option key={status} value={status}>{TASK_STATUS_LABEL[status]}</option>)}
            </select>
          </label>
        )}
      </div>
      {task && !compact && (
        <>
          <label htmlFor={`${id}-note`}>Note</label>
          <input id={`${id}-note`} className="text-input" value={draft.note} onChange={(e) => set({ note: e.target.value })} maxLength={1000} placeholder="Progress or what is blocking it" />
        </>
      )}
      <div className="team-task-editor-actions">
        <button type="button" className="btn btn-small btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-small btn-go" disabled={disabled || !draft.title.trim()}>{task ? 'Save task' : 'Add task'}</button>
      </div>
    </form>
  );
}
