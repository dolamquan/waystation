import { motion, AnimatePresence } from 'framer-motion';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, type Agent, type PendingInterception } from '../api.ts';
import { isTypingTarget } from '../triage.ts';

interface ApprovalPanelProps {
  readonly pending: PendingInterception[];
  readonly agents: Agent[];
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
  /** The item the keyboard triage moved to (N / Shift+N): it takes focus, and its letter keys work. */
  readonly focusedId?: string;
}

/** Moves DOM focus to the article when triage selects it, so its own key handler receives keys. */
function useTriageFocus(focused: boolean) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focused || !ref.current) return;
    ref.current.focus({ preventScroll: true });
    ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);
  return ref;
}

/** Plain letter and digit keys only: no modifiers, and never while typing in a field. */
const isCommandKey = (event: KeyboardEvent): boolean =>
  !event.ctrlKey && !event.metaKey && !event.altKey && !isTypingTarget(event.target);

/** Tool calls held by Intercept mode, waiting for a human decision. */
export function ApprovalPanel({ pending, agents, notify, focusedId }: ApprovalPanelProps) {
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
          <h2 className="approvals-title"><span className="dot-alert" /> {pending.length} {pending.length > 1 ? 'items' : 'item'} waiting for you</h2>
          <AnimatePresence initial={false}>
            {pending.map((item) => item.toolName === ASK_TOOL
              ? <QuestionItem key={item.id} item={item} agent={agents.find((a) => a.id === item.agentId)} notify={notify} focused={item.id === focusedId} />
              : <ApprovalItem key={item.id} item={item} agent={agents.find((a) => a.id === item.agentId)} notify={notify} focused={item.id === focusedId} />)}
          </AnimatePresence>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

/** Claude Code's "ask the user" tool: managed agents ask here, since they have no terminal. */
const ASK_TOOL = 'AskUserQuestion';
const OTHER = '__other__';

interface Question {
  readonly question: string;
  readonly header?: string;
  readonly multiSelect?: boolean;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
}

function questionsOf(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  return raw.flatMap((q): Question[] => {
    const question = q as Partial<Question>;
    if (typeof question.question !== 'string') return [];
    const options = Array.isArray(question.options) ? question.options.filter((o) => typeof o?.label === 'string') : [];
    return [{ question: question.question, header: question.header, multiSelect: question.multiSelect === true, options }];
  });
}

/** One agent question, answered by picking options (or typing another answer). */
function QuestionItem({ item, agent, notify, focused }: ApprovalItemProps) {
  const ref = useTriageFocus(focused);
  const questions = questionsOf(item.input);
  const [picked, setPicked] = useState<Record<string, readonly string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const toggle = (q: Question, label: string) => setPicked((prev) => {
    const current = prev[q.question] ?? [];
    const next = q.multiSelect
      ? (current.includes(label) ? current.filter((l) => l !== label) : [...current, label])
      : [label];
    return { ...prev, [q.question]: next };
  });

  const answerFor = (q: Question): string => (picked[q.question] ?? [])
    .map((label) => (label === OTHER ? (other[q.question] ?? '').trim() : label))
    .filter(Boolean)
    .join(', ');
  const complete = questions.length > 0 && questions.every((q) => answerFor(q));

  const send = async (decision: Parameters<typeof api.decide>[1], done: string) => {
    setBusy(true);
    try {
      await api.decide(item.id, decision);
      notify(done);
    } catch (error) {
      notify((error as Error).message, 'error');
      setBusy(false);
    }
  };

  const submit = () => {
    const answers = Object.fromEntries(questions.map((q) => [q.question, answerFor(q)]));
    void send({ behavior: 'allow', updatedInput: { ...item.input, answers } }, 'Answer sent');
  };

  // 1-9 pick an option of the first unanswered question (the last number is "Other"); Enter sends.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (busy || !isCommandKey(event)) return;
    if (event.key === 'Enter' && complete) { event.preventDefault(); submit(); return; }
    const index = Number(event.key) - 1;
    const target = questions.find((q) => !answerFor(q)) ?? questions[0];
    if (!target || !Number.isInteger(index) || index < 0) return;
    const labels = [...target.options.map((option) => option.label), OTHER];
    if (index >= labels.length) return;
    event.preventDefault();
    toggle(target, labels[index]);
  };

  return (
    <motion.article ref={ref} tabIndex={-1} onKeyDown={onKeyDown} data-triage={`pending:${item.id}`} layout className={`approval approval-question ${focused ? 'approval-focused' : ''}`} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}>
      <header className="approval-head">
        <strong>Question from {agent?.name ?? item.agentId}</strong>
        <span className="muted"> · {agent?.project ?? ''}</span>
      </header>
      {questions.map((q) => (
        <fieldset key={q.question} className="question">
          <legend>{q.header && <span className="question-chip">{q.header}</span>}{q.question}</legend>
          <div className="question-options">
            {[...q.options, { label: OTHER, description: 'Type your own answer' }].map((option, index) => {
              const on = (picked[q.question] ?? []).includes(option.label);
              return (
                <button type="button" key={option.label} className={`question-option ${on ? 'question-option-on' : ''}`} aria-pressed={on} onClick={() => toggle(q, option.label)} disabled={busy}>
                  <strong>{focused && index < 9 && <kbd className="key-hint">{index + 1}</kbd>}{option.label === OTHER ? 'Other' : option.label}</strong>
                  {option.description && <small>{option.description}</small>}
                </button>
              );
            })}
          </div>
          {(picked[q.question] ?? []).includes(OTHER) && (
            <input className="text-input" value={other[q.question] ?? ''} onChange={(e) => setOther((prev) => ({ ...prev, [q.question]: e.target.value }))} placeholder="Your answer" aria-label={`Your answer to: ${q.question}`} autoFocus />
          )}
        </fieldset>
      ))}
      <div className="approval-actions">
        <button className="btn btn-go" disabled={busy || !complete} onClick={submit}>Send answer</button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => void send({ behavior: 'deny', message: 'The operator chose not to answer. Use your best judgement and say which option you chose.' }, 'Skipped; the agent will decide')}>Let the agent decide</button>
      </div>
    </motion.article>
  );
}

interface ApprovalItemProps {
  readonly item: PendingInterception;
  readonly agent: Agent | undefined;
  readonly notify: ApprovalPanelProps['notify'];
  readonly focused: boolean;
}

function ApprovalItem({ item, agent, notify, focused }: ApprovalItemProps) {
  const ref = useTriageFocus(focused);
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
  const approve = () => void run(() => api.decide(item.id, { behavior: 'allow' }), 'Approved');
  const deny = () => void run(() => api.decide(item.id, { behavior: 'deny', message: reason || 'Denied by the operator.' }), 'Denied');
  const cancel = () => { setMode('view'); ref.current?.focus({ preventScroll: true }); };
  const letterActions: Record<string, () => void> = { a: approve, e: () => setMode('edit'), d: () => setMode('deny') };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (busy) return;
    if (event.key === 'Escape' && mode !== 'view') { event.preventDefault(); cancel(); return; }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && mode !== 'view') {
      event.preventDefault();
      if (mode === 'edit') approveEdited(); else deny();
      return;
    }
    if (mode !== 'view' || !isCommandKey(event)) return;
    const action = letterActions[event.key.toLowerCase()];
    if (!action) return;
    event.preventDefault();
    action();
  };

  return (
    <motion.article ref={ref} tabIndex={-1} onKeyDown={onKeyDown} data-triage={`pending:${item.id}`} layout className={`approval ${focused ? 'approval-focused' : ''}`} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}>
      <header className="approval-head">
        <strong>{item.toolName}</strong>
        <span className="muted"> · {agent?.name ?? item.agentId} · {agent?.project ?? ''}</span>
      </header>
      {mode === 'edit' ? (
        <textarea className="code-input" value={edited} onChange={(e) => setEdited(e.target.value)} rows={8} spellCheck={false} aria-label="Edit tool input JSON" autoFocus={focused} />
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
            <button className="btn btn-go" disabled={busy} onClick={approve}>{focused && <kbd className="key-hint">A</kbd>}Approve</button>
            <button className="btn" disabled={busy} onClick={() => setMode('edit')}>{focused && <kbd className="key-hint">E</kbd>}Edit input</button>
            <button className="btn btn-danger" disabled={busy} onClick={() => setMode('deny')}>{focused && <kbd className="key-hint">D</kbd>}Deny + instruct</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => api.decide(item.id, { behavior: 'ask' }), 'Handed back to the agent\'s own prompt')}>Let agent ask</button>
          </>
        )}
        {mode === 'edit' && (
          <>
            <button className="btn btn-go" disabled={busy} onClick={approveEdited}>Approve edited{focused && <kbd className="key-hint key-hint-after">Ctrl Enter</kbd>}</button>
            <button className="btn btn-ghost" onClick={cancel}>Cancel</button>
          </>
        )}
        {mode === 'deny' && (
          <>
            <button className="btn btn-danger" disabled={busy} onClick={deny}>Deny{focused && <kbd className="key-hint key-hint-after">Ctrl Enter</kbd>}</button>
            <button className="btn btn-ghost" onClick={cancel}>Cancel</button>
          </>
        )}
      </div>
    </motion.article>
  );
}
