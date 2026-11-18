import { useEffect, useState } from 'react';
import { request } from '../../api.ts';
import type { ServiceConnection } from '../../../../shared/agentPlatform.ts';
import { Icon } from '../Icon.tsx';
import { StatusBadge } from './ArchitectureUI.tsx';
import { isAbort, loadCatalog, message, TAVILY_KEY_URL, type McpPreset } from './toolCatalog.ts';
import './add-tool.css';

const createConnection = (body: Record<string, unknown>) => request<{ connection: ServiceConnection }>('POST', '/api/agent-service-connections', body).then(r => r.connection);

interface McpProps { project: string; onCreated: (connection: ServiceConnection) => void }

/** Shown where an MCP capability would otherwise dead-end on an empty dropdown: add the server right here. */
export function InlineMcpServer({ project, onCreated }: McpProps) {
  const [presets, setPresets] = useState<McpPreset[]>([]); const [presetId, setPresetId] = useState('');
  const [name, setName] = useState(''); const [endpoint, setEndpoint] = useState(''); const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    loadCatalog(project, controller.signal).then(c => setPresets(c.mcpPresets), e => { if (!isAbort(e)) setError(`Could not load popular servers: ${message(e)} You can still paste a URL.`); });
    return () => controller.abort();
  }, [project]);
  const preset = presets.find(p => p.id === presetId);
  const pick = (p: McpPreset) => { setPresetId(p.id); setName(p.name); setEndpoint(p.url); setError(''); };
  const tokenRequired = preset?.auth === 'token';
  const ready = !busy && !!name.trim() && /^https?:\/\/\S+$/i.test(endpoint.trim()) && (!tokenRequired || !!token.trim());
  const save = async () => {
    if (!ready) return;
    setBusy(true); setError('');
    try { onCreated(await createConnection({ project, kind: 'mcp', name: name.trim(), endpoint: endpoint.trim(), ...(token.trim() ? { secret: token.trim() } : {}) })); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  // This sits inside the capability form: Enter saves the server instead of publishing the capability.
  return <div className="inline-connection platform-wide" role="group" aria-label="Add an MCP server" onKeyDown={e => { if (e.key === 'Enter' && e.target instanceof HTMLInputElement) { e.preventDefault(); void save(); } }}>
    <p><strong>Add a server</strong> · no MCP servers are saved in this project yet.</p>
    {!!presets.length && <div className="add-tool-grid">{presets.map(p => <button key={p.id} type="button" className="add-tool-option" aria-pressed={presetId === p.id} onClick={() => pick(p)}>
      <strong>{p.name}</strong><span>{p.description}</span><StatusBadge tone={p.auth === 'token' ? 'warning' : 'neutral'}>{p.auth === 'token' ? 'Needs a token' : p.auth === 'optional' ? 'Token optional' : 'No sign-in'}</StatusBadge></button>)}</div>}
    <div className="add-tool-pair">
      <label className="add-tool-field">Server URL<input className="text-input" type="url" spellCheck={false} maxLength={2000} placeholder="https://example.com/mcp" value={endpoint} onChange={e => { setEndpoint(e.target.value); setPresetId(''); }} /></label>
      <label className="add-tool-field">Connection name<input className="text-input" maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. GitHub" /></label>
    </div>
    <label className="add-tool-field">{tokenRequired ? 'Access token' : 'Access token (optional)'}<input className="text-input" type="password" autoComplete="off" spellCheck={false} maxLength={8192} value={token} onChange={e => setToken(e.target.value)} />
      <small>{preset?.tokenHint || 'Only if the server asks for one. Sent as a Bearer token.'} Stored locally, never shown to the model.</small></label>
    {error && <p className="arch-error" role="alert">{error}</p>}
    <div className="arch-actions"><button type="button" className="btn btn-go" disabled={!ready} onClick={() => { void save(); }}><Icon name="link" size={14} />{busy ? 'Saving…' : 'Save server'}</button>{tokenRequired && !token.trim() && <small>{preset!.name} needs a token.</small>}</div>
  </div>;
}

interface TavilyProps { project: string; onCreated: (connection: ServiceConnection) => void }

/** Shown where a Tavily capability would otherwise dead-end on an empty dropdown. */
export function InlineTavilyKey({ project, onCreated }: TavilyProps) {
  const [secret, setSecret] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const save = async () => {
    if (!secret.trim() || busy) return;
    setBusy(true); setError('');
    try { onCreated(await createConnection({ project, kind: 'tavily', name: 'Tavily', secret: secret.trim() })); setSecret(''); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <div className="inline-connection platform-wide" role="group" aria-label="Add a Tavily key">
    <label className="add-tool-field">Tavily API key<input className="text-input" type="password" autoComplete="off" spellCheck={false} maxLength={8100} value={secret} onChange={e => setSecret(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} />
      <small>No key saved in this project yet. Get one at <a href={TAVILY_KEY_URL} target="_blank" rel="noopener noreferrer">app.tavily.com</a>; it is stored locally and never shown to the model.</small></label>
    {error && <p className="arch-error" role="alert">{error}</p>}
    <div className="arch-actions"><button type="button" className="btn btn-small" disabled={busy || !secret.trim()} onClick={() => { void save(); }}>{busy ? 'Saving…' : 'Save key'}</button></div>
  </div>;
}
