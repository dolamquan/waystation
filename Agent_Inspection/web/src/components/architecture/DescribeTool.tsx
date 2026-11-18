import { useEffect, useRef, useState } from 'react';
import { request } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { StatusBadge, WorkspaceEmpty } from './ArchitectureUI.tsx';
import { argumentRows, isAbort, message, preview, type AddTool, type GenerateResult, type ToolDraft, type ToolWriter } from './toolCatalog.ts';

const EXAMPLES = [
  'Convert an amount between currencies using the Frankfurter API',
  'Extract all email addresses from a text',
  'Calculate business days between two dates',
] as const;
const MIN_DESCRIPTION = 10;
const WRITER_KEY = 'waystation-tool-writer';
const savedWriter = (): string => { try { return localStorage.getItem(WRITER_KEY) ?? ''; } catch { return ''; } };
const rememberWriter = (id: string) => { try { localStorage.setItem(WRITER_KEY, id); } catch { /* optional preference */ } };

interface Props { project: string; writers: ToolWriter[]; agentName: string; addTool: AddTool; onManageConnections: () => void }

/** The operator says what the tool should do; a model writes and test-runs it. The operator reviews a plain-language summary, never has to edit code. */
export function DescribeTool({ project, writers, agentName, addTool, onManageConnections }: Props) {
  const [description, setDescription] = useState('');
  const [writer, setWriter] = useState(() => { const saved = savedWriter(); return writers.some(w => w.id === saved) ? saved : writers[0]?.id ?? ''; });
  const [result, setResult] = useState<GenerateResult>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);

  const generate = async (text: string, current?: ToolDraft) => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError('');
    try {
      const next = await request<GenerateResult>('POST', '/api/agent-tools/generate', { project, description: text, connectionId: writer, ...(current ? { current } : {}) }, controller.signal);
      setResult(next); rememberWriter(writer);
    } catch (e) { if (!isAbort(e)) setError(message(e)); }
    finally { if (abort.current === controller) { abort.current = undefined; setBusy(false); } }
  };
  const cancel = () => { abort.current?.abort(); abort.current = undefined; setBusy(false); };

  if (!writers.length) return <WorkspaceEmpty icon="sparkle" title="Connect a model to write tools"
    action={<button type="button" className="btn btn-go" onClick={onManageConnections}><Icon name="link" size={14} />Add an LLM connection</button>}>
    A model writes the tool from your description and tests it before you add it. Add an OpenAI, Anthropic or compatible API connection, then come back here.</WorkspaceEmpty>;
  if (busy) return <div className="add-tool-progress" role="status" aria-live="polite">
    <span className="add-tool-spinner" aria-hidden="true" /><div><strong>{result ? 'Revising and testing the tool…' : 'Writing and testing the tool…'}</strong><p>This can take up to a minute. Nothing is added until you review it.</p></div>
    <button type="button" className="btn btn-small" onClick={cancel}>Cancel</button></div>;
  if (result) return <DraftReview key={JSON.stringify(result.draft)} result={result} agentName={agentName} addTool={addTool} error={error}
    onRevise={(change, draft) => { void generate(change, draft); }} onStartOver={() => { setResult(undefined); setError(''); }} />;

  const ready = description.trim().length >= MIN_DESCRIPTION && !!writer;
  return <form className="add-tool-flow" aria-label="Describe a tool" onSubmit={e => { e.preventDefault(); if (ready) void generate(description.trim()); }}>
    <label className="add-tool-field">What should the tool do?<textarea data-autofocus className="text-input" rows={4} maxLength={4000} required value={description} onChange={e => setDescription(e.target.value)}
      placeholder="Describe the inputs, what it should return, and any web API it should use." aria-describedby="add-tool-describe-help" />
      <small id="add-tool-describe-help">Plain language is fine. The model picks the arguments, writes the code and tests it.</small></label>
    <div className="add-tool-examples" role="group" aria-label="Examples">{EXAMPLES.map(text => <button key={text} type="button" className="add-tool-chip" onClick={() => setDescription(text)}>{text}</button>)}</div>
    <label className="add-tool-field">Written by<select className="text-input" value={writer} onChange={e => setWriter(e.target.value)}>{writers.map(w => <option key={w.id} value={w.id}>{w.label} · {w.model}</option>)}</select>
      <small>Uses this LLM connection once per attempt. Stronger models write better tools.</small></label>
    {error && <p className="arch-error" role="alert">{error}</p>}
    <div className="add-tool-actions"><button className="btn btn-go" disabled={!ready}><Icon name="sparkle" size={14} />Write the tool</button>
      {description.trim().length < MIN_DESCRIPTION && <small>Describe it in at least {MIN_DESCRIPTION} characters.</small>}</div>
  </form>;
}

interface ReviewProps { result: GenerateResult; agentName: string; addTool: AddTool; error: string; onRevise: (change: string, draft: ToolDraft) => void; onStartOver: () => void }

function DraftReview({ result: { draft, test }, agentName, addTool, error: reviseError, onRevise, onStartOver }: ReviewProps) {
  const [name, setName] = useState(draft.name); const [description, setDescription] = useState(draft.description);
  const [secret, setSecret] = useState(''); const [change, setChange] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const rows = argumentRows(draft.inputSchema);
  const edited: ToolDraft = { ...draft, name: name.trim() || draft.name, description: description.trim() || draft.description };
  const descriptionValid = description.trim().length >= 10;
  const add = async () => {
    if (!name.trim() || !descriptionValid) return;
    setBusy(true); setError('');
    try { await addTool({ kind: 'custom', draft: edited, name: edited.name, ...(draft.needsCredential && secret.trim() ? { secret: secret.trim() } : {}) }); }
    catch (e) { setError(message(e)); setBusy(false); }
  };
  return <form className="add-tool-flow add-tool-draft" aria-label="Review the tool" onSubmit={e => { e.preventDefault(); void add(); }}>
    <div className="add-tool-draft-head"><StatusBadge tone="success">Written{'output' in test ? ' and tested' : ''}</StatusBadge><code>{draft.functionName}</code></div>
    <label className="add-tool-field">Display name<input className="text-input" required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label>
    <label className="add-tool-field">Description<textarea className="text-input" rows={3} required minLength={10} maxLength={2000} value={description} onChange={e => setDescription(e.target.value)} aria-describedby="add-tool-desc-help" />
      <small id="add-tool-desc-help">The model reads this to decide when to call the tool.</small></label>
    <section aria-labelledby="add-tool-args"><h4 id="add-tool-args">What the agent can pass</h4>
      {!rows.length ? <p className="platform-help">No arguments.</p> : <div className="agent-table-scroll"><table className="add-tool-args"><thead><tr><th scope="col">Argument</th><th scope="col">Type</th><th scope="col">Required</th><th scope="col">Description</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.name}><td><code>{r.name}</code></td><td>{r.type}</td><td>{r.required ? 'Yes' : 'No'}</td><td>{r.description || '—'}</td></tr>)}</tbody></table></div>}
    </section>
    <dl className="add-tool-facts">
      <div><dt>How it runs</dt><dd>{draft.implementation === 'javascript' ? 'Runs in an isolated sandbox — no network or files.' : <>Calls <code>{draft.method ?? 'GET'} {draft.url}</code></>}</dd></div>
      <div><dt>Changes things?</dt><dd>{draft.readOnly ? 'No. It only reads or computes, so it runs without asking.' : <>Yes, it can change things outside the agent, so it <strong>asks before every call</strong>.</>}</dd></div>
      <div><dt>Test</dt><dd>{'output' in test ? <div className="add-tool-test"><pre aria-label="Test input">{preview(test.input)}</pre><Icon name="arrow" size={14} /><pre aria-label="Test output">{preview(test.output)}</pre></div> : test.skipped}</dd></div>
    </dl>
    <details className="add-tool-code"><summary>View code</summary>{draft.implementation === 'javascript' ? <pre aria-label="Tool code">{draft.code}</pre> : <pre aria-label="Tool request">{`${draft.method ?? 'GET'} ${draft.url}\n\nArguments schema:\n${preview(draft.inputSchema)}`}</pre>}</details>
    {draft.needsCredential && <label className="add-tool-field">API key<input className="text-input" type="password" autoComplete="off" spellCheck={false} maxLength={8192} value={secret} onChange={e => setSecret(e.target.value)} aria-describedby="add-tool-cred-help" />
      <small id="add-tool-cred-help">{draft.credentialHint || 'Sent as the Authorization header.'} Stored locally and never shown to the model. Leave empty to add it later; calls fail until it is set.</small></label>}
    <div className="add-tool-revise"><label className="add-tool-field">Ask for changes<input className="text-input" maxLength={2000} value={change} placeholder="e.g. Also return the exchange rate date" onChange={e => setChange(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (change.trim().length >= 10) onRevise(change.trim(), draft); } }} /></label>
      <button type="button" className="btn" disabled={busy || change.trim().length < 10} onClick={() => onRevise(change.trim(), draft)}><Icon name="refresh" size={14} />Rewrite</button></div>
    {(error || reviseError) && <p className="arch-error" role="alert">{error || reviseError}</p>}
    <div className="add-tool-actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={onStartOver}>Start over</button>
      <button className="btn btn-go" disabled={busy || !name.trim() || !descriptionValid}><Icon name="plus" size={14} />{busy ? 'Adding…' : `Add to ${agentName}`}</button></div>
  </form>;
}
