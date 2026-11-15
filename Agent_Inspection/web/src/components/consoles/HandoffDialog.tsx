import { useState, type FormEvent } from 'react';
import { api, type ConsoleInfo } from '../../api.ts';
import { Modal } from '../Modal.tsx';

const MAX_TASK_CHARS = 4000;

type Props = {
  /** Running consoles that can hand off (any kind) or receive (agent consoles only). */
  readonly from: readonly ConsoleInfo[];
  readonly to: readonly ConsoleInfo[];
  readonly initialFrom?: string;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
  readonly onClose: () => void;
};

/**
 * Pass a task from one console to another. The receiving agent gets the task plus the giving console's recent
 * output as context, pasted into its prompt as one message.
 */
export function HandoffDialog({ from, to, initialFrom, notify, onClose }: Props) {
  const [source, setSource] = useState(initialFrom ?? from[0]?.id ?? '');
  const targets = to.filter((info) => info.id !== source);
  const [target, setTarget] = useState(targets[0]?.id ?? '');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const effectiveTarget = targets.some((info) => info.id === target) ? target : targets[0]?.id ?? '';
  const canSend = !busy && source !== '' && effectiveTarget !== '' && task.trim() !== '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    setBusy(true);
    try {
      notify((await api.handoffConsole(source, effectiveTarget, task.trim())).message);
      onClose();
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return <Modal title="Hand off a task" onClose={onClose}>
    <form onSubmit={(event) => void submit(event)}>
      <div className="modal-body handoff-form">
        <label>From
          <select className="text-input" value={source} onChange={(event) => setSource(event.target.value)}>
            {from.map((info) => <option key={info.id} value={info.id}>{info.name}</option>)}
          </select>
        </label>
        <label>To
          <select className="text-input" value={effectiveTarget} onChange={(event) => setTarget(event.target.value)} disabled={targets.length === 0}>
            {targets.map((info) => <option key={info.id} value={info.id}>{info.name}</option>)}
          </select>
        </label>
        {targets.length === 0 && <p className="console-note">Open another Claude Code or Codex console to hand a task to.</p>}
        <label>Task
          <textarea className="text-input" rows={4} maxLength={MAX_TASK_CHARS} value={task} placeholder="e.g. Write tests for the parser changes"
            onChange={(event) => setTask(event.target.value)} />
        </label>
        <p className="console-note">The task and the last lines the giving console printed are pasted into the receiving agent’s prompt and sent.</p>
      </div>
      <footer className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-go" disabled={!canSend}>{busy ? 'Handing off…' : 'Hand off'}</button>
      </footer>
    </form>
  </Modal>;
}
