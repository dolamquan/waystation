import { useState } from 'react';
import { api, type NewTask, type TaskPatch, type TeamTask, type TeamView } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { TaskEditor } from './TaskEditor.tsx';
import { TASK_STATUSES, TASK_STATUS_LABEL, findMember, type PendingConfirm, type RunAction } from './teamUi.ts';

interface TaskBoardProps {
  readonly team: TeamView;
  readonly readOnly: boolean;
  readonly unavailable: boolean;
  readonly run: RunAction;
  readonly ask: (confirm: PendingConfirm) => void;
}

const EMPTY_COLUMN: Record<TeamTask['status'], string> = {
  open: 'No open tasks', in_progress: 'No active tasks', blocked: 'No blockers', done: 'Completed work lands here',
};

/** The shared task board. The operator can add, edit, move, reassign and remove tasks. */
export function TaskBoard({ team, readOnly, unavailable, run, ask }: TaskBoardProps) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string>();
  const done = team.tasks.filter((task) => task.status === 'done').length;

  const create = (input: NewTask) => void run('task:new', async () => {
    await api.createTask(team.id, input);
    setAdding(false);
  }, input.assignee ? `Task added and sent to ${input.assignee}.` : 'Task added.');

  const save = (task: TeamTask, patch: TaskPatch) => void run(`task:${task.id}`, async () => {
    await api.updateTask(team.id, task.id, patch);
    setEditing(undefined);
  }, 'Task updated.');

  const remove = (task: TeamTask) => ask({
    title: `Remove “${task.title}”?`,
    body: 'The task leaves the board for everyone. Work already done in a member’s worktree is not touched.',
    label: 'Remove task',
    danger: true,
    ok: 'Task removed.',
    action: () => api.removeTask(team.id, task.id).then(() => undefined),
  });

  return (
    <>
      <div className="session-channel-head">
        <div><strong>From plan to progress</strong><span>{readOnly ? 'This board is saved with the archived team.' : 'The lead plans the work. You can add, move and reassign tasks too.'}</span></div>
        <div className="team-board-head-actions">
          <span className="session-task-total">{done} / {team.tasks.length} complete</span>
          {!readOnly && <button className="btn btn-small" disabled={unavailable || adding} onClick={() => setAdding(true)}><Icon name="plus" size={14} />Add task</button>}
        </div>
      </div>
      {adding && (
        <div className="team-task-new">
          <TaskEditor team={team} disabled={unavailable} onSave={(input) => create(input as NewTask)} onCancel={() => setAdding(false)} />
        </div>
      )}
      {team.tasks.length === 0 && !adding && (
        <div className="session-board-empty"><Icon name="list" size={23} /><div><strong>No tasks yet</strong><p>The lead adds tasks while planning. You can add one yourself or share more context in the conversation.</p></div></div>
      )}
      <div className="team-board">
        {TASK_STATUSES.map((status) => {
          const tasks = team.tasks.filter((task) => task.status === status);
          return (
            <section key={status} className={`team-column column-${status}`} aria-label={`${TASK_STATUS_LABEL[status]} tasks`}>
              <h3 className="team-column-head"><span><span className="session-column-dot" />{TASK_STATUS_LABEL[status]}</span><span className="session-count">{tasks.length}</span></h3>
              {tasks.map((task) => editing === task.id
                ? <TaskEditor key={task.id} team={team} task={task} disabled={unavailable} onSave={(patch) => save(task, patch)} onCancel={() => setEditing(undefined)} />
                : <TaskCard key={task.id} team={team} task={task} readOnly={readOnly} unavailable={unavailable} onStatus={(next) => save(task, { status: next })} onEdit={() => setEditing(task.id)} onRemove={() => remove(task)} />)}
              {tasks.length === 0 && <p className="session-column-empty">{EMPTY_COLUMN[status]}</p>}
            </section>
          );
        })}
      </div>
    </>
  );
}

interface TaskCardProps {
  readonly team: TeamView;
  readonly task: TeamTask;
  readonly readOnly: boolean;
  readonly unavailable: boolean;
  readonly onStatus: (status: TeamTask['status']) => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}

function TaskCard({ team, task, readOnly, unavailable, onStatus, onEdit, onRemove }: TaskCardProps) {
  const assignee = findMember(team, task.assignee);
  return (
    <article className="team-task">
      <div className="team-task-head"><code>{task.id}</code>{task.createdBy === 'operator' && <span className="team-task-by">Added by you</span>}</div>
      <h4 className="team-task-title">{task.title}</h4>
      {task.note && <p className="team-task-note">{task.note}</p>}
      {task.details && <details className="session-task-details"><summary>Task details</summary><p>{task.details}</p></details>}
      <div className="session-task-assignee"><Icon name="crew" size={13} />{assignee?.name ?? task.assignee ?? 'Unassigned'}</div>
      {!readOnly && (
        <div className="team-task-actions">
          <select className="team-task-status" aria-label={`Status of ${task.title}`} value={task.status} disabled={unavailable} onChange={(e) => onStatus(e.target.value as TeamTask['status'])}>
            {TASK_STATUSES.map((status) => <option key={status} value={status}>{TASK_STATUS_LABEL[status]}</option>)}
          </select>
          <button className="btn btn-small btn-ghost" disabled={unavailable} onClick={onEdit} aria-label={`Edit ${task.title}`}>Edit</button>
          <button className="icon-btn" disabled={unavailable} onClick={onRemove} aria-label={`Remove ${task.title}`} title="Remove task"><Icon name="trash" size={14} /></button>
        </div>
      )}
    </article>
  );
}
