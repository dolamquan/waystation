import { useState } from 'react';
import type { ServiceConnection } from '../../../../shared/agentPlatform.ts';
import { Icon } from '../Icon.tsx';
import { message, TAVILY_KEY_URL, type AddTool } from './toolCatalog.ts';

const NEW_KEY = '';
const domains = (text: string): string[] => text.split(/[\s,]+/).map(v => v.trim()).filter(Boolean);

interface SearchProps { connections: ServiceConnection[]; agentName: string; addTool: AddTool }

/** Tavily web search: reuse a saved key or paste one here. No trip to another tab. */
export function AddSearchTool({ connections, agentName, addTool }: SearchProps) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? NEW_KEY);
  const [apiKey, setApiKey] = useState(''); const [showKey, setShowKey] = useState(false);
  const [maxResults, setMaxResults] = useState(5); const [depth, setDepth] = useState<'basic' | 'advanced'>('basic');
  const [include, setInclude] = useState(''); const [exclude, setExclude] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const usingNewKey = connectionId === NEW_KEY;
  const ready = !busy && (!usingNewKey || !!apiKey.trim()) && maxResults >= 1 && maxResults <= 10;
  const submit = async () => {
    if (!ready) return;
    setBusy(true); setError('');
    try {
      await addTool({ kind: 'web_search', ...(usingNewKey ? { apiKey: apiKey.trim() } : { connectionId }), maxResults, searchDepth: depth, includeDomains: domains(include), excludeDomains: domains(exclude) });
    } catch (e) { setError(message(e)); setBusy(false); }
  };
  return <form className="add-tool-flow" aria-label="Search the web" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <p className="platform-help">Gives {agentName} a <code>web_search</code> tool powered by Tavily. The model writes the query; the key never reaches the model.</p>
    {!!connections.length && <label className="add-tool-field">Tavily key<select className="text-input" value={connectionId} onChange={e => setConnectionId(e.target.value)}>
      {connections.map(c => <option key={c.id} value={c.id}>{c.name}{c.hasSecret ? '' : ' · no key saved'}</option>)}<option value={NEW_KEY}>Paste a new key…</option></select></label>}
    {usingNewKey && <label className="add-tool-field">Tavily API key<span className="add-tool-secret"><input data-autofocus className="text-input" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} required maxLength={8192} value={apiKey} onChange={e => setApiKey(e.target.value)} aria-describedby="add-tool-tavily-help" />
      <button type="button" className="btn btn-small btn-ghost" aria-pressed={showKey} onClick={() => setShowKey(v => !v)}>{showKey ? 'Hide' : 'Show'}</button></span>
      <small id="add-tool-tavily-help">Get a key at <a href={TAVILY_KEY_URL} target="_blank" rel="noopener noreferrer">app.tavily.com</a>. Saved locally as a connection you can reuse.</small></label>}
    <div className="add-tool-pair">
      <label className="add-tool-field">Maximum results<input className="text-input" type="number" min={1} max={10} required value={maxResults} onChange={e => setMaxResults(Number(e.target.value))} /></label>
      <label className="add-tool-field">Search depth<select className="text-input" value={depth} onChange={e => setDepth(e.target.value as 'basic' | 'advanced')}><option value="basic">Basic · faster, fewer credits</option><option value="advanced">Advanced · deeper, more credits</option></select></label>
    </div>
    <details className="add-tool-more"><summary>Limit to or exclude domains (optional)</summary>
      <div className="add-tool-pair">
        <label className="add-tool-field">Only these domains<input className="text-input" value={include} onChange={e => setInclude(e.target.value)} placeholder="docs.python.org, mdn.io" /></label>
        <label className="add-tool-field">Never these domains<input className="text-input" value={exclude} onChange={e => setExclude(e.target.value)} placeholder="example.com" /></label>
      </div><small className="platform-help">Enforced on every call; the model cannot override them.</small></details>
    {error && <p className="arch-error" role="alert">{error}</p>}
    <div className="add-tool-actions"><button className="btn btn-go" disabled={!ready}><Icon name="search" size={14} />{busy ? 'Adding…' : 'Add web search'}</button>{usingNewKey && !apiKey.trim() && <small>Paste your Tavily key to continue.</small>}</div>
  </form>;
}

interface RunCodeProps { agentName: string; addTool: AddTool }

/** One confirmation: what run_code is and where it runs. */
export function AddRunCode({ agentName, addTool }: RunCodeProps) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true); setError('');
    try { await addTool({ kind: 'code_execution' }); } catch (e) { setError(message(e)); setBusy(false); }
  };
  return <div className="add-tool-flow" aria-label="Run code">
    <p>{agentName} gets a <code>run_code</code> tool. When a task needs a calculation, data transform or quick check, the model writes a short program and reads its output.</p>
    <ul className="add-tool-bullets">
      <li>Runs JavaScript in an isolated interpreter: no network, files or imports, and at most one second per run.</li>
      <li>Runs are listed with their code and output under Test &amp; evaluate → Code execution.</li>
      <li>Only API agents use it; turn it off here at any time.</li>
    </ul>
    {error && <p className="arch-error" role="alert">{error}</p>}
    <div className="add-tool-actions"><button type="button" data-autofocus className="btn btn-go" disabled={busy} onClick={() => { void submit(); }}><Icon name="terminal" size={14} />{busy ? 'Turning on…' : 'Turn on'}</button></div>
  </div>;
}
