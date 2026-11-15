import { useEffect, useState, type MouseEvent } from 'react';
import { api, type Agent, type PendingInterception } from '../api.ts';
import { approvalView, describePending, pendingSummary } from './stationEvents.ts';

export type Notify = (text: string, kind?: 'ok' | 'error') => void;
export const DENY_MESSAGE = 'Denied from the station.';
/** A panel that just appeared (e.g. the previous call was decided elsewhere) ignores clicks briefly, so a click meant for the old one cannot approve the new one. */
const ARM_DELAY_MS = 450;
const DEMO_NOTE = 'Sample crew: nothing to approve here. Live sessions get these buttons for real.';

interface StationApprovalProps {
  readonly agent: Agent;
  readonly item: PendingInterception;
  /** AskUserQuestion: answers need the full panel, so only the open link is offered. */
  readonly question?: boolean;
  readonly demo?: boolean;
  readonly notify?: Notify;
  readonly onSelect?: (id: string) => void;
}

/** A held tool call inside its agent's node: what it wants, plus Approve / Deny / Open. */
export function StationApproval({ agent, item, question = false, demo = false, notify, onSelect }: StationApprovalProps) {
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  const plain = question ? 'Has a question for you' : describePending(item);
  const view = question ? { lines: [], oneClick: false } : approvalView(item);
  const locked = busy || !armed;
  const decide = async (decision: Parameters<typeof api.decide>[1], done: string) => {
    if (demo) { notify?.(DEMO_NOTE); return; }
    setBusy(true);
    try {
      await api.decide(item.id, decision);
      notify?.(done);
    } catch (error) {
      notify?.((error as Error).message, 'error');
      setBusy(false);
    }
  };
  const press = (action: () => void) => (event: MouseEvent) => { event.stopPropagation(); action(); };
  const open = () => onSelect?.(agent.id);
  const approve = () => void decide({ behavior: 'allow' }, 'Approved');
  const deny = () => void decide({ behavior: 'deny', message: DENY_MESSAGE }, 'Denied');
  return (
    <div className="node-approval" role="group" aria-label={`${agent.name} is waiting for approval: ${pendingSummary(item)}`} title={`${agent.name} wants approval\n${pendingSummary(item)}`} onClick={event => event.stopPropagation()}>
      <div className="node-approval-head"><span className="node-approval-kind">{question ? 'Question' : 'Approval'}</span><span className="node-approval-text">{plain}</span></div>
      {view.lines.length > 0 && <pre className="node-approval-code">{view.lines.join('\n')}</pre>}
      <div className="node-approval-actions">
        {question
          ? <button className="node-btn node-btn-primary" onClick={press(open)} aria-label={`Open ${agent.name} to answer its question`}>Answer in panel</button>
          : view.oneClick ? <>
            <button className="node-btn node-btn-primary" disabled={locked} onClick={press(approve)} aria-label={`Approve: ${pendingSummary(item)}`}>Approve</button>
            <button className="node-btn node-btn-danger" disabled={locked} onClick={press(deny)} aria-label={`Deny: ${pendingSummary(item)}`}>Deny</button>
            <button className="node-btn" onClick={press(open)} aria-label={`Open full controls for ${agent.name}`}>Open</button>
          </> : <>
            <button className="node-btn node-btn-primary" onClick={press(open)} aria-label={`Review the full call from ${agent.name} before approving`}>Review in panel</button>
            <button className="node-btn node-btn-danger" disabled={locked} onClick={press(deny)} aria-label={`Deny: ${pendingSummary(item)}`}>Deny</button>
          </>}
      </div>
    </div>
  );
}
