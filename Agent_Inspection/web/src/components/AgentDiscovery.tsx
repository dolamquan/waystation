import { useEffect, useId, useState } from 'react';
import { request, type Agent } from '../api.ts';
import { providerLabel, type DiscoveryRule } from '../../../shared/agentProviders.ts';
import { Icon } from './Icon.tsx';
import { ProviderConnections } from './ProviderConnections.tsx';

export function AgentDiscovery({ agents, onSelect, notify }: {
  readonly agents: readonly Agent[];
  readonly onSelect: (id: string) => void;
  readonly notify: (message: string, kind?: 'ok' | 'error') => void;
}) {
  const uid = useId();
  const [rules, setRules] = useState<DiscoveryRule[]>([]);
  const [label, setLabel] = useState('');
  const [executable, setExecutable] = useState('');
  const [packageName, setPackageName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [availability, setAvailability] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setAvailability('loading');
    request<{ rules: DiscoveryRule[] }>('GET', '/api/discovery').then(result => { if (active) { setRules(result.rules); setError(undefined); setAvailability('ready'); } }, () => { if (active) setAvailability('unavailable'); });
    return () => { active = false; };
  }, [refresh]);
  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try { await fn(); setError(undefined); setRefresh(value => value + 1); notify(message); return true; }
    catch (failure) { setError((failure as Error).message); return false; }
    finally { setBusy(false); }
  };
  return <><ProviderConnections /><section className="ops-section workspace-panel" aria-labelledby={`${uid}-title`}>
    <div className="section-heading"><div><h2 id={`${uid}-title`}>Agent discovery</h2><p>Running agents appear automatically. Process detection checks every four seconds.</p></div>{availability === 'unavailable' && <button className="btn btn-small" onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" size={14} />Retry connection</button>}</div>
    <div className="workspace-note"><Icon name="info" size={16} /><span>Detected runtimes appear in Overview, the station and history. Conversation access, launching, teams and schedules require a provider integration. An editor runtime can serve several conversations.</span></div>
    <ul className="ops-list setup-list">{rules.map(rule => {
      const running = agents.filter(agent => agent.providerId === rule.id);
      return <li className="ops-row" key={rule.id}><span className="prereq-mark"><Icon name="terminal" size={20} /></span><div className="ops-row-main"><strong>{rule.label}</strong><small>{[...rule.executables, ...rule.packages].join(', ')} · {running.length ? `${running.length} running` : 'No running process detected'}</small></div>{running.map(agent => <button className="btn btn-small" key={agent.id} onClick={() => onSelect(agent.id)}>View{running.length > 1 ? ` ${agent.pid}` : ''}</button>)}{rule.id.startsWith('custom-') && <button className="icon-btn" aria-label={`Remove ${rule.label} discovery rule`} disabled={busy} onClick={() => void act(() => request('POST', `/api/discovery/${encodeURIComponent(rule.id)}/remove`), 'Discovery rule removed. The agent keeps running.')}><Icon name="trash" size={16} /></button>}</li>;
    })}</ul>
    <form className="detail-manage-form" onSubmit={event => {
      event.preventDefault();
      void act(() => request('POST', '/api/discovery', { label, executable, package: packageName }), 'Discovery rule saved. Matching processes will appear automatically.').then(ok => { if (ok) { setLabel(''); setExecutable(''); setPackageName(''); } });
    }}>
      <h3>Recognize another agent</h3>
      <p>Add its executable name once. Waystation remembers it and discovers matching processes on future runs.</p>
      <label>Agent name<input className="text-input" value={label} onChange={event => setLabel(event.target.value)} maxLength={80} placeholder="My coding agent" required /></label>
      <label>Executable name<input className="text-input" value={executable} onChange={event => setExecutable(event.target.value)} maxLength={80} placeholder="my-agent.exe" /></label>
      <label>Entry-script package (optional)<input className="text-input" value={packageName} onChange={event => setPackageName(event.target.value)} maxLength={160} placeholder="@example/coding-agent" /></label>
      <p>Enter an executable, a package, or both. For agents running through Node or Python, use the package in the entry-script path instead of the shared runtime name.</p>
      {error && <p role="alert">{error}</p>}
      <button className="btn" disabled={busy || availability !== 'ready'}>{availability === 'loading' ? 'Connecting…' : availability === 'unavailable' ? 'Discovery unavailable' : busy ? 'Saving…' : 'Save discovery rule'}</button>
    </form>
  </section></>;
}

/** Unknown usage is visible without being counted as zero spend or zero tokens. */
export function ObservedUsage({ agents, onSelect }: { readonly agents: readonly Agent[]; readonly onSelect: (id: string) => void }) {
  const observed = agents.filter(agent => agent.observation);
  if (!observed.length) return null;
  return <section className="workspace-panel" aria-label="External agent runtimes"><div className="section-heading"><div><h2>External runtimes<span className="section-count">{observed.length}</span></h2><p>These runtimes do not expose per-session usage. Account allowances appear above; launch an agent in Waystation to record its tokens and activity.</p></div></div><ul className="ops-list">{observed.map(agent => <li className="ops-row" key={agent.id}><div className="ops-row-main"><strong>{agent.name}</strong><small>{providerLabel(agent)} · {agent.observation?.processName} · PID {agent.pid}</small></div><span className="status-pill">Observe only</span><button className="btn btn-small" onClick={() => onSelect(agent.id)}>View agent</button></li>)}</ul></section>;
}

