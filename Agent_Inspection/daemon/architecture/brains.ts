import { randomUUID } from 'node:crypto';
import type { LibraryDeps } from '../library/deps.ts';
import { LibraryInputError } from '../library/types.ts';
import { folderRoot } from '../files/folderFiles.ts';
import { folder } from '../../web/src/stationOffices.ts';
import type { BrainConnection, BrainProvider } from '../../shared/agentBrains.ts';
import { runModelConversation, type ModelRunOptions } from './modelLoop.ts';
import { AgentSecrets } from './secrets.ts';

type ConnectionRecord = Omit<BrainConnection, 'hasKey'> & { keyRequired?: boolean };
const secretName = (id: string) => `architecture-brain:${id}:apiKey`;
export function brainBaseUrl(provider: BrainProvider, raw: unknown): string {
  if (provider === 'openai') return 'https://api.openai.com/v1';
  if (provider === 'anthropic') return 'https://api.anthropic.com/v1';
  let url: URL;
  try { url = new URL(typeof raw === 'string' ? raw : ''); } catch { throw new LibraryInputError('Enter a valid API base URL.'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.href.length > 1000) throw new LibraryInputError('Use HTTPS, or HTTP on localhost. Keep credentials and query parameters out of the base URL.');
  return url.href.replace(/\/+$/, '');
}

/** Operator-only connection management. Graphs and MCP see ids, never secret values. */
export class BrainConnections {
  constructor(private readonly deps: LibraryDeps, private readonly send: typeof fetch = fetch) {}
  private view(record: ConnectionRecord): BrainConnection { return { ...record, hasKey: this.deps.secrets.has(secretName(record.id)) }; }
  private record(id: unknown, project: string): ConnectionRecord {
    const r = this.deps.store.loadRecords<ConnectionRecord>('brain_connections').find(r => r.id === id);
    if (!r || folder(r.project)?.key !== folder(project)?.key) throw new LibraryInputError('LLM connection not found in this project.');
    return r;
  }
  list(project: string): BrainConnection[] { return this.deps.store.loadRecords<ConnectionRecord>('brain_connections').filter(r => folder(r.project)?.key === folder(project)?.key).map(r => this.view(r)); }
  create(project: string, raw: Record<string, unknown>): BrainConnection {
    if (this.list(project).length >= 30) throw new LibraryInputError('A project supports up to 30 LLM connections.');
    if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 80) throw new LibraryInputError('Name the connection (up to 80 characters).');
    if (!['openai', 'anthropic', 'compatible'].includes(String(raw.provider))) throw new LibraryInputError('Choose OpenAI, Anthropic, or an OpenAI-compatible endpoint.');
    if (typeof raw.model !== 'string' || !raw.model.trim() || raw.model.length > 200 || /[\r\n]/.test(raw.model)) throw new LibraryInputError('Enter the model id for this connection.');
    const provider = raw.provider as BrainProvider;
    if (raw.workspaceId !== undefined && (typeof raw.workspaceId !== 'string' || (raw.workspaceId !== '' && !/^[A-Za-z0-9_-]{1,100}$/.test(raw.workspaceId)))) throw new LibraryInputError('Enter a valid Anthropic workspace id.');
    const record: ConnectionRecord = { id: randomUUID(), project: folderRoot(project), label: raw.label.trim(), provider, model: raw.model.trim(), baseUrl: brainBaseUrl(provider, raw.baseUrl), createdAt: Date.now() };
    if (provider === 'anthropic' && typeof raw.workspaceId === 'string' && raw.workspaceId) record.workspaceId = raw.workspaceId;
    if (raw.apiKey !== undefined && (typeof raw.apiKey !== 'string' || raw.apiKey.length > 8192 || /[\r\n]/.test(raw.apiKey))) throw new LibraryInputError('The API key must be a single line under 8192 characters.');
    const key = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
    const savedRef = raw.secretId ? new AgentSecrets(this.deps).reference(record.project, raw.secretId, 'api-key') : undefined;
    record.keyRequired = !!key || !!savedRef;
    if (!key && !savedRef && provider !== 'compatible') throw new LibraryInputError('An API key or saved secret is required for this provider.');
    if (savedRef) this.deps.secrets.alias(secretName(record.id), savedRef); else if (key) this.deps.secrets.set(secretName(record.id), key);
    try { this.deps.store.saveRecord('brain_connections', record); } catch (e) { this.deps.secrets.delete(secretName(record.id)); throw e; }
    this.deps.audit('architecture_brain_create', record.id, { provider, hasKey: !!key || !!savedRef });
    return this.view(record);
  }
  replaceKey(id: unknown, project: string, raw: unknown): BrainConnection {
    const record = this.record(id, project);
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 8192 || /[\r\n]/.test(raw)) throw new LibraryInputError('Enter a nonempty API key on a single line.');
    this.deps.secrets.set(secretName(record.id), raw.trim());
    record.keyRequired = true; this.deps.store.saveRecord('brain_connections', record);
    this.deps.audit('architecture_brain_key_update', record.id, { provider: record.provider });
    return this.view(record);
  }
  sanitize(project: string, text: string): string {
    for (const c of this.list(project)) { const value = this.deps.secrets.get(secretName(c.id)); if (value) text = text.split(value).join('[redacted]'); }
    return new AgentSecrets(this.deps).sanitize(project, text);
  }
  async run(id: unknown, project: string, role: string, input: string, options: ModelRunOptions) {
    const connection = this.record(id, project); const key = this.deps.secrets.get(secretName(connection.id));
    if (!key && (connection.provider !== 'compatible' || connection.keyRequired || this.deps.secrets.reference(secretName(connection.id)))) throw new LibraryInputError('This connection has no usable API key. Replace its saved secret or connection key.');
    const result = await runModelConversation(connection, key, role, input, options, this.send);
    this.deps.audit('architecture_brain_test', connection.id, { provider: connection.provider, model: result.model });
    return result;
  }
}
