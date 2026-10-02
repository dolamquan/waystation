import { useState } from 'react';
import { api } from '../api.ts';
import { Modal } from './Modal.tsx';

interface NewAgentDialogProps {
  readonly defaultCwd?: string;
  readonly onClose: () => void;
  readonly onLaunched: (agentId: string) => void;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
}

export function NewAgentDialog({ defaultCwd, onClose, onLaunched, notify }: NewAgentDialogProps) {
  const [vendor, setVendor] = useState<'claude' | 'codex'>('claude');
  const [cwd, setCwd] = useState(defaultCwd ?? '');
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [intercept, setIntercept] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { agent } = await api.launch({ vendor, cwd: cwd.trim(), prompt, name: name || undefined, intercept: vendor === 'claude' && intercept });
      notify(`Launched ${agent.name}`);
      onLaunched(agent.id);
      onClose();
    } catch (error) {
      notify((error as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <Modal title="Launch a new agent" onClose={onClose}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <div className="segmented" role="radiogroup" aria-label="Agent type">
          {(['claude', 'codex'] as const).map((v) => (
            <button type="button" key={v} role="radio" aria-checked={vendor === v} className={vendor === v ? 'seg-on' : ''} onClick={() => setVendor(v)}>
              {v === 'claude' ? 'Claude (Agent SDK)' : 'Codex (codex exec)'}
            </button>
          ))}
        </div>
        <label>Project folder (absolute path)
          <input className="text-input" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="C:\\Users\\you\\project" required />
        </label>
        <label>Name (optional)
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Test fixer" />
        </label>
        <label>Task
          <textarea className="text-input" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} required placeholder="What should this agent do?" />
        </label>
        {vendor === 'claude' && (
          <label className="check">
            <input type="checkbox" checked={intercept} onChange={(e) => setIntercept(e.target.checked)} />
            Start in Intercept mode (approve each tool call that needs permission)
          </label>
        )}
        <footer className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-go" disabled={busy}>{busy ? 'Launching…' : 'Launch'}</button>
        </footer>
      </form>
    </Modal>
  );
}
