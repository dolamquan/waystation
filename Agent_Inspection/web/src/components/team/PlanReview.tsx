import { useState } from 'react';
import { api, type TaskPatch, type TeamTask, type TeamView } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { TaskEditor } from './TaskEditor.tsx';
import { findMember, leadOf, plural, type RunAction } from './teamUi.ts';

interface PlanReviewProps {
  readonly team: TeamView;
  readonly unavailable: boolean;
  readonly busy?: string;
  readonly run: RunAction;
  readonly onFeedback: () => void;
}

/** While the lead plans: a calm notice. Once it submits: the drafted tasks, with approve, edit and feedback. */
export function PlanReview({ team, unavailable, busy, run, onFeedback }: PlanReviewProps) {
  const [editing, setEditing] = useState<string>();
  const lead = leadOf(team)?.name ?? 'The lead';

  if (team.status === 'planning') {
    return (
      <section className="team-plan team-plan-drafting" aria-label="Plan in progress">
        <Icon name="list" size={18} />
        <div>
          <strong>{lead} is drafting a plan</strong>
          <p>Workers start once you approve it. {team.tasks.length ? `${plural(team.tasks.length, 'task')} drafted so far.` : 'Drafted tasks will appear here and on the board.'}</p>
        </div>
      </section>
    );
  }
  if (team.status !== 'plan_review') return null;

  const save = (task: TeamTask, patch: TaskPatch) => void run(`task:${task.id}`, async () => {
    await api.updateTask(team.id, task.id, patch);
    setEditing(undefined);
  }, 'Task updated.');
  const approve = () => void run('approve', () => api.approvePlan(team.id), 'Plan approved. Assigned members are starting their work.');

  return (
    <section className="team-plan" aria-labelledby="team-plan-title">
      <div className="team-plan-head">
        <div>
          <h3 id="team-plan-title"><Icon name="check" size={17} />Plan ready for review</h3>
          <p>{lead} drafted {plural(team.tasks.length, 'task')}. Edit anything that looks off, then approve to start the workers, or send the lead feedback to revise it.</p>
        </div>
        <div className="team-plan-actions">
          <button className="btn btn-small" disabled={unavailable} onClick={onFeedback}><Icon name="message" size={14} />Send feedback to lead</button>
          <button className="btn btn-small btn-go" disabled={unavailable || team.tasks.length === 0} onClick={approve}><Icon name="check" size={14} />{busy === 'approve' ? 'Approving…' : 'Approve plan'}</button>
        </div>
      </div>
      <ol className="team-plan-tasks">
        {team.tasks.map((task) => (
          <li key={task.id}>
            {editing === task.id
              ? <TaskEditor team={team} task={task} compact disabled={unavailable} onSave={(patch) => save(task, patch)} onCancel={() => setEditing(undefined)} />
              : <PlanTask team={team} task={task} unavailable={unavailable} onEdit={() => setEditing(task.id)} />}
          </li>
        ))}
      </ol>
    </section>
  );
}

function PlanTask({ team, task, unavailable, onEdit }: { team: TeamView; task: TeamTask; unavailable: boolean; onEdit: () => void }) {
  const assignee = findMember(team, task.assignee);
  return (
    <div className="team-plan-task">
      <div>
        <strong>{task.title}</strong>
        {task.details && <p>{task.details}</p>}
      </div>
      <span className="session-task-assignee"><Icon name="crew" size={13} />{assignee?.name ?? 'Unassigned'}</span>
      <button className="btn btn-small btn-ghost" disabled={unavailable} onClick={onEdit} aria-label={`Edit ${task.title}`}>Edit</button>
    </div>
  );
}
