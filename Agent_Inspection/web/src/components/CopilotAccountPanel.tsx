import { useCallback, useEffect, useState } from 'react';
import { request } from '../api.ts';
import type { CopilotAccountView } from '../../../daemon/managed/copilotAccount.ts';
import { Icon } from './Icon.tsx';

type LoginStep = { kind: 'open-url'; url: string } | { kind: 'input-required'; prompt: string } | { kind: 'awaiting' | 'needs-interaction' } | { kind: 'completed'; result: { status: string } } | { kind: 'error'; message: string };
const CHANGED = 'waystation:providers-changed';

export function CopilotAccountPanel({ compact = false }: { readonly compact?: boolean }) {
  const [account, setAccount] = useState<CopilotAccountView>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [flow, setFlow] = useState<{ flowId: string; step: LoginStep }>();
  const [input, setInput] = useState('');
  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try { setAccount(await request('GET', `/api/providers/copilot${refresh ? '?refresh=1' : ''}`)); setError(undefined); }
    catch (failure) { setError((failure as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const advance = useCallback(async (flowId: string, text?: string) => {
    setLoading(true);
    try {
      const step = await request<LoginStep>('POST', '/api/providers/copilot/auth/advance', { flowId, input: text });
      if (step.kind === 'completed') { setFlow(undefined); await load(true); window.dispatchEvent(new Event(CHANGED)); }
      else if (step.kind === 'error') { setError(step.message); setFlow(undefined); }
      else setFlow(current => current?.flowId === flowId ? { flowId, step } : current);
    } catch (failure) { setError((failure as Error).message); }
    finally { setLoading(false); }
  }, [load]);
  useEffect(() => {
    if (flow?.step.kind !== 'awaiting') return;
    const timer = setTimeout(() => void advance(flow.flowId), 2000);
    return () => clearTimeout(timer);
  }, [flow, advance]);
  const begin = async () => {
    setLoading(true); setError(undefined);
    try { setFlow(await request('POST', '/api/providers/copilot/auth/begin')); }
    catch (failure) { setError((failure as Error).message); }
    finally { setLoading(false); }
  };
  const cancel = async () => {
    const previous = flow; setFlow(undefined);
    if (previous) await request('POST', '/api/providers/copilot/auth/cancel', { flowId: previous.flowId }).catch(() => undefined);
  };
  const step = flow?.step;
  const url = step?.kind === 'open-url' && /^https:\/\//i.test(step.url) ? step.url : undefined;
  return <section className={compact ? 'workspace-note' : 'workspace-panel'} aria-label="GitHub Copilot account">
    {!compact && <div className="section-heading"><div><h2>GitHub Copilot</h2><p>Connect your account for managed agents, teams and account usage.</p></div></div>}
    <div><p><strong>{account?.authenticated ? 'Copilot connected' : loading && !account ? 'Checking Copilot…' : 'Connect Copilot'}</strong></p>
      <p>{account?.authenticated ? 'Ready to launch. Sessions report token usage, context and activity; account allowances appear in Usage.' : account?.message ?? 'Checking the local Copilot SDK sign-in.'}</p>
      {error && <p role="alert">{error}</p>}
      {step && <div role="status">
        {url && <><a className="btn" href={url} target="_blank" rel="noreferrer">Sign in on GitHub<Icon name="arrow" size={14} /></a><p>After completing the browser sign-in, choose Continue.</p></>}
        {step.kind === 'input-required' && <label>{step.prompt}<input className="text-input" value={input} onChange={event => setInput(event.target.value)} autoComplete="off" /></label>}
        {step.kind === 'awaiting' && <p>Waiting for GitHub sign-in…</p>}
        {step.kind === 'needs-interaction' && <p>Continue to get the next sign-in step.</p>}
        <button type="button" className="btn btn-small" disabled={loading} onClick={() => void advance(flow!.flowId, input || undefined)}>Continue</button>
        <button type="button" className="btn btn-small" onClick={() => void cancel()}>Cancel sign-in</button>
      </div>}
      {!flow && !account?.authenticated && <button type="button" className="btn btn-small" disabled={loading} onClick={() => void begin()}>Sign in to Copilot</button>}
      {!flow && <button type="button" className="btn btn-small btn-ghost" disabled={loading} onClick={() => void load(true)}><Icon name="refresh" size={14} />Check connection</button>}
    </div>
  </section>;
}
