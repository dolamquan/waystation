import { randomUUID } from 'node:crypto';
import type { LibraryDeps } from '../library/deps.ts';
import { LibraryInputError } from '../library/types.ts';
import { folderRoot } from '../files/folderFiles.ts';
import { folder } from '../../web/src/stationOffices.ts';
import type { AgentSecret } from '../../shared/agentSecrets.ts';
import type { BrainConnection } from '../../shared/agentBrains.ts';
import type { ServiceConnection } from '../../shared/agentPlatform.ts';

interface SecretRecord extends Omit<AgentSecret, 'hasValue' | 'usages'> { storageKey: string }
const same = (a?: string, b?: string) => !!a && !!b && folder(a)?.key === folder(b)?.key;
export class AgentSecrets {
  constructor(private readonly deps: LibraryDeps) {}
  private records(): SecretRecord[] {
    const saved = this.deps.store.loadRecords<SecretRecord>('agent_secrets');
    const brains = this.deps.store.loadRecords<BrainConnection>('brain_connections').map(c => ({ id: `brain_${c.id}`, name: c.label, kind: 'api-key' as const, scope: 'project' as const, project: c.project, createdAt: c.createdAt, storageKey: `architecture-brain:${c.id}:apiKey`, legacy: true }));
    const serviceRecords = this.deps.store.loadRecords<ServiceConnection>('agent_service_connections');
    const services = serviceRecords.map(c => ({ id: `service_${c.id}`, name: c.name, kind: c.kind === 'postgres' ? 'password' as const : 'authorization' as const, scope: 'project' as const, project: c.project, createdAt: c.createdAt, storageKey: `architecture-resource:${c.id}:${c.kind === 'postgres' ? 'password' : 'authorization'}`, legacy: true }));
    const resources = this.deps.store.loadRecords<{ id: string; project: string; createdAt: number }>('architecture_credentials').filter(c => !serviceRecords.some(s => s.id === c.id)).flatMap(c => (['password', 'authorization'] as const).filter(name => this.deps.secrets.has(`architecture-resource:${c.id}:${name}`)).map(name => ({ id: `resource_${c.id}_${name}`, name: `Resource ${name} · ${c.id.slice(0, 8)}`, kind: name, scope: 'project' as const, project: c.project, createdAt: c.createdAt, storageKey: `architecture-resource:${c.id}:${name}`, legacy: true })));
    return [...saved, ...brains, ...services, ...resources].filter(r => !this.deps.secrets.reference(r.storageKey));
  }
  private record(id: unknown): SecretRecord { const r = this.records().find(r => r.id === id); if (!r) throw new LibraryInputError('Saved secret not found.'); return r; }
  list(project?: string): AgentSecret[] {
    return this.records().filter(r => !project || r.scope === 'workspace' || same(r.project, project)).map(({ storageKey, ...r }) => ({ ...r, hasValue: this.deps.secrets.has(storageKey), usages: this.deps.secrets.referencesTo(storageKey).map(key => key.startsWith('architecture-brain:') ? 'LLM connection' : key.startsWith('architecture-resource:') ? 'Service/resource connection' : 'Connection') }));
  }
  save(raw: Record<string, unknown>, id?: string): AgentSecret {
    const previous = id ? this.record(id) : undefined;
    if (typeof raw.value !== 'string' || !raw.value.trim() || raw.value.length > 8100 || /[\r\n]/.test(raw.value)) throw new LibraryInputError('Enter a nonempty single-line secret under 8100 characters.');
    let r: SecretRecord;
    if (previous) r = previous;
    else {
      if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 100) throw new LibraryInputError('Name the secret (up to 100 characters).');
      if (!['api-key', 'authorization', 'password'].includes(String(raw.kind)) || !['workspace', 'project'].includes(String(raw.scope))) throw new LibraryInputError('Choose a secret type and scope.');
      let project: string | undefined; if (raw.scope === 'project') { try { project = folderRoot(raw.project); } catch (e) { throw new LibraryInputError((e as Error).message); } }
      const secretId = randomUUID(); r = { id: secretId, name: raw.name.trim(), kind: raw.kind as AgentSecret['kind'], scope: raw.scope as AgentSecret['scope'], project, createdAt: Date.now(), storageKey: `agent-vault:${secretId}:value` };
    }
    this.deps.secrets.set(r.storageKey, raw.value.trim()); if (!r.legacy) this.deps.store.saveRecord('agent_secrets', r);
    this.deps.audit(previous ? 'agent_secret_replace' : 'agent_secret_create', r.id, { kind: r.kind, scope: r.scope }); return this.list().find(s => s.id === r.id)!;
  }
  revoke(id: string): void { const r = this.record(id); if (r.storageKey.startsWith('architecture-brain:')) { const brainId = r.storageKey.split(':')[1]; const brain = this.deps.store.loadRecord<BrainConnection>('brain_connections', brainId); if (brain) this.deps.store.saveRecord('brain_connections', { ...brain, keyRequired: true }); } this.deps.secrets.delete(r.storageKey); this.deps.audit('agent_secret_revoke', id, {}); }
  reference(project: string, id: unknown, kind: AgentSecret['kind']): string {
    const r = this.record(id); if (r.scope !== 'workspace' && !same(r.project, project)) throw new LibraryInputError('This secret is unavailable in the selected project.');
    if (r.kind !== kind) throw new LibraryInputError(`Select a saved ${kind} secret.`); if (!this.deps.secrets.has(r.storageKey)) throw new LibraryInputError('This secret is revoked. Replace its value before using it.'); return r.storageKey;
  }
  sanitize(project: string, text: string): string { for (const r of this.records().filter(r => r.scope === 'workspace' || same(r.project, project))) { const value = this.deps.secrets.get(r.storageKey); if (value) text = text.split(value).join('[redacted]'); } return text; }
}
