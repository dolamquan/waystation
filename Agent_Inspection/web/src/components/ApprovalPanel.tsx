import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import { api, type Agent, type PendingInterception } from '../api.ts';

interface ApprovalPanelProps {
  readonly pending: PendingInterception[];
  readonly agents: Agent[];
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
}

/** Tool calls held by Intercept mode, waiting for a human decision. */
export function ApprovalPanel({ pending, agents, notify }: ApprovalPanelProps) {
  return (
    <AnimatePresence>
      {pending.length > 0 && (
        <motion.section
          className="approvals"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          aria-label="Pending approvals"
        >
          <h2 className="approvals-title"><span className="dot-alert" /> {pending.length} tool call{pending.length > 1 ? 's' : ''} waiting for you</h2>
          <AnimatePresence initial={false}>
            {pending.map((item) => (
              <ApprovalItem key={item.id} item={item} agent={agents.find((a) => a.id === item.agentId)} notify={notify} />
            ))}
          </AnimatePresence>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

interface ApprovalItemProps {
  readonly item: PendingInterception;
  readonly agent: Agent | undefined;
  readonly notify: ApprovalPanelProps['notify'];
}

function ApprovalItem({ item, agent, notify }: ApprovalItemProps) {
  const [mode, setMode] = useState<'view' | 'edit' | 'deny'>('view');
  const [edited, setEdited] = useState(() => JSON.stringify(item.input, null, 2));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      notify(done);
    } catch (error) {
      notify((error as Error).message, 'error');
      setBusy(false);
    }
  };

  const approveEdited = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(edited);
    } catch {
      notify('Edited input is not valid JSON.', 'error');
      return;
    }
    void run(() => api.decide(item.id, { behavior: 'allow', updatedInput: parsed }), 'Approved with edits');
  };

  return (
    <motion.article layout className="approval" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}>
      <header className="approval-head">
        <strong>{item.toolName}</strong>
        <span className="muted"> · {agent?.name ?? item.agentId} · {agent?.project ?? ''}</span>
      </header>
      {mode === 'edit' ? (
        <textarea className="code-input" value={edited} onChange={(e) => setEdited(e.target.value)} rows={8} spellCheck={false} aria-label="Edit tool input JSON" />
      ) : (
        <pre className="code-view">{JSON.stringify(item.input, null, 2)}</pre>
      )}
      {mode === 'deny' && (
        <textarea
          className="text-input"
          placeholder="Tell the agent what to do instead (it receives this as the reason)…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          autoFocus
          aria-label="Instruction for the agent"
        />
      )}
      <div className="approval-actions">
        {mode === 'view' && (
          <>
            <button className="btn btn-go" disabled={busy} onClick={() => void run(() => api.decide(item.id, { behavior: 'allow' }), 'Approved')}>Approve</button>
            <button className="btn" disabled={busy} onClick={() => setMode('edit')}>Edit input</button>
            <button className="btn btn-danger" disabled={busy} onClick={() => setMode('deny')}>Deny + instruct</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => api.decide(item.id, { behavior: 'ask' }), 'Handed back to the agent\'s own prompt')}>Let agent ask</button>
          </>
        )}
        {mode === 'edit' && (
          <>
            <button className="btn btn-go" disabled={busy} onClick={approveEdited}>Approve edited</button>
            <button className="btn btn-ghost" onClick={() => setMode('view')}>Cancel</button>
          </>
        )}
        {mode === 'deny' && (
          <>
            <button className="btn btn-danger" disabled={busy} onClick={() => void run(() => api.decide(item.id, { behavior: 'deny', message: reason || 'Denied by the operator.' }), 'Denied')}>Deny</button>
            <button className="btn btn-ghost" onClick={() => setMode('view')}>Cancel</button>
          </>
        )}
      </div>
    </motion.article>
  );
}
