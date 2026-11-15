import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { LibraryDeps } from '../library/deps.ts';
import { LibraryInputError } from '../library/types.ts';
import { folderRoot } from '../files/folderFiles.ts';
import { folder } from '../../web/src/stationOffices.ts';
import { resourceUrl, validateResource, type ToolConfig } from '../../shared/agentResources.ts';
import { validateArchitecture, type ArchitectureDocument, type ArchitectureNode } from '../../shared/architecture.ts';
import type { AgentCapability, AgentConversationRecord, AgentDeployment, AgentEnvironment, AgentPlatformState, AgentTrigger, CapabilitySpec, DeploymentDetail, DeploymentSummary, ServiceConnection } from '../../shared/agentPlatform.ts';
import { ACTIVE_AGENT_RUNS } from '../../shared/agentRuns.ts';
import type { ArchitectureStore } from './store.ts';
import type { AgentRuns } from './runs.ts';
import type { BrainConnections } from './brains.ts';
import { AgentResources, checkNetwork, validateJson } from './resources.ts';
import { tokensMatch } from '../api/security.ts';
import { TeamAuthError } from '../teams/teamManager.ts';
import { AgentSecrets } from './secrets.ts';
import { validateSandbox } from '../../shared/agentEvaluation.ts';

const same = (a: string, b: string) => folder(a)?.key === folder(b)?.key;
const rootProject = (project: string): string => { try { return folderRoot(project); } catch (e) { throw new LibraryInputError((e as Error).message); } };
const text = (value: unknown, label: string, max = 100): string => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new LibraryInputError(`${label} is required (up to ${max} characters).`); return value.trim(); };
const integer = (value: unknown, min: number, max: number, label: string): number => { if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new LibraryInputError(`${label} must be between ${min} and ${max}.`); return value as number; };
const hosts = (raw: unknown): string[] => { if (!Array.isArray(raw) || raw.length > 50 || raw.some(v => typeof v !== 'string' || !/^(?:[a-zA-Z0-9.-]+|\[::1\])$/.test(v) || v.length > 253)) throw new LibraryInputError('Enter up to 50 exact host names without protocols, paths or wildcards.'); return [...new Set(raw as string[])]; };
type CapabilityRecord = { id: string; versions: AgentCapability[] };
type ConnectionRecord = Omit<ServiceConnection, 'hasSecret'>;

/** Local control plane. Definitions/versions are data; credentials resolve only in the executor. */
export class AgentPlatform {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  constructor(private readonly deps: LibraryDeps, private readonly architectures: ArchitectureStore, private readonly brains: BrainConnections, private readonly resources: AgentResources, private readonly runs: AgentRuns) { runs.prepareDraft = (doc, nodeId) => this.expand(doc, nodeId).definition; runs.authorizeRetry = execution => { if (this.deployment(execution.deploymentId).status !== 'active') throw new LibraryInputError('Resume this deployment before retrying work.'); }; }
  start(): void { if (!this.timer) { this.timer = setInterval(() => { void this.tick(); }, 1000); this.timer.unref(); } }
  shutdown(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  state(project: string): AgentPlatformState {
    const root = rootProject(project); this.defaultEnvironment(root);
    return { environments: this.deps.store.loadRecords<AgentEnvironment>('agent_environments').filter(e => same(e.project, root)), deployments: this.deployments().filter(d => same(d.project, root)).map(d => this.summary(d)), capabilities: this.capabilities(root), connections: this.connections(root) };
  }
  capabilities(project: string): AgentCapability[] { return this.deps.store.loadRecords<CapabilityRecord>('agent_capabilities').flatMap(r => r.versions.at(-1) ?? []).filter(c => same(c.project, project)); }
  capability(project: string, id: unknown, version?: unknown): AgentCapability {
    const record = this.deps.store.loadRecord<CapabilityRecord>('agent_capabilities', String(id)); const cap = version === undefined ? record?.versions.at(-1) : record?.versions.find(c => c.version === version);
    if (!cap || !same(cap.project, project)) throw new LibraryInputError('Capability version not found in this project.'); return cap;
  }
  saveCapability(project: string, raw: Record<string, unknown>, id?: string): AgentCapability {
    const root = rootProject(project); const prior = id ? this.capability(root, id) : undefined;
    if (prior && prior.version !== raw.expectedVersion) throw new LibraryInputError('This capability changed. Reload before publishing a new version.');
    if (!prior && this.capabilities(root).length >= 200) throw new LibraryInputError('A project supports up to 200 capabilities.');
    const source = raw.spec as Record<string, unknown>; if (!source || typeof source !== 'object') throw new LibraryInputError('Configure the capability.');
    let spec: CapabilitySpec;
    if (source.kind === 'skill') {
      if (!Array.isArray(source.requires) || source.requires.length > 20 || source.requires.some(v => typeof v !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v))) throw new LibraryInputError('Skill dependencies must be tool function names.');
      spec = { kind: 'skill', instructions: text(source.instructions, 'Skill instructions', 6000), requires: [...new Set(source.requires as string[])] };
    } else if (source.kind === 'tool' || source.kind === 'memory') {
      try { const config = validateResource(source.kind, source.config); if (config.type !== 'tool' && config.type !== 'memory') throw new Error('Choose a tool or memory backend.'); if ('inputSchema' in config) { try { validateJson(config.inputSchema, {}); } catch (e) { if (!(e instanceof LibraryInputError) || !e.message.startsWith('Data does not match')) throw e; } } spec = { kind: source.kind, config } as CapabilitySpec; }
      catch (e) { throw new LibraryInputError((e as Error).message); }
      if ('config' in spec && 'credentialId' in spec.config && spec.config.credentialId) this.resources.credentialStatus(root, { kind: source.kind, config: spec.config } as ArchitectureNode);
    } else if (source.kind === 'tavily') {
      const connection = this.connection(root, source.connectionId); if (connection.kind !== 'tavily') throw new LibraryInputError('Select a Tavily connection.');
      const functionName = text(source.functionName, 'Function name', 64); if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(functionName)) throw new LibraryInputError('Use a valid tool function name.');
      if (!['basic', 'advanced'].includes(String(source.searchDepth))) throw new LibraryInputError('Choose a search depth.');
      spec = { kind: 'tavily', connectionId: connection.id, functionName, maxResults: integer(source.maxResults, 1, 10, 'Search result limit'), searchDepth: source.searchDepth as 'basic' | 'advanced', includeDomains: hosts(source.includeDomains ?? []), excludeDomains: hosts(source.excludeDomains ?? []) };
    } else throw new LibraryInputError('Choose a skill, tool, memory, or Tavily integration.');
    const cap: AgentCapability = { id: prior?.id ?? randomUUID(), project: root, version: (prior?.version ?? 0) + 1, name: text(raw.name, 'Capability name'), description: typeof raw.description === 'string' && raw.description.length <= 2000 ? raw.description : '', spec, createdAt: Date.now() };
    const previous = prior ? this.deps.store.loadRecord<CapabilityRecord>('agent_capabilities', prior.id)!.versions : [];
    this.deps.store.saveRecord('agent_capabilities', { id: cap.id, versions: [...previous, cap] }); this.deps.audit('agent_capability_publish', cap.id, { version: cap.version, kind: spec.kind }); return cap;
  }
  private connection(project: string, id: unknown): ConnectionRecord {
    const c = this.deps.store.loadRecord<ConnectionRecord>('agent_service_connections', String(id)); if (!c || !same(c.project, project)) throw new LibraryInputError('Service connection not found in this project.'); return c;
  }
  connections(project: string): ServiceConnection[] { return this.deps.store.loadRecords<ConnectionRecord>('agent_service_connections').filter(c => same(c.project, project)).map(c => ({ ...c, hasSecret: this.resources.hasCredential(project, c.id, c.kind === 'postgres' ? 'password' : 'authorization') })); }
  saveConnection(project: string, raw: Record<string, unknown>, id?: string): ServiceConnection {
    const root = rootProject(project); const previous = id ? this.connection(root, id) : undefined;
    if (raw.secretId) {
      const kind = previous?.kind ?? raw.kind; if (!['tavily', 'http', 'postgres'].includes(String(kind))) throw new LibraryInputError('Choose a service connection type.');
      const source = new AgentSecrets(this.deps).reference(root, raw.secretId, kind === 'tavily' ? 'api-key' : kind === 'postgres' ? 'password' : 'authorization');
      const name = previous?.name ?? text(raw.name, 'Connection name');
      const credentialId = this.resources.linkCredential(root, kind === 'postgres' ? 'password' : 'authorization', source, previous?.id, kind === 'tavily' ? 'Bearer ' : '');
      const record: ConnectionRecord = previous ?? { id: credentialId, project: root, name, kind: kind as ServiceConnection['kind'], ...(kind === 'tavily' ? { endpoint: 'https://api.tavily.com/search' } : {}), createdAt: Date.now() };
      this.deps.store.saveRecord('agent_service_connections', record); return this.connections(root).find(c => c.id === record.id)!;
    }
    if (previous) { this.resources.storeCredential(root, previous.kind === 'postgres' ? 'password' : 'authorization', previous.kind === 'tavily' ? `Bearer ${text(raw.secret, 'Tavily API key', 8100)}` : raw.secret, previous.id); return this.connections(root).find(c => c.id === previous.id)!; }
    if (!['tavily', 'http', 'postgres'].includes(String(raw.kind))) throw new LibraryInputError('Choose a service connection type.');
    if (this.connections(root).length >= 100) throw new LibraryInputError('A project supports up to 100 service connections.');
    const kind = raw.kind as ServiceConnection['kind']; const name = text(raw.name, 'Connection name');
    let endpoint: string | undefined;
    if (kind === 'tavily') { endpoint = raw.endpoint ? resourceUrl(raw.endpoint) : 'https://api.tavily.com/search'; const u = new URL(endpoint); if (u.hostname !== 'api.tavily.com' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new LibraryInputError('Use the Tavily API or a localhost test endpoint.'); }
    const secret = kind === 'tavily' ? `Bearer ${text(raw.secret, 'Tavily API key', 8100)}` : raw.secret;
    const credentialId = this.resources.storeCredential(root, kind === 'postgres' ? 'password' : 'authorization', secret);
    const record: ConnectionRecord = { id: credentialId, project: root, name, kind, ...(endpoint ? { endpoint } : {}), createdAt: Date.now() };
    this.deps.store.saveRecord('agent_service_connections', record); this.deps.audit('agent_service_connection_create', record.id, { kind }); return this.connections(root).find(c => c.id === record.id)!;
  }
  defaultEnvironment(project: string): AgentEnvironment {
    const existing = this.deps.store.loadRecords<AgentEnvironment>('agent_environments').find(e => same(e.project, project));
    return existing ?? this.saveEnvironment(project, { name: 'Local', maxConcurrentRuns: 3, network: 'configured', allowedHosts: [] });
  }
  private environment(project: string, id: unknown): AgentEnvironment { const e = this.deps.store.loadRecord<AgentEnvironment>('agent_environments', String(id)); if (!e || !same(e.project, project)) throw new LibraryInputError('Environment not found in this project.'); return e; }
  saveEnvironment(project: string, raw: Record<string, unknown>, id?: string): AgentEnvironment {
    const root = rootProject(project); const previous = id ? this.environment(root, id) : undefined;
    if (previous && raw.expectedRevision !== previous.revision) throw new LibraryInputError('Environment changed. Reload before saving.');
    if (!['configured', 'restricted'].includes(String(raw.network))) throw new LibraryInputError('Choose a network policy.');
    const env: AgentEnvironment = { id: previous?.id ?? randomUUID(), project: root, name: text(raw.name, 'Environment name'), runtime: 'local', revision: (previous?.revision ?? 0) + 1, maxConcurrentRuns: integer(raw.maxConcurrentRuns, 1, 6, 'Concurrent runs'), network: raw.network as AgentEnvironment['network'], allowedHosts: hosts(raw.allowedHosts ?? []), createdAt: previous?.createdAt ?? Date.now() };
    if (raw.sandbox) { try { env.sandbox = validateSandbox(raw.sandbox); } catch (e) { throw new LibraryInputError((e as Error).message); } }
    this.deps.store.saveRecord('agent_environments', env); return env;
  }
  private expand(doc: ArchitectureDocument, nodeId: string): { definition: ArchitectureDocument; capabilities: AgentCapability[] } {
    const definition = structuredClone(doc); const node = definition.nodes.find(n => n.id === nodeId);
    if (!node || node.kind !== 'agent' || !node.runtime || !node.description.trim()) throw new LibraryInputError('Save an agent brain and role before deploying.');
    const capabilities = (node.capabilities ?? []).map(ref => this.capability(doc.project, ref.id, ref.version));
    for (const c of capabilities) {
      if (c.spec.kind === 'skill') { node.description += `\n\nSkill: ${c.name}\n${c.spec.instructions}`; continue; }
      const config = c.spec.kind === 'tavily' ? this.tavilyConfig(doc.project, c.spec) : c.spec.config;
      const id = `cap_${c.id.replaceAll('-', '_')}`;
      if (definition.nodes.some(n => n.id === id)) throw new LibraryInputError('A capability conflicts with a graph node id.');
      definition.nodes.push({ id, kind: config.type, name: c.name, description: c.description, x: node.x, y: node.y + 160, config });
      definition.edges.push({ id: `bind_${c.id}`, source: node.id, target: id, label: `Capability v${c.version}` });
    }
    const toolNames = this.resources.connected(definition, node.id, 'tool').map(n => (n.config as ToolConfig | undefined)?.functionName).filter(Boolean);
    if (new Set(toolNames).size !== toolNames.length) throw new LibraryInputError('Attached tools must have unique function names.');
    for (const c of capabilities) if (c.spec.kind === 'skill') for (const required of c.spec.requires) if (!toolNames.includes(required) || node.runtime.policy === 'chat-only') throw new LibraryInputError(`Skill “${c.name}” requires enabled tool “${required}”. Attach it and enable tool access.`);
    if (node.runtime.kind === 'api') { const brain = this.brains.list(doc.project).find(b => b.id === node.runtime!.connectionId); if (!brain) throw new LibraryInputError('Choose an LLM connection in this project.'); node.model ||= brain.model; }
    else if (!['claude', 'copilot'].includes(node.provider || 'claude')) throw new LibraryInputError('Managed deployments support Claude and Copilot.');
    try { return { definition: { ...doc, ...validateArchitecture(definition) }, capabilities }; } catch (e) { throw new LibraryInputError(`Cannot deploy: ${(e as Error).message}`); }
  }
  private tavilyConfig(project: string, spec: Extract<CapabilitySpec, { kind: 'tavily' }>): ToolConfig {
    const c = this.connection(project, spec.connectionId);
    return { type: 'tool', implementation: 'http', functionName: spec.functionName, method: 'POST', url: c.endpoint!, credentialId: c.id, timeoutMs: 15000,
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['query'], additionalProperties: false },
      defaults: { max_results: spec.maxResults, search_depth: spec.searchDepth, include_domains: spec.includeDomains, exclude_domains: spec.excludeDomains, include_answer: false, include_raw_content: false } };
  }
  private checkEnvironment(definition: ArchitectureDocument, nodeId: string, env: AgentEnvironment): void {
    const node = definition.nodes.find(n => n.id === nodeId)!; const allow = env.network === 'restricted' ? env.allowedHosts : undefined;
    if (node.runtime?.kind === 'managed' && env.network === 'restricted') throw new LibraryInputError('Exact-host network restrictions are enforced for API agents. Choose an API harness or a configured-endpoint environment for a coding runtime.');
    if (node.runtime?.kind === 'managed' && env.sandbox) throw new LibraryInputError('The managed coding harness runs on the host with tool approvals. Select an API harness to enforce the configured sandbox.');
    if (node.runtime?.kind === 'api') { const brain = this.brains.list(definition.project).find(c => c.id === node.runtime!.connectionId); if (!brain) throw new LibraryInputError('LLM connection is unavailable.'); checkNetwork(new URL(brain.baseUrl).hostname, allow); }
    const connected = [...this.resources.connected(definition, nodeId, 'tool'), ...this.resources.connected(definition, nodeId, 'memory')];
    for (const n of connected) { if (!n.config) throw new LibraryInputError(`Configure ${n.name} before deploying.`); const c = n.config; if (c.type === 'tool' && c.implementation === 'http') checkNetwork(new URL(c.url!).hostname, allow); if (c.type === 'memory' && c.backend === 'postgres') checkNetwork(c.host!, allow); this.resources.credentialStatus(definition.project, n); }
  }
  preview(architectureId: string, nodeId: string, environmentId: unknown) {
    const doc = this.architectures.get(architectureId).document; const env = environmentId ? this.environment(doc.project, environmentId) : this.defaultEnvironment(doc.project);
    const expanded = this.expand(doc, nodeId); this.checkEnvironment(expanded.definition, nodeId, env);
    return { ...expanded, environment: env, harness: expanded.definition.nodes.find(n => n.id === nodeId)!.runtime! };
  }
  deploy(architectureId: string, nodeId: string, raw: Record<string, unknown>): AgentDeployment {
    const doc = this.architectures.get(architectureId).document; if (raw.expectedRevision !== doc.revision) throw new LibraryInputError('The draft changed. Review it before deploying.');
    const { definition, capabilities, environment } = this.preview(architectureId, nodeId, raw.environmentId); const node = definition.nodes.find(n => n.id === nodeId)!;
    const previous = this.deployments().filter(d => d.architectureId === architectureId && d.nodeId === nodeId);
    const d: AgentDeployment = { id: randomUUID(), architectureId, architectureTitle: doc.title, nodeId, name: node.name, project: doc.project, version: Math.max(0, ...previous.map(p => p.version)) + 1, revision: doc.revision, environmentId: environment.id, environmentName: environment.name, status: 'active', createdAt: Date.now(), harness: node.runtime!.kind, provider: node.runtime!.kind === 'api' ? this.brains.list(doc.project).find(c => c.id === node.runtime!.connectionId)!.provider : node.provider || 'claude', model: node.model || 'Provider default', capabilities, definition, environment: structuredClone(environment) };
    this.deps.store.saveRecord('agent_deployments', d); this.deps.audit('agent_deploy', d.id, { version: d.version, revision: d.revision }); return d;
  }
  deployments(): AgentDeployment[] { return this.deps.store.loadRecords<AgentDeployment>('agent_deployments').sort((a, b) => b.createdAt - a.createdAt); }
  deployment(id: string): AgentDeployment { const d = this.deps.store.loadRecord<AgentDeployment>('agent_deployments', id); if (!d) throw new LibraryInputError('Deployment not found.'); return d; }
  private summary(d: AgentDeployment): DeploymentSummary { const { definition: _, environment: __, ...summary } = d; return summary; }
  setStatus(id: string, status: unknown): AgentDeployment { if (status !== 'active' && status !== 'paused') throw new LibraryInputError('Choose active or paused.'); const d = this.deployment(id); d.status = status; this.deps.store.saveRecord('agent_deployments', d); return d; }
  detail(id: string): DeploymentDetail { const deployment = this.deployment(id); return { deployment, conversations: this.deps.store.loadRecords<AgentConversationRecord>('agent_conversations').filter(c => c.deploymentId === id).map(c => this.conversation(c.id)), runs: this.runs.list().filter(r => r.deploymentId === id), triggers: this.deps.store.loadRecords<AgentTrigger>('agent_triggers').filter(t => t.deploymentId === id) }; }
  createConversation(deploymentId: string, raw: Record<string, unknown>): AgentConversationRecord {
    const d = this.deployment(deploymentId); if (d.status !== 'active') throw new LibraryInputError('Resume this deployment before starting a conversation.');
    const c: AgentConversationRecord = { id: randomUUID(), deploymentId, project: d.project, title: typeof raw.title === 'string' && raw.title.trim() ? text(raw.title, 'Conversation title') : 'New conversation', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    this.deps.store.saveRecord('agent_conversations', c); return c;
  }
  conversation(id: string): AgentConversationRecord {
    const c = this.deps.store.loadRecord<AgentConversationRecord>('agent_conversations', id); if (!c) throw new LibraryInputError('Conversation not found.');
    let changed = false;
    for (const message of [...c.messages].filter(m => m.role === 'user')) {
      if (c.messages.some(m => m.role === 'assistant' && (m.replyToRunId ?? m.runId) === message.runId)) continue;
      let run = this.runs.get(message.runId); const attempts = this.deps.store.loadRecords<import('../../shared/agentRuns.ts').AgentRun>('agent_runs').filter(r => r.conversationId === c.id);
      const seen = new Set([run.id]); for (;;) { const retry = attempts.filter(r => r.retryOf === run.id && !seen.has(r.id)).sort((a, b) => b.createdAt - a.createdAt)[0]; if (!retry) break; seen.add(retry.id); run = retry; }
      if (run.status === 'succeeded' && run.output) { c.messages.push({ id: randomUUID(), role: 'assistant', text: run.output, ts: run.finishedAt!, runId: run.id, replyToRunId: message.runId }); c.updatedAt = Date.now(); changed = true; }
    }
    if (changed) { c.messages.sort((a, b) => a.ts - b.ts); this.deps.store.saveRecord('agent_conversations', c); } return c;
  }
  message(id: string, raw: Record<string, unknown>) {
    const c = this.conversation(id); const d = this.deployment(c.deploymentId);
    if (c.messages.filter(m => m.role === 'user').length >= 100) throw new LibraryInputError('This conversation reached 100 turns. Start a new conversation.');
    if (this.runs.list().some(r => r.conversationId === id && ACTIVE_AGENT_RUNS.includes(r.status))) throw new LibraryInputError('Wait for the current response or cancel it before sending another message.');
    const successful = new Set(c.messages.filter(m => m.role === 'assistant').map(m => m.replyToRunId ?? m.runId));
    const history: { role: 'user' | 'assistant'; content: string }[] = []; let size = 0;
    const pairs = c.messages.filter(m => m.role === 'user' && successful.has(m.runId)).slice(-10);
    for (const user of pairs.reverse()) { const assistant = c.messages.find(m => m.role === 'assistant' && (m.replyToRunId ?? m.runId) === user.runId)!; const pair = [{ role: 'user' as const, content: user.text }, { role: 'assistant' as const, content: assistant.text.slice(0, 20000) }]; const length = pair.reduce((sum, m) => sum + m.content.length, 0); if (size + length > 40000) break; history.unshift(...pair); size += length; }
    const run = this.run(d.id, raw.text, 'chat', id, history);
    c.messages.push({ id: randomUUID(), role: 'user', text: run.input, runId: run.id, ts: run.createdAt }); if (c.messages.length === 1) c.title = run.input.slice(0, 80); c.updatedAt = Date.now(); this.deps.store.saveRecord('agent_conversations', c); return { conversation: c, run };
  }
  run(id: string, input: unknown, source: 'chat' | 'api' | 'interval' | 'webhook' = 'api', conversationId?: string, history: { role: 'user' | 'assistant'; content: string }[] = []) {
    const d = this.deployment(id); if (d.status !== 'active') throw new LibraryInputError('This deployment is paused. Resume it before starting new work.');
    return this.runs.enqueue(d.definition, d.nodeId, input, { environment: d.environment, deploymentId: d.id, deploymentVersion: d.version, source, conversationId, history });
  }
  async testCapability(project: string, id: string, input: unknown, version?: unknown, initialize = false) {
    const c = this.capability(project, id, version); if (c.spec.kind === 'skill') return { instructions: c.spec.instructions, requires: c.spec.requires, message: 'Instructions only. Required tools are checked at deployment.' };
    const config = c.spec.kind === 'tavily' ? this.tavilyConfig(project, c.spec) : c.spec.config;
    const doc: ArchitectureDocument = { id: `capability_${id}`, title: c.name, description: '', project, revision: c.version, updatedAt: c.createdAt, changedBy: 'operator', nodes: [], edges: [] };
    return this.resources.test({ document: doc, agentNodeId: 'probe', runId: randomUUID() }, { id, kind: config.type, name: c.name, description: c.description, x: 0, y: 0, config }, input, initialize);
  }
  saveTrigger(deploymentId: string, raw: Record<string, unknown>, id?: string): AgentTrigger {
    this.deployment(deploymentId); const previous = id ? this.deps.store.loadRecord<AgentTrigger>('agent_triggers', id) : undefined;
    if (id && (!previous || previous.deploymentId !== deploymentId)) throw new LibraryInputError('Trigger not found.');
    if (previous) { if (typeof raw.enabled !== 'boolean') throw new LibraryInputError('Set trigger enabled or disabled.'); const next = { ...previous, enabled: raw.enabled, ...(previous.kind === 'interval' ? { nextAt: Date.now() + previous.intervalMinutes! * 60000 } : {}) }; this.deps.store.saveRecord('agent_triggers', next); return next; }
    if (raw.kind !== 'interval' && raw.kind !== 'webhook') throw new LibraryInputError('Choose an interval or webhook trigger.');
    const minutes = raw.kind === 'interval' ? integer(raw.intervalMinutes, 1, 10080, 'Interval in minutes') : undefined;
    const trigger: AgentTrigger = { id: randomUUID(), deploymentId, name: text(raw.name, 'Trigger name'), kind: raw.kind, text: text(raw.text, 'Trigger task', 12000), enabled: false, ...(minutes ? { intervalMinutes: minutes, nextAt: Date.now() + minutes * 60000 } : {}), createdAt: Date.now() };
    this.deps.store.saveRecord('agent_triggers', trigger); return trigger;
  }
  fireTrigger(id: string) {
    const trigger = this.deps.store.loadRecord<AgentTrigger>('agent_triggers', id); if (!trigger?.enabled) throw new LibraryInputError('Enable this trigger before invoking it.');
    if (trigger.lastRunId && ACTIVE_AGENT_RUNS.includes(this.runs.get(trigger.lastRunId).status)) throw new LibraryInputError('This trigger already has queued or active work.');
    const run = this.run(trigger.deploymentId, trigger.text, trigger.kind); trigger.lastRunId = run.id; trigger.lastError = undefined; this.deps.store.saveRecord('agent_triggers', trigger); return run;
  }
  webhookKey(id: string): { token: string; path: string } {
    const t = this.deps.store.loadRecord<AgentTrigger>('agent_triggers', id); if (t?.kind !== 'webhook') throw new LibraryInputError('Webhook trigger not found.');
    const token = randomBytes(32).toString('hex'); this.deps.secrets.set(`agent-trigger:${id}:hash`, createHash('sha256').update(token).digest('hex')); t.hasToken = true; this.deps.store.saveRecord('agent_triggers', t);
    return { token, path: `/agent/agent-platform/${id}/invoke` };
  }
  invokeWebhook(id: string, token: string): { runId: string; status: string } {
    const stored = this.deps.secrets.get(`agent-trigger:${id}:hash`);
    if (!stored || !tokensMatch(createHash('sha256').update(token).digest('hex'), stored)) throw new TeamAuthError('Invalid webhook token.');
    const t = this.deps.store.loadRecord<AgentTrigger>('agent_triggers', id); if (t?.kind !== 'webhook') throw new TeamAuthError('Invalid webhook token.');
    const run = this.fireTrigger(id); return { runId: run.id, status: run.status };
  }
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return; this.ticking = true;
    try { for (const trigger of this.deps.store.loadRecords<AgentTrigger>('agent_triggers').filter(t => t.enabled && t.kind === 'interval' && t.nextAt! <= now)) {
      trigger.nextAt = now + trigger.intervalMinutes! * 60000; this.deps.store.saveRecord('agent_triggers', trigger);
      try { this.fireTrigger(trigger.id); } catch (e) { const latest = this.deps.store.loadRecord<AgentTrigger>('agent_triggers', trigger.id)!; latest.lastError = e instanceof LibraryInputError ? e.message : 'Trigger failed.'; this.deps.store.saveRecord('agent_triggers', latest); }
    } } finally { this.ticking = false; }
  }
}
