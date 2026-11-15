import { useEffect, useRef, useState } from 'react';
import { request, type Agent } from '../../api.ts';
import type { ArchitectureNode } from '../../../../shared/architecture.ts';
import type { AgentRuntime, BrainConnection, BrainProvider } from '../../../../shared/agentBrains.ts';
import { useProviders } from '../../useProviders.ts';
import { ModelPicker } from '../ModelPicker.tsx';
import { Icon } from '../Icon.tsx';
import { ACTIVE_AGENT_RUNS, type AgentRun } from '../../../../shared/agentRuns.ts';
import { SavedSecretPicker } from './AgentSecrets.tsx';
import { AgentDeploymentControls } from './AgentPlatform.tsx';
import { AgentRunPanel } from './AgentActivity.tsx';

const enc = encodeURIComponent;
const url = (id: string) => `/api/architectures/${enc(id)}`;
const DEFAULT_RUNTIME: AgentRuntime = { kind: 'managed', policy: 'chat-only', maxOutputTokens: 1024 };

export function NodeFields({ node, busy, save, documentId, revision, connections, onConnections, agents, onOpenAgent, onActivity, project, onDeployment, onLibrary }: {
  node: ArchitectureNode; busy: boolean; save: (node: ArchitectureNode) => Promise<boolean>; documentId: string; revision: number;
  project: string; onDeployment: (id: string) => void; onLibrary: () => void;
  connections: BrainConnection[]; onConnections: () => void; agents: readonly Agent[]; onOpenAgent: (id: string) => void; onActivity: (runId: string) => void;
}) {
  const [draft, setDraft] = useState(node); const providers = useProviders();
  const runtime = draft.runtime ?? DEFAULT_RUNTIME;
  const runtimeChange = (patch: Partial<AgentRuntime>) => setDraft(d => ({ ...d, runtime: { ...(d.runtime ?? DEFAULT_RUNTIME), ...patch } }));
  const dirty = JSON.stringify(node) !== JSON.stringify(draft);
  return <div className="arch-node-settings"><form className="arch-fields" onSubmit={e => { e.preventDefault(); void save(node.kind === 'agent' ? { ...draft, runtime, ...(runtime.kind === 'managed' ? { provider: draft.provider || 'claude' } : {}) } : draft); }}>
    <h3>{node.kind === 'agent' ? 'Agent configuration' : `${node.kind[0].toUpperCase()}${node.kind.slice(1)} settings`}</h3>
    <label>Name<input className="text-input" required maxLength={100} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
    <label className="arch-instructions">{node.kind === 'agent' ? 'Role & instructions' : node.kind === 'router' ? 'Routing rules' : 'Description'}<textarea aria-label={node.kind === 'agent' ? 'Role & instructions' : node.kind === 'router' ? 'Routing rules' : 'Description'} className="text-input" maxLength={8000} rows={3} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} placeholder={node.kind === 'agent' ? 'Describe its purpose, boundaries, and expected response.' : ''} /></label>
    {node.kind === 'agent' && <div className="arch-runtime-fields">
      <label>Agent brain<select aria-label="Agent brain" className="text-input" value={runtime.kind} onChange={e => setDraft(d => ({ ...d, model: '', provider: undefined, runtime: { ...(d.runtime ?? DEFAULT_RUNTIME), kind: e.target.value as AgentRuntime['kind'], policy: 'chat-only' } }))}><option value="managed">Coding runtime as a multipurpose agent</option><option value="api">LLM API connection</option></select></label>
      {runtime.kind === 'managed' ? <>
        <label>Runtime provider<select className="text-input" aria-label="Runtime provider" value={draft.provider || 'claude'} onChange={e => setDraft({ ...draft, provider: e.target.value, model: '', runtime })}>{providers.providers.map(p => <option key={p.id} value={p.id} disabled={!['claude', 'copilot'].includes(p.id) || p.available === false}>{p.label}{!['claude', 'copilot'].includes(p.id) ? ' (restraint unavailable)' : p.available === false ? ' (unavailable)' : ''}</option>)}</select></label>
        <label>Model<ModelPicker key={draft.provider ?? 'claude'} vendor={draft.provider || 'claude'} value={draft.model ?? ''} onChange={model => setDraft({ ...draft, model, runtime })} /></label>
        <label>Tool access<select className="text-input" aria-label="Tool access" value={runtime.policy} onChange={e => runtimeChange({ policy: e.target.value as AgentRuntime['policy'] })}><option value="chat-only">Conversation only · no tools</option><option value="review-tools">Review every tool call</option></select></label>
      </> : <>
        <label>LLM connection<select className="text-input" aria-label="LLM connection" value={runtime.connectionId ?? ''} onChange={e => runtimeChange({ connectionId: e.target.value })}><option value="">Choose a saved connection</option>{connections.map(c => <option key={c.id} value={c.id}>{c.label} · {c.provider}</option>)}</select></label>
        <button className="btn btn-small" type="button" onClick={onConnections}>Manage LLM connections</button>
        <label>Model override<input className="text-input" maxLength={120} placeholder={connections.find(c => c.id === runtime.connectionId)?.model || 'Use connection model'} value={draft.model ?? ''} onChange={e => setDraft({ ...draft, model: e.target.value, runtime })} /></label>
        <label>Tool access<select className="text-input" aria-label="Tool access" value={runtime.policy} onChange={e => runtimeChange({ policy: e.target.value as AgentRuntime['policy'] })}><option value="chat-only">Conversation only</option><option value="configured-tools">Allow connected tools</option><option value="review-tools">Review each tool call</option></select></label>
        <label>Max output tokens<input className="text-input" type="number" min={64} max={4096} required value={runtime.maxOutputTokens} onChange={e => runtimeChange({ maxOutputTokens: Number(e.target.value) })} /></label>
      </>}
      <p>{runtime.kind === 'api' ? 'Runs use connected memory and outputs. Tool access follows the saved policy, with bounded model turns and tool calls.' : runtime.policy === 'chat-only' ? 'The coding runtime answers your task with all tool calls blocked.' : 'Every tool call waits for your approval in Session details. This can include file and shell access.'}</p>
    </div>}
    {node.kind === 'agent' && runtime.kind === 'api' && <div className="arch-runtime-fields"><label>Maximum model turns<input className="text-input" type="number" min={1} max={12} required value={runtime.maxSteps ?? 8} onChange={e => runtimeChange({ maxSteps: Number(e.target.value) })} /></label><label>Maximum tool calls<input className="text-input" type="number" min={0} max={20} required value={runtime.maxToolCalls ?? 20} onChange={e => runtimeChange({ maxToolCalls: Number(e.target.value) })} /></label></div>}
    <button className="btn btn-small" disabled={busy || (!dirty && (node.kind !== 'agent' || !!node.runtime))}>{node.kind === 'agent' ? 'Save agent' : 'Save step'}</button>
    {node.kind === 'agent' && !node.runtime && <span className="arch-field-note">Save to enable individual tests.</span>}
  </form>
  {node.kind === 'agent' && <AgentDeploymentControls node={node} documentId={documentId} revision={revision} project={project} dirty={dirty || busy} save={save} onDeployment={onDeployment} onLibrary={onLibrary} />}
  {node.kind === 'agent' && <AgentTester documentId={documentId} node={node} revision={revision} dirty={dirty} saving={busy} agents={agents} onOpenAgent={onOpenAgent} onActivity={onActivity} />}
  </div>;
}

function AgentTester({ documentId, node, revision, dirty, saving, onOpenAgent, onActivity }: { documentId: string; node: ArchitectureNode; revision: number; dirty: boolean; saving: boolean; agents: readonly Agent[]; onOpenAgent: (id: string) => void; onActivity: (runId: string) => void }) {
  const [input, setInput] = useState(''); const [run, setRun] = useState<AgentRun>(); const [error, setError] = useState(''); const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (!run?.id) return;
    let active = true; let pending = false; const id = run.id;
    const poll = async () => { if (pending) return; pending = true; try { const next = await request<{ run: AgentRun }>('GET', `/api/agent-runs/${encodeURIComponent(id)}`); if (active) setRun(next.run); } catch (e) { if (active) setError((e as Error).message); } finally { pending = false; } };
    void poll(); const timer = setInterval(() => { void poll(); }, 1200); return () => { active = false; clearInterval(timer); };
  }, [run?.id]);
  const start = async () => {
    if (starting || !input.trim() || dirty || !node.runtime) return;
    setStarting(true); setError('');
    try { const result = await request<{ run: AgentRun }>('POST', `${url(documentId)}/nodes/${enc(node.id)}/run`, { text: input, expectedRevision: revision }); setRun(result.run); }
    catch (e) { setError((e as Error).message); } finally { setStarting(false); }
  };
  return <section className="arch-agent-test" aria-label="Run individual agent"><h3>Run this agent</h3><p>Uses the saved brain, connected tools and memory, and output destinations. Activity remains available in the dashboard after you leave this page.</p>
    <label htmlFor="arch-test-input">Agent task</label><textarea id="arch-test-input" className="text-input" rows={2} disabled={saving} value={input} maxLength={12000} onChange={e => setInput(e.target.value)} placeholder="Give this agent a task?" />
    <div className="arch-actions"><button className="btn btn-small" disabled={starting || !!run && ACTIVE_AGENT_RUNS.includes(run.status) || dirty || saving || !node.runtime || !input.trim()} onClick={() => { void start(); }}><Icon name="play" size={14} />{starting ? 'Starting?' : 'Run agent'}</button>{dirty && <small>Save your changes before running.</small>}{run && <button className="btn btn-small" onClick={() => onActivity(run.id)}>View in Agent activity</button>}</div>
    {error && <p className="arch-error" role="alert">{error}</p>}{run && <AgentRunPanel key={run.id} run={run} onRun={setRun} onOpenAgent={onOpenAgent} compact />}
  </section>;
}

export function BrainConnectionsPanel({ documentId, connections, onChanged, onClose, project }: { documentId: string; project: string; connections: BrainConnection[]; onChanged: () => void; onClose: () => void }) {
  const [label, setLabel] = useState(''); const [provider, setProvider] = useState<BrainProvider>('openai'); const [model, setModel] = useState(''); const [baseUrl, setBaseUrl] = useState(''); const [key, setKey] = useState('');
  const [secretId, setSecretId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [replace, setReplace] = useState<string>(); const [replacement, setReplacement] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [success, setSuccess] = useState('');
  const save = async () => {
    setBusy(true); setError(''); setSuccess('');
    try { await request('POST', `${url(documentId)}/connections`, { label, provider, model, baseUrl: provider === 'compatible' ? baseUrl : undefined, apiKey: secretId ? undefined : key || undefined, secretId: secretId || undefined, workspaceId: provider === 'anthropic' ? workspaceId || undefined : undefined }); setKey(''); setSecretId(''); setLabel(''); setModel(''); setBaseUrl(''); setWorkspaceId(''); setSuccess('Connection saved. Select an agent and choose this LLM connection.'); onChanged(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const rotate = async () => {
    setBusy(true); setError('');
    try { await request('POST', `${url(documentId)}/connections/${enc(replace!)}/key`, { apiKey: replacement }); setReplacement(''); setReplace(undefined); setSuccess('API key replaced.'); onChanged(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section className="arch-connections-panel" aria-label="LLM connections"><header><div><h2>LLM connections</h2><p>Choose a brain for any agent. Keys are stored locally outside the project, and kept out of graphs, chat context, and exports.</p></div><button className="icon-btn" aria-label="Close LLM connections" onClick={onClose}><Icon name="close" size={16} /></button></header>
    {!!connections.length && <ul>{connections.map(c => <li key={c.id}><strong>{c.label}</strong><span>{c.provider} · {c.model}</span><small>{c.hasKey ? 'Key saved' : 'No API key'}</small><button className="btn btn-small" disabled={busy} onClick={() => { setReplace(c.id); setReplacement(''); setSuccess(''); }}>Replace key</button></li>)}</ul>}
    {replace && <form className="arch-connection-form" onSubmit={e => { e.preventDefault(); void rotate(); }}><label>Replacement API key<input aria-label="Replacement API key" className="text-input" type="password" autoComplete="new-password" required maxLength={8192} value={replacement} onChange={e => setReplacement(e.target.value)} /></label><button className="btn btn-small" disabled={busy || !replacement.trim()}>Save replacement key</button><button type="button" className="btn btn-ghost" onClick={() => { setReplace(undefined); setReplacement(''); }}>Cancel</button></form>}
    <form className="arch-connection-form" onSubmit={e => { e.preventDefault(); void save(); }}>
      <label>Connection name<input className="text-input" aria-label="Connection name" required maxLength={80} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Research brain" /></label>
      <label>API provider<select className="text-input" aria-label="API provider" value={provider} onChange={e => { setProvider(e.target.value as BrainProvider); setModel(''); setKey(''); }}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="compatible">OpenAI-compatible</option></select></label>
      {provider === 'compatible' && <label>API base URL<input className="text-input" aria-label="API base URL" type="url" required maxLength={1000} value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://your-endpoint/v1" /></label>}
      {provider === 'anthropic' && <label>Workspace id (for unscoped keys)<input className="text-input" aria-label="Anthropic workspace id" maxLength={100} value={workspaceId} onChange={e => setWorkspaceId(e.target.value)} placeholder="Optional for workspace-scoped keys" /></label>}
      <label>Model id<input className="text-input" aria-label="Connection model id" required maxLength={200} value={model} onChange={e => setModel(e.target.value)} placeholder="Model id from your provider" /></label>
      <SavedSecretPicker project={project} kind="api-key" value={secretId} onChange={setSecretId} />
      {!secretId && <label>API key{provider === 'compatible' ? ' (optional for local endpoints)' : ''}<input aria-label="Connection API key" className="text-input" type="password" autoComplete="new-password" spellCheck={false} required={provider !== 'compatible'} maxLength={8192} value={key} onChange={e => setKey(e.target.value)} placeholder="Stored once; never shown again" /></label>}
      <button className="btn btn-small" disabled={busy}>{busy ? 'Saving…' : 'Save LLM connection'}</button>
    </form>{error && <p className="arch-error" role="alert">{error}</p>}{success && <p className="arch-connection-success" role="status">{success}</p>}
  </section>;
}
