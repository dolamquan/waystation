import { useId, useState } from 'react';
import { request } from '../api.ts';
import { refreshProviders, useProviders } from '../useProviders.ts';
import { Icon } from './Icon.tsx';

/** Uses the existing setup list and form conventions, rather than a separate integration workflow. */
export function ProviderConnections() {
  const uid = useId();
  const { providers, warnings, configFile, error: connectionError } = useProviders();
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('[]');
  const [usageMode, setUsageMode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  return <section className="ops-section workspace-panel" aria-labelledby={`${uid}-title`}>
    <div className="section-heading"><div><h2 id={`${uid}-title`}>Connected agent providers</h2><p>Gemini CLI, OpenCode, Qwen Code and Goose are detected when installed or configured. Local Zed agents are imported automatically. Refreshes every ten seconds.</p></div></div>
    <ul className="ops-list setup-list">{providers.map(provider => <li className="ops-row" key={provider.id}>
      <span className="prereq-mark"><Icon name="terminal" size={20} /></span>
      <div className="ops-row-main"><strong>{provider.label}</strong><small>{provider.adapter === 'acp' ? provider.detail : 'Built-in integration'}</small></div>
      <span className="status-pill">{provider.available === false ? 'Unavailable' : provider.adapter === 'acp' ? 'ACP' : 'Built in'}</span>
    </li>)}</ul>
    <p>Connected providers are available in launch, team and schedule selectors. ACP agents use their existing sign-in; recovery, model selection and usage depend on what they expose. ACP does not report account allowances.</p>
    {configFile && <p className="muted">Provider configuration: <code style={{ overflowWrap: 'anywhere' }}>{configFile}</code></p>}
    {warnings.map(warning => <p role="status" key={warning}>{warning}</p>)}
    <details className="form-more"><summary>Connect another ACP agent</summary>
      <form className="detail-manage-form" onSubmit={event => {
        event.preventDefault(); setBusy(true); setError(undefined); setSaved(undefined);
        void (async () => {
          try {
            const parsed: unknown = JSON.parse(args);
            if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error('Arguments must be a JSON array of strings.');
            const id = `acp-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)}`;
            await request('POST', '/api/providers/acp', { id, label: label.trim(), command: command.trim(), args: parsed, usageMode: usageMode || undefined });
            await refreshProviders(); setSaved(`${label.trim()} is registered. It is now available throughout Waystation.`);
            setLabel(''); setCommand(''); setArgs('[]'); setUsageMode('');
          } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
        })();
      }}>
        <p>Use the ACP startup command documented by the agent. Waystation starts it directly with these arguments when you launch a session.</p>
        <label>Agent name<input className="text-input" value={label} onChange={event => setLabel(event.target.value)} maxLength={80} required placeholder="My coding agent" /></label>
        <label>Executable or absolute path<input className="text-input" value={command} onChange={event => setCommand(event.target.value)} maxLength={2048} required placeholder="my-agent" /></label>
        <label>Arguments (JSON array)<input className="text-input" value={args} onChange={event => setArgs(event.target.value)} required placeholder={'["--acp"]'} /></label>
        <label>Token reporting<select className="text-input" value={usageMode} onChange={event => setUsageMode(event.target.value)}>
          <option value="">Not specified (show readings without adding totals)</option><option value="turn">Per turn</option><option value="session">Cumulative session totals</option>
        </select></label>
        <p>Choose a reporting scope only when the agent documents it. Account allowances remain provider-specific.</p>
        {error && <p role="alert">{error}</p>}
        {saved && <p role="status">{saved}</p>}
        <button className="btn" disabled={busy || !!connectionError}>{connectionError ? 'Connection unavailable' : busy ? 'Connecting…' : 'Connect agent'}</button>
      </form>
    </details>
  </section>;
}
