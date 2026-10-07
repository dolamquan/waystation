import { AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import { api, type Agent } from '../api.ts';
import { formatTokens, formatUsd, shortModel } from '../format.ts';
import { AgentAlert, AgentMeta } from './AgentMeta.tsx';
import { Confirm } from './Modal.tsx';
import { ModelPicker } from './ModelPicker.tsx';

interface AgentManageProps {
  readonly agent: Agent;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
}

type Panel = 'rename' | 'restart' | undefined;

/** Usage, the runaway guard, renaming, and Restart & continue, for the agent details drawer. */
export function AgentManage({ agent, notify }: AgentManageProps) {
  const [panel, setPanel] = useState<Panel>();
  const [name, setName] = useState(agent.name);
  const [model, setModel] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const vendor = agent.vendor === 'codex' ? 'codex' : 'claude';
  const canRestart = agent.tier === 'A' && !agent.inTerminal && !!agent.sessionId && agent.vendor !== 'other';

  const run = async (fn: () => Promise<unknown>, ok: string): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      notify(ok);
      return true;
    } catch (error) {
      notify((error as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = (next: Panel) => {
    setPanel(panel === next ? undefined : next);
    setName(agent.name);
    setModel('');
    setMessage('');
  };

  const usage = agent.usage;
  const guarded = agent.breaker !== undefined && agent.breaker.level !== 'ok';
  return (
    <section className="detail-manage" aria-label="Agent settings">
      <AgentMeta agent={agent} />
      {usage && (
        <p className="detail-usage-note">
          {usage.costUsd !== undefined ? `About ${formatUsd(usage.costUsd)} at list price` : 'No list price for this model'}
          {' · '}{formatTokens(usage.tokens.output)} output, {formatTokens(usage.tokens.input + usage.tokens.cacheRead + usage.tokens.cacheWrite5m + usage.tokens.cacheWrite1h)} input tokens
        </p>
      )}
      {(guarded || agent.lastError) && (
        <div className="detail-manage-alert">
          <AgentAlert agent={agent} />
          {guarded && (
            <button className="btn btn-small" disabled={busy} onClick={() => void run(() => api.resetBreaker(agent.id), 'Runaway guard cleared')}>
              Clear guard
            </button>
          )}
        </div>
      )}

      <div className="detail-manage-actions">
        <button className="btn btn-small" aria-expanded={panel === 'rename'} onClick={() => toggle('rename')}>Rename</button>
        {canRestart && <button className="btn btn-small" aria-expanded={panel === 'restart'} onClick={() => toggle('restart')}>Restart &amp; continue</button>}
      </div>

      {panel === 'rename' && (
        <form className="detail-manage-form" onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.rename(agent.id, name.trim()), name.trim() ? `Renamed to ${name.trim()}` : 'Name reset').then((ok) => { if (ok) setPanel(undefined); });
        }}>
          <label>Name
            <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="Leave empty to use the default name" />
          </label>
          <div className="detail-form-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setPanel(undefined)}>Cancel</button>
            <button type="submit" className="btn btn-go" disabled={busy}>Save name</button>
          </div>
        </form>
      )}

      {panel === 'restart' && (
        <form className="detail-manage-form" onSubmit={(e) => { e.preventDefault(); setConfirmRestart(true); }}>
          <p>Stops this agent and starts it again on the same conversation, so it keeps everything it knew. Optionally switch its model.</p>
          <div className="form-field">
            <span>Model</span>
            <ModelPicker key={vendor} vendor={vendor} value={model} onChange={setModel} emptyLabel={`Keep current (${shortModel(agent.model) ?? 'default'})`} />
          </div>
          <label>First message after the restart (optional)
            <textarea className="text-input" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Continue where you left off." />
          </label>
          <div className="detail-form-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setPanel(undefined)}>Cancel</button>
            <button type="submit" className="btn btn-go" disabled={busy}>{busy ? 'Restarting…' : 'Restart'}</button>
          </div>
        </form>
      )}

      <AnimatePresence>
        {confirmRestart && (
          <Confirm
            title={`Restart ${agent.name}?`}
            body="Its current turn is cancelled. It then picks the same conversation back up with your message."
            confirmLabel="Restart"
            onConfirm={() => void run(() => api.restart(agent.id, { model: model || undefined, message: message.trim() || undefined }), 'Restarted').then((ok) => { if (ok) setPanel(undefined); })}
            onClose={() => setConfirmRestart(false)}
          />
        )}
      </AnimatePresence>
    </section>
  );
}
