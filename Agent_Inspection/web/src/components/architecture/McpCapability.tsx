import { useState, type ReactNode } from 'react';
import type { AgentCapability, ServiceConnection } from '../../../../shared/agentPlatform.ts';
import { request } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { StatusBadge } from './ArchitectureUI.tsx';
import { InlineMcpServer } from './InlineConnections.tsx';

const enc = encodeURIComponent;
const SERVER_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;
const MAX_ALLOWED_TOOLS = 50;
type Approval = 'always' | 'trust_read_only';
interface DiscoveredTool { name: string; description: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }; schemaHash: string }
interface DriftResult { ok: boolean; message: string; tools: { name: string; exposedAs: string; status: 'ok' | 'changed' | 'missing' }[] }
const DRIFT_LABEL: Record<DriftResult['tools'][number]['status'], string> = { ok: 'Matches', changed: 'Changed on server', missing: 'Missing on server' };
/** Mirrors the daemon's namespacing so the operator sees the exact model-facing name. */
const exposedName = (server: string, tool: string) => { const safe = `${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, '_'); return (/^[A-Za-z_]/.test(safe) ? safe : `t_${safe}`).slice(0, 64); };

/** MCP tools capability: discover a server's tools, choose which the agent may see, pin them, and check for drift later. */
export function McpCapabilityEditor({ project, capability: cap, connections, kindPicker, onSaved, onClose, onConnectionCreated = () => undefined }: { project: string; capability?: AgentCapability; connections: ServiceConnection[]; kindPicker: ReactNode; onSaved: (cap: AgentCapability) => void; onClose: () => void; onConnectionCreated?: (connection: ServiceConnection) => void }) {
  const spec = cap?.spec.kind === 'mcp' ? cap.spec : undefined;
  const [name, setName] = useState(cap?.name ?? ''); const [description, setDescription] = useState(cap?.description ?? '');
  const [connectionId, setConnectionId] = useState(spec?.connectionId ?? ''); const [server, setServer] = useState(spec?.server ?? '');
  const [approval, setApproval] = useState<Approval>(spec?.approval ?? 'always'); const [allow, setAllow] = useState<string[]>(spec?.tools.map(t => t.name) ?? []);
  const [tools, setTools] = useState<DiscoveredTool[]>(); const [drift, setDrift] = useState<DriftResult>();
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [changed, setChanged] = useState(!spec);
  // A server added inline is usable at once, before the parent's connection list reloads.
  const [created, setCreated] = useState<ServiceConnection[]>([]);
  const mcpConnections = [...connections, ...created.filter(c => !connections.some(x => x.id === c.id))].filter(c => c.kind === 'mcp');
  const pinned = new Map(spec?.tools.map(t => [t.name, t]) ?? []);
  const discover = async () => {
    setBusy('discover'); setError('');
    try { const result = await request<{ tools: DiscoveredTool[] }>('POST', `/api/agent-service-connections/${enc(connectionId)}/discover`, { project }); setTools(result.tools); setAllow(list => list.filter(n => result.tools.some(t => t.name === n))); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const publish = async () => {
    setBusy('publish'); setError('');
    try { const result = await request<{ capability: AgentCapability }>('POST', cap ? `/api/agent-capabilities/${enc(cap.id)}` : '/api/agent-capabilities', { project, name, description, spec: { kind: 'mcp', connectionId, server, approval, allow }, expectedVersion: cap?.version }); setChanged(false); onSaved(result.capability); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const test = async () => {
    setBusy('test'); setError(''); setDrift(undefined);
    try { setDrift((await request<{ result: DriftResult }>('POST', `/api/agent-capabilities/${enc(cap!.id)}/test`, { project, input: {}, expectedVersion: cap!.version })).result); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const serverValid = SERVER_PATTERN.test(server);
  const listed = tools ?? spec?.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, schemaHash: t.schemaHash, annotations: { readOnlyHint: t.readOnlyHint, destructiveHint: t.destructiveHint } }));
  const canPublish = !busy && changed && !!name.trim() && !!connectionId && serverValid && allow.length > 0 && allow.length <= MAX_ALLOWED_TOOLS;
  return <section className="platform-capability-editor" aria-label="MCP capability editor">
    <form className="platform-form" onChange={() => setChanged(true)} onSubmit={e => { e.preventDefault(); if (canPublish) void publish(); }}>
      <h2>{cap ? `${cap.name} · version ${cap.version}` : 'New capability'}</h2>
      <label>Name<input className="text-input" value={name} required maxLength={100} onChange={e => setName(e.target.value)} /></label>
      {kindPicker}
      <label className="platform-wide">Description<textarea className="text-input" rows={2} maxLength={2000} value={description} onChange={e => setDescription(e.target.value)} /></label>
      {mcpConnections.length ? <label>MCP server connection<select aria-label="MCP server connection" className="text-input" required value={connectionId} onChange={e => { setConnectionId(e.target.value); setTools(undefined); }}><option value="">Choose a saved MCP server</option>{mcpConnections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><small>Saved servers in this project. Add more in Connections.</small></label>
        : <InlineMcpServer project={project} onCreated={c => { setCreated(list => [...list, c]); onConnectionCreated(c); setConnectionId(c.id); setTools(undefined); setChanged(true); if (!server) setServer(c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 's$1').slice(0, 24)); if (!name) setName(c.name); }} />}
      <div className="mcp-discover"><button type="button" className="btn" disabled={!connectionId || !!busy} onClick={() => { void discover(); }}><Icon name="search" size={14} />{busy === 'discover' ? 'Discovering…' : tools ? 'Discover again' : 'Discover tools'}</button><small>Lists the tools the server offers right now.</small></div>
      {listed && <fieldset className="mcp-tool-picker platform-wide"><legend>Tools this agent may see · {allow.length} of {listed.length} selected</legend>
        {!listed.length ? <p className="platform-help">The server offers no tools.</p> : <ul>{listed.map(t => {
          const prior = pinned.get(t.name); const drifted = !!tools && !!prior && prior.schemaHash !== t.schemaHash;
          return <li key={t.name}><label className="platform-check"><input type="checkbox" checked={allow.includes(t.name)} disabled={!allow.includes(t.name) && allow.length >= MAX_ALLOWED_TOOLS} onChange={e => setAllow(list => e.target.checked ? [...list, t.name] : list.filter(n => n !== t.name))} /><code>{t.name}</code></label>
            <div className="agent-tool-badges">{t.annotations.readOnlyHint === true && <StatusBadge>Server hint: read-only</StatusBadge>}{t.annotations.destructiveHint === true && <StatusBadge tone="warning">Server hint: destructive</StatusBadge>}{drifted && <StatusBadge tone="warning">Changed since v{cap!.version}</StatusBadge>}</div>
            {t.description && <p>{t.description}</p>}</li>;
        })}</ul>}
      </fieldset>}
      <label>Server name<input className="text-input" required maxLength={24} value={server} aria-invalid={!!server && !serverValid} onChange={e => setServer(e.target.value)} placeholder="e.g. github" /><small>{server && !serverValid ? 'Lowercase letters, digits and underscores, starting with a letter (24 max).' : `Prefixes every tool name the model sees, e.g. ${exposedName(server || 'server', allow[0] ?? 'tool')}.`}</small></label>
      <fieldset className="mcp-approval platform-wide"><legend>Approval</legend>
        <label className="platform-check"><input type="radio" name="mcp-approval" checked={approval === 'always'} onChange={() => setApproval('always')} />Ask before every call</label>
        <label className="platform-check"><input type="radio" name="mcp-approval" checked={approval === 'trust_read_only'} onChange={() => setApproval('trust_read_only')} />Run tools the server marks read-only without asking</label>
        {approval === 'trust_read_only' && <p className="platform-help">Read-only and destructive hints come from the MCP server and are not verified. A server that mislabels a tool could run writes without asking. Tools without a read-only hint, or marked destructive, still ask.</p>}
      </fieldset>
      <p className="platform-wide platform-help">Publishing re-lists the server and pins each selected tool's definition. If the server later changes a pinned tool, that tool is blocked until you publish a new version.</p>
      <div className="arch-actions platform-wide"><button className="btn btn-go" disabled={!canPublish}>{busy === 'publish' ? 'Publishing…' : cap ? 'Publish new version' : 'Publish capability'}</button><button type="button" className="btn" onClick={onClose}>Close editor</button>{!allow.length && <small>Select at least one tool.</small>}{cap && <small>Existing deployments keep v{cap.version}.</small>}</div>
    </form>
    {cap && spec && <div className="platform-capability-test"><h3>Test saved version {cap.version}</h3><button className="btn" disabled={!!busy || changed} onClick={() => { void test(); }}>{busy === 'test' ? 'Checking…' : 'Check server for drift'}</button><p className="platform-help">{changed ? 'Publish changes before testing.' : 'Re-lists the server and compares every pinned tool. Does not call any tool.'}</p></div>}
    {error && <p className="arch-error" role="alert">{error}</p>}
    {drift && <div className="mcp-drift" aria-label="MCP drift check"><p className={drift.ok ? 'platform-success' : 'arch-error'} role="status">{drift.message}</p>
      <div className="agent-table-scroll"><table><thead><tr><th scope="col">Tool</th><th scope="col">Model sees</th><th scope="col">Status</th></tr></thead><tbody>{drift.tools.map(t => <tr key={t.name}><td><code>{t.name}</code></td><td><code>{t.exposedAs}</code></td><td><StatusBadge tone={t.status === 'ok' ? 'success' : t.status === 'changed' ? 'warning' : 'error'}>{DRIFT_LABEL[t.status]}</StatusBadge></td></tr>)}</tbody></table></div>
    </div>}
  </section>;
}
