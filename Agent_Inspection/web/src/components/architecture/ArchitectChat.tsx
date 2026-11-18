import { useEffect, useRef, useState } from 'react';
import { api, request, type Agent, type AgentEvent, type PendingInterception } from '../../api.ts';
import { useProviders } from '../../useProviders.ts';
import type { ArchitectureSnapshot } from '../../../../shared/architecture.ts';
import { Icon } from '../Icon.tsx';
import { ModelPicker } from '../ModelPicker.tsx';
import { ArchitectTranscript, describeStep, toolNameOf, visiblePrompt } from './ArchitectTranscript.tsx';
import './architect-chat.css';

export type WorkflowSnapshot = ArchitectureSnapshot & { agent?: Agent; events?: AgentEvent[] };

const STARTER_PROMPTS = [
  { icon: 'shield', text: 'Add a human approval before the final response' },
  { icon: 'alert', text: 'Where could this workflow fail?' },
  { icon: 'book', text: 'Add a shared memory for the agents' },
  { icon: 'search', text: 'Give the agent web search and explain when it should use it' },
] as const;
const MAX_TEXTAREA_PX = 200;

type Props = {
  readonly snapshot: WorkflowSnapshot;
  readonly selection?: string;
  readonly selectionLabel?: string;
  readonly hidden: boolean;
  /** Held tool calls across the station; the panel shows the ones that belong to its architect session. */
  readonly pending?: readonly PendingInterception[];
  readonly onSnapshot: (next: WorkflowSnapshot) => void;
  readonly onOpenAgent: (id: string) => void;
};
type State = 'new' | 'ready' | 'thinking' | 'approval' | 'ended';
const STATE_LABEL: Record<State, string> = { new: 'Ready when you are', ready: 'Ready', thinking: 'Thinking', approval: 'Needs your approval', ended: 'Session ended' };

/** What a held architect call would do, in words: "Edit the workflow · 3 changes (add 2 steps, connect 1)". */
function heldSummary(item: PendingInterception): { title: string; detail?: string } {
  const title = `Allow the architect to ${describeStep(item.toolName).ask}`;
  if (toolNameOf(item.toolName) !== 'update_architecture') return { title };
  const ops = Array.isArray(item.input.operations) ? item.input.operations as { type?: string }[] : [];
  const verbs: Record<string, string> = { put_node: 'add or change a step', remove_node: 'remove a step', put_edge: 'connect steps', remove_edge: 'remove a connection', describe: 'rename the workflow' };
  const counts = new Map<string, number>(); for (const op of ops) { const v = verbs[op.type ?? ''] ?? 'change'; counts.set(v, (counts.get(v) ?? 0) + 1); }
  return { title, detail: ops.length ? `${ops.length} change${ops.length === 1 ? '' : 's'}: ${[...counts].map(([v, n]) => n > 1 ? `${v} ×${n}` : v).join(', ')}` : undefined };
}

function HeldCall({ item, onError }: { readonly item: PendingInterception; readonly onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false); const [denying, setDenying] = useState(false); const [reason, setReason] = useState('');
  const { title, detail } = heldSummary(item);
  const decide = async (decision: Parameters<typeof api.decide>[1]) => { setBusy(true); try { await api.decide(item.id, decision); } catch (e) { onError((e as Error).message); setBusy(false); } };
  return <div className="ac-held" role="group" aria-label="Approval needed">
    <div className="ac-held-head"><Icon name="shield" size={14} /><strong>{title}?</strong></div>
    {detail && <p>{detail}</p>}
    <details><summary>Show the exact request</summary><pre>{JSON.stringify(item.input, null, 2)}</pre></details>
    {denying
      ? <form className="ac-held-deny" onSubmit={e => { e.preventDefault(); void decide({ behavior: 'deny', message: reason.trim() || 'The operator declined this change.' }); }}>
        <label htmlFor={`deny-${item.id}`}>Tell the architect why (optional)</label>
        <input id={`deny-${item.id}`} className="text-input" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. keep the reviewer step" autoFocus />
        <div className="ac-held-actions"><button type="button" className="btn btn-small" onClick={() => setDenying(false)} disabled={busy}>Back</button><button className="btn btn-small" disabled={busy}>Decline</button></div>
      </form>
      : <div className="ac-held-actions"><button type="button" className="btn btn-small" onClick={() => setDenying(true)} disabled={busy}>Decline…</button><button type="button" className="btn btn-small btn-go" onClick={() => void decide({ behavior: 'allow' })} disabled={busy}><Icon name="check" size={14} />{busy ? 'Approving…' : 'Approve'}</button></div>}
  </div>;
}

/** The workflow architect conversation. Keyed by workflow id by its parent so drafts reset per workflow. */
export function ArchitectChat({ snapshot, selection, selectionLabel, hidden, pending = [], onSnapshot, onOpenAgent }: Props) {
  const providers = useProviders();
  const [vendor, setVendor] = useState('claude');
  const [model, setModel] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ text: string; at: number }>();
  const [chatError, setChatError] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const doc = snapshot.document;
  const url = `/api/architectures/${encodeURIComponent(doc.id)}`;
  const events = snapshot.events ?? [];
  const agent = snapshot.agent;
  const held = snapshot.agentId ? pending.find(p => p.agentId === snapshot.agentId) : undefined;
  const busy = !!agent && !['idle', 'stopped'].includes(agent.status);
  const canChoose = !agent || agent.status === 'stopped';
  const state: State = held ? 'approval' : sending || busy ? 'thinking' : !snapshot.agentId ? 'new' : agent?.status === 'stopped' || !agent ? 'ended' : 'ready';
  const lastEvent = events.at(-1);
  const thinking = state !== 'thinking' ? undefined : !agent || sending && !busy ? (snapshot.agentId ? 'Thinking…' : 'Starting your architect…') : lastEvent?.kind === 'tool_call' ? `${describeStep(lastEvent.summary).doing}…` : 'Thinking…';
  const providerLabel = providers.providers.find(p => p.id === vendor)?.label ?? vendor;

  // The optimistic bubble disappears once the daemon has recorded this prompt (a new session restarts the event list, so match the text).
  const recorded = !!sent && events.some(e => e.kind === 'prompt' && e.ts >= sent.at - 5000 && visiblePrompt(e.summary).replace(/\s+/g, ' ').trim() === sent.text.replace(/\s+/g, ' ').trim());
  useEffect(() => { if (recorded) setSent(undefined); }, [recorded]);
  useEffect(() => { const node = textarea.current; if (!node) return; node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_PX)}px`; node.style.overflowY = node.scrollHeight > MAX_TEXTAREA_PX ? 'auto' : 'hidden'; }, [text]);

  const send = async () => {
    const message = text.trim();
    if (!message || sending || busy) return;
    setSending(true); setChatError(''); setSent({ text: message, at: Date.now() }); setText(''); setModelOpen(false);
    try {
      await request('POST', `${url}/chat`, { text: message, vendor, model: model || undefined, selection });
      onSnapshot(await request<WorkflowSnapshot>('GET', url));
    } catch (e) { setChatError((e as Error).message); setSent(undefined); setText(message); }
    finally { setSending(false); }
  };
  const usePrompt = (prompt: string) => { setText(prompt); requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(prompt.length, prompt.length); }); };
  const stop = () => { if (snapshot.agentId) void api.interrupt(snapshot.agentId).catch(e => setChatError((e as Error).message)); };

  return <section className="arch-chat ac-panel" aria-label="Workflow architect" hidden={hidden}>
    <header className="ac-head">
      <span className={`ac-mark ac-${state}`} aria-hidden="true"><Icon name="sparkle" size={15} /></span>
      <div className="ac-head-text">
        <strong>Architect</strong>
        <span className={`ac-state ac-${state}`} role="status"><i aria-hidden="true" />{STATE_LABEL[state]}{agent && state !== 'new' ? ` · ${agent.vendor}` : ''}</span>
      </div>
      {snapshot.agentId && <button type="button" className="icon-btn ac-head-btn" onClick={() => onOpenAgent(snapshot.agentId!)} aria-label="Open architect session details" title="Session details"><Icon name="expand" size={14} /></button>}
    </header>
    <div className="ac-scope" title={`Workflow revision ${doc.revision}`}>
      <Icon name={selection ? 'cursor' : 'grid'} size={13} />
      <span>{selection ? <>Focused on <strong>{selectionLabel ?? 'the selection'}</strong></> : 'Sees the whole workflow'}</span>
    </div>

    {snapshot.agentId || sent
      ? <ArchitectTranscript events={events} pendingPrompt={recorded ? undefined : sent?.text} thinking={thinking} approval={held && <HeldCall key={held.id} item={held} onError={setChatError} />} />
      : <div className="ac-intro">
        <span className="ac-intro-mark" aria-hidden="true"><Icon name="sparkle" size={20} /></span>
        <h3>Design the workflow with the architect</h3>
        <p>Ask about handoffs, failure paths or a missing step. The architect reads the diagram before it changes anything, asks before every edit, and every change can be undone.</p>
        <ul className="ac-starters">{STARTER_PROMPTS.map(prompt => <li key={prompt.text}><button type="button" onClick={() => usePrompt(prompt.text)}><Icon name={prompt.icon} size={14} /><span>{prompt.text}</span><Icon name="arrow" size={13} /></button></li>)}</ul>
      </div>}

    <form className="ac-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
      {chatError && <p className="arch-error" role="alert">{chatError}</p>}
      <div className={`ac-box${busy || sending ? ' ac-box-busy' : ''}`}>
        <label htmlFor="arch-message" className="ac-visually-hidden">Message the architect</label>
        <textarea ref={textarea} id="arch-message" value={text} maxLength={12000} rows={1}
          placeholder={held ? 'Approve or decline above…' : busy ? 'Type your next message…' : 'Ask a question or describe a change…'}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
        <div className="ac-box-foot">
          {canChoose
            ? <button type="button" className="ac-chip" aria-expanded={modelOpen} aria-controls="ac-model" onClick={() => setModelOpen(o => !o)}><Icon name="activity" size={13} /><span>{providerLabel}{model ? ` · ${model}` : ''}</span><Icon name="chevronDown" size={12} /></button>
            : <span className="ac-chip ac-chip-static" title="The model is fixed for this session. End the session to switch."><Icon name="activity" size={13} /><span>{agent?.vendor}{agent?.model ? ` · ${agent.model}` : ''}</span></span>}
          <span className="ac-hint" aria-hidden="true"><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line</span>
          {busy
            ? <button type="button" className="ac-send ac-stop" onClick={stop} aria-label="Stop the architect" title="Stop"><span aria-hidden="true" /></button>
            : <button type="submit" className="ac-send" disabled={sending || !text.trim()} aria-label={sending ? 'Sending' : 'Send message'} title="Send"><Icon name="send" size={15} /></button>}
        </div>
        {modelOpen && canChoose && <div id="ac-model" className="ac-model">
          <label>Provider<select className="text-input" value={vendor} onChange={e => { setVendor(e.target.value); setModel(''); }}>{providers.providers.map(p => <option value={p.id} key={p.id} disabled={p.available === false}>{p.label}{p.available === false ? ' (unavailable)' : ''}</option>)}</select></label>
          <label>Model<ModelPicker key={vendor} vendor={vendor} value={model} onChange={setModel} /></label>
        </div>}
      </div>
    </form>
  </section>;
}
