import { useEffect, useRef, useState } from 'react';
import { request } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { StatusBadge } from './ArchitectureUI.tsx';
import { exposedName, isAbort, isAuthError, MAX_MCP_TOOLS, message, SERVER_PREFIX, type AddTool, type McpSource, type ProbeResult, type ToolCatalog } from './toolCatalog.ts';

type Choice = { kind: 'preset' | 'library' | 'connection'; id: string } | { kind: 'url' };
type Approval = 'always' | 'trust_read_only';

interface Props { catalog: ToolCatalog; project: string; agentName: string; addTool: AddTool }

/** Two steps: pick a server (and sign in if it needs it), then pick which of its tools the agent gets. Nothing is saved until the last button. */
export function AddMcpTool({ catalog, project, agentName, addTool }: Props) {
  const [choice, setChoice] = useState<Choice>();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [probe, setProbe] = useState<{ result: ProbeResult; source: McpSource; token: string }>();
  if (probe) return <ChooseTools key={probe.result.label} probe={probe.result} agentName={agentName} onBack={() => setProbe(undefined)}
    add={(allow, server, approval) => addTool({ kind: 'mcp', ...probe.source, ...(probe.token ? { token: probe.token } : {}), allow, server, approval })} />;
  return <ChooseServer catalog={catalog} project={project} choice={choice} onChoice={next => { setChoice(next); setToken(''); }} url={url} onUrl={setUrl} token={token} onToken={setToken}
    onConnected={(result, source) => setProbe({ result, source, token: token.trim() })} />;
}

function sourceOf(choice: Choice, url: string): McpSource {
  if (choice.kind === 'preset') return { presetId: choice.id };
  if (choice.kind === 'library') return { libraryId: choice.id };
  if (choice.kind === 'connection') return { connectionId: choice.id };
  return { url: url.trim() };
}

interface ServerProps {
  catalog: ToolCatalog; project: string; choice?: Choice; onChoice: (c: Choice) => void; url: string; onUrl: (v: string) => void;
  token: string; onToken: (v: string) => void; onConnected: (result: ProbeResult, source: McpSource) => void;
}

function ChooseServer({ catalog, project, choice, onChoice, url, onUrl, token, onToken, onConnected }: ServerProps) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [showToken, setShowToken] = useState(false);
  const tokenInput = useRef<HTMLInputElement>(null); const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
  const preset = choice?.kind === 'preset' ? catalog.mcpPresets.find(p => p.id === choice.id) : undefined;
  const library = choice?.kind === 'library' ? catalog.libraryMcp.find(l => l.id === choice.id) : undefined;
  const tokenNeed: 'required' | 'optional' | 'none' = preset ? (preset.auth === 'token' ? 'required' : preset.auth === 'optional' ? 'optional' : 'none')
    : choice?.kind === 'url' || library ? 'optional' : 'none';
  const tokenHint = preset?.tokenHint || (library?.hasAuthorization ? 'The Library already has a token for this server. Paste one only to replace it.' : 'Only if the server asks for one. Sent as a Bearer token.');
  const ready = !!choice && !busy && (choice.kind !== 'url' || /^https?:\/\/\S+$/i.test(url.trim())) && (tokenNeed !== 'required' || !!token.trim());

  const connect = async () => {
    if (!choice || !ready) return;
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError('');
    const source = sourceOf(choice, url);
    try {
      const result = await request<ProbeResult>('POST', '/api/agent-tools/mcp/probe', { project, ...source, ...(token.trim() ? { token: token.trim() } : {}) }, controller.signal);
      onConnected(result, source);
    } catch (e) {
      if (isAbort(e)) return;
      const text = message(e); setError(text);
      if (isAuthError(text) && tokenNeed !== 'none') requestAnimationFrame(() => tokenInput.current?.focus());
    } finally { if (abort.current === controller) setBusy(false); }
  };
  const select = (next: Choice) => { onChoice(next); setError(''); };
  const isChosen = (kind: Choice['kind'], id?: string) => choice?.kind === kind && (kind === 'url' || (choice as { id: string }).id === id);

  const connectPanel = (group: Choice['kind']) => choice?.kind !== group ? null : <div className="add-tool-connect">
    {tokenNeed !== 'none' && <label className="add-tool-field">{tokenNeed === 'required' ? 'Access token' : 'Access token (optional)'}
      <span className="add-tool-secret"><input ref={tokenInput} className="text-input" type={showToken ? 'text' : 'password'} autoComplete="off" spellCheck={false} maxLength={8192} required={tokenNeed === 'required'}
        value={token} aria-invalid={!!error && isAuthError(error)} aria-describedby="add-tool-token-hint" onChange={e => onToken(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void connect(); } }} />
        <button type="button" className="btn btn-small btn-ghost" aria-pressed={showToken} onClick={() => setShowToken(v => !v)}>{showToken ? 'Hide' : 'Show'}</button></span>
      <small id="add-tool-token-hint">{tokenHint} Stored locally and never shown to the model.</small></label>}
    {error && <p className="arch-error" role="alert">{error}</p>}
    <div className="arch-actions"><button type="button" className="btn btn-go" disabled={!ready} onClick={() => { void connect(); }}><Icon name="link" size={14} />{busy ? 'Connecting…' : 'Connect'}</button>
      {busy ? <small role="status">Asking the server which tools it offers. Nothing is saved yet.</small> : tokenNeed === 'required' && !token.trim() ? <small>Paste the token to continue.</small> : <small>Lists the server's tools. Nothing is saved yet.</small>}</div>
  </div>;

  return <div className="add-tool-flow" aria-label="Choose a server">
    <p className="add-tool-step">Step 1 of 2 · Choose a server</p>
    <section aria-labelledby="add-tool-presets"><h4 id="add-tool-presets">Popular servers</h4>
      <div className="add-tool-grid">{catalog.mcpPresets.map(p => <button key={p.id} type="button" className="add-tool-option" aria-pressed={isChosen('preset', p.id)} onClick={() => select({ kind: 'preset', id: p.id })}>
        <strong>{p.name}</strong><span>{p.description}</span><StatusBadge tone={p.auth === 'token' ? 'warning' : 'neutral'}>{p.auth === 'token' ? 'Needs a token' : p.auth === 'optional' ? 'Token optional' : 'No sign-in'}</StatusBadge>
      </button>)}</div>
      {connectPanel('preset')}
    </section>
    {!!catalog.libraryMcp.length && <section aria-labelledby="add-tool-library"><h4 id="add-tool-library">From your Library</h4>
      <ul className="add-tool-rows">{catalog.libraryMcp.map(l => { const blocked = l.unsupportedHeaders.length > 0; return <li key={l.id}>
        <button type="button" className="add-tool-option add-tool-row" aria-pressed={isChosen('library', l.id)} disabled={blocked} aria-describedby={blocked ? `lib-${l.id}` : undefined} onClick={() => select({ kind: 'library', id: l.id })}>
          <strong>{l.label}</strong><span className="add-tool-url">{l.url}</span>{l.hasAuthorization && <StatusBadge>Token saved</StatusBadge>}</button>
        {blocked && <small id={`lib-${l.id}`} className="add-tool-why">Signs in with {l.unsupportedHeaders.join(', ')}. Agents can only send an Authorization header, so paste this server's URL and a token below instead.</small>}
      </li>; })}</ul>
      {connectPanel('library')}
    </section>}
    {!!catalog.mcpConnections.length && <section aria-labelledby="add-tool-saved"><h4 id="add-tool-saved">Saved connections</h4>
      <ul className="add-tool-rows">{catalog.mcpConnections.map(c => <li key={c.id}><button type="button" className="add-tool-option add-tool-row" aria-pressed={isChosen('connection', c.id)} onClick={() => select({ kind: 'connection', id: c.id })}>
        <strong>{c.name}</strong>{c.endpoint && <span className="add-tool-url">{c.endpoint}</span>}<StatusBadge>{c.hasSecret ? 'Token saved' : 'No token'}</StatusBadge></button></li>)}</ul>
      {connectPanel('connection')}
    </section>}
    <section aria-labelledby="add-tool-url"><h4 id="add-tool-url">Paste a server URL</h4>
      <label className="add-tool-field"><span className="arch-sr-only">MCP server URL</span><input className="text-input" type="url" inputMode="url" spellCheck={false} maxLength={2000} placeholder="https://example.com/mcp" value={url}
        onFocus={() => { if (choice?.kind !== 'url') select({ kind: 'url' }); }} onChange={e => { onUrl(e.target.value); if (choice?.kind !== 'url') select({ kind: 'url' }); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void connect(); } }} />
        <small>The server's Streamable HTTP endpoint, usually ending in /mcp.</small></label>
      {connectPanel('url')}
    </section>
    {!choice && <p className="platform-help">Choose a server above to continue.</p>}
  </div>;
}

interface ToolsProps { probe: ProbeResult; agentName: string; onBack: () => void; add: (allow: string[], server: string, approval: Approval) => Promise<void> }

function ChooseTools({ probe, agentName, onBack, add }: ToolsProps) {
  const [allow, setAllow] = useState<string[]>(() => probe.tools.slice(0, MAX_MCP_TOOLS).map(t => t.name));
  const [prefix, setPrefix] = useState(SERVER_PREFIX.test(probe.server) ? probe.server : '');
  const [approval, setApproval] = useState<Approval>('always');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const prefixValid = SERVER_PREFIX.test(prefix);
  const tooMany = allow.length > MAX_MCP_TOOLS;
  const canAdd = !busy && allow.length > 0 && !tooMany && prefixValid;
  const submit = async () => {
    if (!canAdd) return;
    setBusy(true); setError('');
    try { await add(allow, prefix, approval); } catch (e) { setError(message(e)); setBusy(false); }
  };
  const toggle = (name: string, on: boolean) => setAllow(list => on ? [...list, name] : list.filter(n => n !== name));
  const count = `${allow.length} tool${allow.length === 1 ? '' : 's'}`;
  return <form className="add-tool-flow" aria-label="Choose tools" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <p className="add-tool-step">Step 2 of 2 · Choose tools</p>
    <p className="add-tool-connected" role="status"><Icon name="check" size={14} />Connected to <strong>{probe.label}</strong> · {probe.tools.length} tool{probe.tools.length === 1 ? '' : 's'}</p>
    <fieldset className="add-tool-checklist"><legend>Tools {agentName} may use · {allow.length} of {probe.tools.length} selected</legend>
      <div className="add-tool-bulk"><button type="button" className="btn btn-small btn-ghost" onClick={() => setAllow(probe.tools.slice(0, MAX_MCP_TOOLS).map(t => t.name))}>Select all</button><button type="button" className="btn btn-small btn-ghost" onClick={() => setAllow([])}>Select none</button>{probe.tools.length > MAX_MCP_TOOLS && <small>At most {MAX_MCP_TOOLS} tools per server.</small>}</div>
      <ul>{probe.tools.map(t => <li key={t.name}>
        <label className="platform-check"><input type="checkbox" checked={allow.includes(t.name)} disabled={!allow.includes(t.name) && allow.length >= MAX_MCP_TOOLS} onChange={e => toggle(t.name, e.target.checked)} /><code>{t.name}</code></label>
        {(t.annotations.readOnlyHint === true || t.annotations.destructiveHint === true) && <div className="agent-tool-badges" title="Reported by the server, not verified by Waystation">
          {t.annotations.readOnlyHint === true && <StatusBadge>Read-only · server hint, not verified</StatusBadge>}
          {t.annotations.destructiveHint === true && <StatusBadge tone="warning">Destructive · server hint, not verified</StatusBadge>}</div>}
        {t.description && <p title={t.description}>{t.description}</p>}
      </li>)}</ul>
    </fieldset>
    <label className="add-tool-field">Tool name prefix<input className="text-input" required maxLength={24} spellCheck={false} value={prefix} aria-invalid={!prefixValid} aria-describedby="add-tool-prefix-help" onChange={e => setPrefix(e.target.value)} />
      <small id="add-tool-prefix-help" className={prefixValid ? '' : 'add-tool-invalid'}>{prefixValid ? <>The model sees names like <code>{exposedName(prefix, allow[0] ?? probe.tools[0]?.name ?? 'tool')}</code>.</> : 'Start with a lowercase letter; then lowercase letters, digits or underscores (24 max).'}</small></label>
    <fieldset className="mcp-approval"><legend>Approval</legend>
      <label className="platform-check"><input type="radio" name="add-tool-approval" checked={approval === 'always'} onChange={() => setApproval('always')} />Ask me before every call (recommended)</label>
      <label className="platform-check"><input type="radio" name="add-tool-approval" checked={approval === 'trust_read_only'} onChange={() => setApproval('trust_read_only')} />Run tools the server marks read-only without asking</label>
      {approval === 'trust_read_only' && <p className="platform-help">Read-only hints come from the server and are not verified. A server that mislabels a tool could run writes without asking. Tools without the hint still ask.</p>}
    </fieldset>
    {error && <p className="arch-error" role="alert">{error}</p>}
    <div className="add-tool-actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={onBack}>Choose another server</button>
      <button className="btn btn-go" disabled={!canAdd}><Icon name="plus" size={14} />{busy ? 'Adding…' : `Add ${count} to ${agentName}`}</button>
      {!allow.length && <small>Select at least one tool.</small>}</div>
  </form>;
}
