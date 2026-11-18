import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentEvent } from '../../api.ts';
import { MessageText } from '../ActivityFeed.tsx';
import { Icon } from '../Icon.tsx';

/** Human wording for the architect's tool calls. Raw MCP names (mcp__waystation__update_architecture) are noise. */
const TOOL_LABELS: Record<string, [done: string, doing: string, ask: string]> = {
  get_architecture: ['Read the workflow', 'Reading the workflow', 'read the workflow'],
  list_architectures: ['Listed workflows', 'Looking at your workflows', 'list your workflows'],
  update_architecture: ['Edited the workflow', 'Editing the workflow', 'edit the workflow'],
  get_sketch: ['Read the planning sketch', 'Reading the planning sketch', 'read the planning sketch'],
  update_sketch: ['Updated the planning sketch', 'Updating the planning sketch', 'update the planning sketch'],
  get_workspace: ['Checked the workspace', 'Checking the workspace', 'check the workspace'],
  list_files: ['Listed project files', 'Looking through project files', 'list project files'],
  open_file: ['Opened a file', 'Opening a file', 'open a file'],
};
/** "⏸ mcp__waystation__get_architecture: abc" → "get_architecture"; "Read: src/x.ts" → "Read". */
export function toolNameOf(summary: string): string {
  const head = summary.replace(/^⏸\s*/, '').split(':')[0].trim();
  const parts = head.split('__');
  return parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join('__') : head;
}
export function describeStep(summary: string): { done: string; doing: string; ask: string } {
  const name = toolNameOf(summary);
  const known = TOOL_LABELS[name];
  if (known) return { done: known[0], doing: known[1], ask: known[2] };
  const readable = name.replace(/[_-]+/g, ' ').trim() || 'a tool';
  return { done: `Used ${readable}`, doing: `Using ${readable}`, ask: `use ${readable}` };
}

/** What you typed, without the context line the daemon adds for the model. */
export const visiblePrompt = (summary: string) => summary.replace(/^Current workflow: \S+?\.? Read its latest graph with get_architecture before responding\.\s*(?:Selected element id \(design context\): \S+\s*)?/, '').trimStart();

type Step = { label: string; failed: boolean };
type Item =
  | { kind: 'prompt' | 'assistant' | 'error'; key: string; text: string; ts: number }
  | { kind: 'steps'; key: string; steps: Step[] };

/** Groups consecutive tool events into one quiet "steps" row so the conversation reads as a conversation. */
function group(events: readonly AgentEvent[]): Item[] {
  const items: Item[] = [];
  events.forEach((event, index) => {
    if (event.kind === 'tool_call' || event.kind === 'tool_result') {
      let last = items.at(-1);
      if (last?.kind !== 'steps') { if (event.kind === 'tool_result') return; last = { kind: 'steps', key: `s${index}`, steps: [] }; items.push(last); }
      if (event.kind === 'tool_call') last.steps.push({ label: describeStep(event.summary).done, failed: false });
      else if (/fail|error|denied/i.test(event.summary) && last.steps.length) last.steps[last.steps.length - 1].failed = true;
      return;
    }
    if (event.kind === 'prompt' || event.kind === 'assistant' || event.kind === 'error') items.push({ kind: event.kind, key: `${event.kind}${index}`, text: event.kind === 'prompt' ? visiblePrompt(event.summary) : event.summary, ts: event.ts });
  });
  return items;
}

function Steps({ steps }: { readonly steps: readonly Step[] }) {
  const [open, setOpen] = useState(false);
  const counts = new Map<string, number>(); for (const s of steps) counts.set(s.label, (counts.get(s.label) ?? 0) + 1);
  const summary = [...counts].map(([label, n]) => n > 1 ? `${label} ×${n}` : label);
  const failed = steps.some(s => s.failed);
  const expandable = steps.length > 1;
  const label = <><Icon name={failed ? 'alert' : 'check'} size={13} /><span>{summary.slice(0, 2).join(' · ')}{summary.length > 2 ? ` · ${summary.length - 2} more` : ''}</span></>;
  return <li className={`ac-steps${failed ? ' failed' : ''}`}>
    {expandable ? <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)}>{label}<Icon name="chevronDown" size={13} /></button> : <div className="ac-step-line">{label}</div>}
    {open && <ol>{steps.map((s, i) => <li key={i} className={s.failed ? 'failed' : undefined}>{s.label}{s.failed ? ' (failed)' : ''}</li>)}</ol>}
  </li>;
}

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * The architect conversation: your messages as bubbles, the architect's replies as text, tool work as quiet
 * step rows, and a live "answering" bubble while the model works. Follows new content unless you scroll up.
 */
export function ArchitectTranscript({ events, pendingPrompt, thinking, approval }: {
  readonly events: readonly AgentEvent[]; readonly pendingPrompt?: string;
  readonly thinking?: string; readonly approval?: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  // A trailing call with no result is still in flight: the typing bubble or approval card describes it, not a done row.
  const items = group(events.at(-1)?.kind === 'tool_call' ? events.slice(0, -1) : events);
  const toLatest = () => { const node = viewport.current; if (node) node.scrollTop = node.scrollHeight; following.current = true; setAway(false); };
  useLayoutEffect(() => { if (following.current) toLatest(); }, [events.length, pendingPrompt, thinking, approval]);
  useEffect(() => {
    const node = viewport.current; if (!node) return;
    const observer = new ResizeObserver(() => { if (following.current) node.scrollTop = node.scrollHeight; });
    observer.observe(node); if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return <div className="ac-transcript">
    <div ref={viewport} className="ac-scroll" tabIndex={0} aria-label="Conversation with the architect" onScroll={() => {
      const node = viewport.current; if (!node) return;
      following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; setAway(!following.current);
    }}>
      <ol className="ac-messages" role="log" aria-live="polite" aria-relevant="additions">
        {items.map(item => item.kind === 'steps' ? <Steps key={item.key} steps={item.steps} />
          : item.kind === 'prompt'
            ? <li key={item.key} className="ac-you"><div className="ac-bubble"><MessageText text={item.text} /></div><time dateTime={new Date(item.ts).toISOString()}>{time(item.ts)}</time></li>
            : <li key={item.key} className={item.kind === 'error' ? 'ac-reply ac-failed' : 'ac-reply'}>
              <span className="ac-avatar" aria-hidden="true"><Icon name={item.kind === 'error' ? 'alert' : 'sparkle'} size={13} /></span>
              <div className="ac-reply-body"><div className="ac-reply-meta"><strong>{item.kind === 'error' ? 'Something went wrong' : 'Architect'}</strong><time dateTime={new Date(item.ts).toISOString()}>{time(item.ts)}</time></div><div className="ac-reply-text"><MessageText text={item.text} /></div></div>
            </li>)}
        {pendingPrompt && <li className="ac-you ac-sending"><div className="ac-bubble"><MessageText text={pendingPrompt} /></div><span className="ac-sent-label">Sending…</span></li>}
        {approval && <li className="ac-reply ac-approval-row">{approval}</li>}
        {thinking && !approval && <li className="ac-reply ac-thinking">
          <span className="ac-avatar" aria-hidden="true"><Icon name="sparkle" size={13} /></span>
          <div className="ac-typing" role="status"><span className="ac-dots" aria-hidden="true"><i /><i /><i /></span><span>{thinking}</span></div>
        </li>}
      </ol>
    </div>
    {away && <button type="button" className="ac-latest" onClick={toLatest}>Latest<Icon name="chevronDown" size={13} /></button>}
  </div>;
}
