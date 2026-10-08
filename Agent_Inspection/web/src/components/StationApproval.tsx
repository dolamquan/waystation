import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { api, type Agent, type PendingInterception } from '../api.ts';
import { approvalView, clip, describePending, pendingSummary } from './stationEvents.ts';

export type Notify = (text: string, kind?: 'ok' | 'error') => void;
export const DENY_MESSAGE = 'Denied from the station.';
/** A bubble that just appeared (e.g. the previous call was decided elsewhere) ignores clicks briefly, so a click meant for the old one cannot approve the new one. */
const ARM_DELAY_MS = 450;
const LINE_HEIGHT = 10;
const DEMO_NOTE = 'Sample crew: nothing to approve here. Live sessions get these buttons for real.';

interface StationApprovalProps {
  readonly agent: Agent;
  readonly item: PendingInterception;
  /** AskUserQuestion: answers need the full panel, so only the open link is offered. */
  readonly question?: boolean;
  readonly x: number;
  readonly y: number;
  readonly demo?: boolean;
  readonly notify?: Notify;
  readonly onSelect?: (id: string) => void;
}

/** A small SVG button: keyboard reachable, and it never also selects the desk underneath. */
function BubbleButton({ x, width, label, text, tone, disabled, onPress }: { x: number; width: number; label: string; text: string; tone: 'go' | 'deny' | 'link'; disabled?: boolean; onPress: () => void }) {
  const press = (e: MouseEvent | KeyboardEvent) => { e.stopPropagation(); if (!disabled) onPress(); };
  return (
    <g className={`station-approval-btn station-approval-${tone} ${disabled ? 'station-approval-busy' : ''}`} transform={`translate(${x} 0)`} role="button" tabIndex={0} aria-label={label} aria-disabled={disabled || undefined}
      onClick={press} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); press(e); } else e.stopPropagation(); }}>
      <rect width={width} height="17" rx="5" />
      <text x={width / 2} y="11.5" textAnchor="middle" fontSize="8.5" fontWeight="600">{text}</text>
    </g>
  );
}

/** A speech bubble over a desk with a held tool call: what it wants, plus Approve / Deny / Open. */
export function StationApproval({ agent, item, question = false, x, y, demo = false, notify, onSelect }: StationApprovalProps) {
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  const plain = question ? 'Has a question for you' : describePending(item);
  const view = question ? { lines: [], oneClick: false } : approvalView(item);
  // Room for the command text, plus a little padding above the buttons.
  const lift = view.lines.length ? view.lines.length * LINE_HEIGHT + 6 : 0;
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
  const open = () => onSelect?.(agent.id);
  return (
    <g className="station-approval" transform={`translate(${x} ${y})`} role="group" aria-label={`${agent.name} is waiting for approval: ${pendingSummary(item)}`} onClick={e => e.stopPropagation()}>
      <title>{`${agent.name} wants approval\n${pendingSummary(item)}`}</title>
      <rect x="-92" y={-58 - lift} width="184" height={54 + lift} rx="9" fill="#fff4dc" stroke="#b98d52" strokeWidth="1.5" />
      <path d="m-6-5 6 8 6-8" fill="#fff4dc" stroke="#b98d52" strokeWidth="1.5" strokeLinejoin="round" /><path d="M-7-5.5h14" stroke="#fff4dc" strokeWidth="2.5" />
      <g transform={`translate(0 ${-lift})`}>
      <text x="-82" y="-44" fill="#9a6a33" fontSize="7.5" fontWeight="700" letterSpacing=".04em">{question ? 'QUESTION' : 'NEEDS YOUR OK'}</text>
      <text x="-82" y="-32" fill="#5b4128" fontSize="9.5" fontWeight="600">{clip(plain, 34)}</text>
      </g>
      {view.lines.map((line, i) => <text key={i} x="-82" y={-26 - lift + 9 + i * LINE_HEIGHT} fill="#3f2f22" fontSize="7.6" fontFamily="var(--mono)" xmlSpace="preserve">{line || ' '}</text>)}
      <g transform="translate(-82 -26)">
        {question
          ? <BubbleButton x={0} width={164} tone="go" text="Answer in the panel" label={`Open ${agent.name} to answer its question`} onPress={open} />
          : view.oneClick ? <>
            <BubbleButton x={0} width={52} tone="go" text="Approve" label={`Approve: ${pendingSummary(item)}`} disabled={locked} onPress={() => void decide({ behavior: 'allow' }, 'Approved')} />
            <BubbleButton x={56} width={44} tone="deny" text="Deny" label={`Deny: ${pendingSummary(item)}`} disabled={locked} onPress={() => void decide({ behavior: 'deny', message: DENY_MESSAGE }, 'Denied')} />
            <BubbleButton x={104} width={60} tone="link" text="Open →" label={`Open full controls for ${agent.name}`} onPress={open} />
          </> : <>
            <BubbleButton x={0} width={44} tone="deny" text="Deny" label={`Deny: ${pendingSummary(item)}`} disabled={locked} onPress={() => void decide({ behavior: 'deny', message: DENY_MESSAGE }, 'Denied')} />
            <BubbleButton x={48} width={116} tone="go" text="Review in panel →" label={`Review the full call from ${agent.name} before approving`} onPress={open} />
          </>}
      </g>
    </g>
  );
}
