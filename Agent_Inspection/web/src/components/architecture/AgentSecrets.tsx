import { useCallback, useEffect, useState } from 'react';
import type { AgentSecret } from '../../../../shared/agentSecrets.ts';
import { request } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { ResourceMark, StatusBadge, WorkspaceEmpty } from './ArchitectureUI.tsx';

export function SavedSecretPicker({ project, kind, value, onChange }: { project: string; kind: AgentSecret['kind']; value: string; onChange: (id: string) => void }) {
  const [secrets, setSecrets] = useState<AgentSecret[]>([]); const [error, setError] = useState('');
  useEffect(() => { let active = true; void request<{ secrets: AgentSecret[] }>('GET', `/api/agent-secrets?project=${encodeURIComponent(project)}`).then(r => { if (active) setSecrets(r.secrets); }, e => { if (active) setError(e.message); }); return () => { active = false; }; }, [project]);
  return <label>Saved secret<select aria-label="Saved secret" className="text-input" value={value} onChange={e => onChange(e.target.value)}><option value="">Enter a value for this connection</option>{secrets.filter(s => s.kind === kind && s.hasValue).map(s => <option key={s.id} value={s.id}>{s.name} · {s.scope === 'workspace' ? 'workspace' : 'project'}</option>)}</select><small>{error || 'Save a value once in Secrets, then reuse it here. Agents receive capability access, never the secret value.'}</small></label>;
}

export function AgentSecretsView({ project }: { project: string }) {
  const [secrets, setSecrets] = useState<AgentSecret[]>([]); const [name, setName] = useState(''); const [kind, setKind] = useState<AgentSecret['kind']>('api-key'); const [scope, setScope] = useState<AgentSecret['scope']>('workspace'); const [value, setValue] = useState(''); const [editing, setEditing] = useState<AgentSecret>(); const [error, setError] = useState(''); const [success, setSuccess] = useState(''); const [busy, setBusy] = useState(false); const [query, setQuery] = useState('');
  const load = useCallback(async () => { try { setSecrets((await request<{ secrets: AgentSecret[] }>('GET', '/api/agent-secrets')).secrets); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async () => { setBusy(true); setError(''); setSuccess(''); try { await request('POST', editing ? `/api/agent-secrets/${encodeURIComponent(editing.id)}/value` : '/api/agent-secrets', { name, kind, scope, project, value }); setValue(''); setName(''); setEditing(undefined); setSuccess('Secret saved. Connections that reference it use the current value.'); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const revoke = async (s: AgentSecret) => { setBusy(true); setError(''); try { await request('POST', `/api/agent-secrets/${encodeURIComponent(s.id)}/revoke`, {}); setSuccess('Secret revoked. Its linked connections cannot authenticate until a new value is saved.'); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const visible = secrets.filter(s => `${s.name} ${s.kind} ${s.project ?? 'workspace'}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="agent-platform agent-secrets" aria-label="Central secrets">
    <header className="platform-heading"><div><h1>Secrets</h1><p>One place for your model keys, API credentials and database passwords. Reuse references across agent connections.</p></div><button className="btn btn-small" onClick={() => { void load(); }}><Icon name="refresh" size={14} />Refresh secrets</button></header>
    {error && <p className="arch-error" role="alert">{error}</p>}{success && <p className="platform-success" role="status"><Icon name="check" size={16} />{success}</p>}
    <div className="platform-split-layout">
      <div className="platform-inventory">
        <div className="platform-inventory-heading"><h2>Saved credentials <span className="platform-count">{secrets.length}</span></h2><Icon name="shield" size={17} /></div>
        <label className="platform-search">Find a secret<div className="platform-search-field"><Icon name="search" size={16} /><input className="text-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Name, type, or project" /></div></label>
        <ul className="platform-resource-list">{visible.map(s => <li key={s.id}>
          <div className="platform-resource-identity"><ResourceMark icon="shield" /><div><strong>{s.name}</strong><p>{s.kind} · {s.scope === 'workspace' ? 'All projects' : s.project}</p><div className="platform-resource-meta"><StatusBadge tone={s.hasValue ? 'success' : 'warning'}>{s.hasValue ? 'Value saved' : 'Revoked or missing'}</StatusBadge><small>{s.usages.length ? `${s.usages.length} linked connections` : s.legacy ? 'Existing connection credential' : 'Ready to assign to a connection'}</small></div></div></div>
          <div className="platform-resource-actions"><button className="btn btn-small" disabled={busy} onClick={() => { setEditing(s); setValue(''); setSuccess(''); }}>Replace value</button><button className="btn btn-small platform-danger" disabled={busy || !s.hasValue} onClick={() => { void revoke(s); }}>Revoke secret</button></div>
        </li>)}</ul>
        {!visible.length && <WorkspaceEmpty icon="shield" title={query ? 'No matching secrets' : 'Your credentials, in one place'}>{query ? 'Try a different name, type, or project.' : 'Save a credential here, then select it when connecting a model or service. Agents only use the capabilities you assign.'}</WorkspaceEmpty>}
      </div>
      <form className="platform-form platform-secret-form" onSubmit={e => { e.preventDefault(); void save(); }}>
        <h2>{editing ? `Replace value: ${editing.name}` : 'Save a secret'}</h2>
        {!editing && <><label className="platform-wide">Secret name<input className="text-input" value={name} required maxLength={100} onChange={e => setName(e.target.value)} placeholder="Research search key" /></label><label>Secret type<select aria-label="Secret type" className="text-input" value={kind} onChange={e => setKind(e.target.value as AgentSecret['kind'])}><option value="api-key">API key</option><option value="authorization">Complete authorization header</option><option value="password">Database password</option></select></label><label>Secret scope<select aria-label="Secret scope" className="text-input" value={scope} onChange={e => setScope(e.target.value as AgentSecret['scope'])}><option value="workspace">Workspace · reusable across projects</option><option value="project" disabled={!project}>Current project only</option></select></label></>}
        <label className="platform-wide">Secret value<input aria-label="Secret value" className="text-input" type="password" autoComplete="new-password" spellCheck={false} value={value} onChange={e => setValue(e.target.value)} required maxLength={8100} /></label>
        <p className="platform-help platform-wide">Values are write-only. Assign them through LLM or Service connections, then attach the corresponding capabilities to an agent. Replacing a value updates its linked consumers; revoking it blocks their authentication. Hosted workers encrypt credentials at rest using a separately mounted key. Local encryption follows the server configuration.</p>
        <div className="arch-actions platform-form-footer platform-wide"><button className="btn btn-go" disabled={busy}><Icon name={editing ? 'refresh' : 'plus'} size={15} />{busy ? 'Saving…' : editing ? 'Replace saved value' : 'Save secret'}</button>{editing && <button className="btn" type="button" onClick={() => { setEditing(undefined); setValue(''); }}>Cancel replacement</button>}</div>
      </form>
    </div>
  </section>;
}
