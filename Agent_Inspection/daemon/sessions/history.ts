import type { Agent, AgentEvent } from '../domain/types.ts';
import { redact } from '../domain/text.ts';
import type { ManagedLaunch } from '../managed/types.ts';
import type { TowerStore } from '../store/db.ts';
import type { SessionRecord, SessionView } from './types.ts';

/** Durable metadata and events are separate from the live fleet. History never launches work on startup. */
export class SessionHistory {
  private records = new Map<string, SessionRecord>();
  constructor(private readonly store: TowerStore) {
    for (const record of store.loadRecords<SessionRecord>('session_history')) {
      const recovered: SessionRecord = record.state === 'active'
        ? { ...record, state: record.agent.tier === 'A' && ['busy', 'waiting'].includes(record.agent.status) ? 'interrupted' : 'finished' }
        : record;
      this.save(recovered);
    }
  }
  get(id: string): SessionRecord | undefined { return this.records.get(id); }
  remember(agent: Agent): void {
    if (!agent.sessionId && agent.tier !== 'A') return;
    const previous = this.get(agent.id);
    this.save({ ...previous, id: agent.id, agent: { ...agent, name: redact(agent.name), currentActivity: agent.currentActivity ? redact(agent.currentActivity) : undefined },
      updatedAt: agent.lastEventAt ?? agent.startedAt ?? Date.now(), state: agent.status === 'stopped' ? agent.lastError ? 'interrupted' : 'finished' : 'active' });
  }
  rememberLaunch(agentId: string, launch: ManagedLaunch, loadout?: unknown): void {
    const record = this.get(agentId);
    if (!record) return;
    const { vendor, cwd, name, model, appendSystemPrompt, writeRoot } = launch;
    this.save({ ...record, originalRequest: record.launch ? record.originalRequest ?? redact(launch.prompt) : redact(launch.prompt),
      launch: { vendor, cwd, name, model, appendSystemPrompt, writeRoot }, loadout });
  }
  event(event: AgentEvent): void {
    const record = this.get(event.agentId);
    if (!record) return;
    this.save({ ...record, updatedAt: Math.max(record.updatedAt, event.ts),
      originalRequest: record.originalRequest ?? (event.kind === 'prompt' ? redact(event.summary) : undefined),
      latestResult: event.kind === 'assistant' ? redact(event.summary) : record.latestResult });
  }
  sync(agents: readonly Agent[], teamOf: (id: string) => string | undefined): void {
    const live = new Set(agents.map(agent => agent.id));
    for (const agent of agents) {
      this.remember(agent);
      const record = this.get(agent.id);
      const teamId = teamOf(agent.id);
      if (record && teamId && teamId !== record.teamId) this.save({ ...record, teamId });
    }
    for (const record of this.records.values()) if (record.state === 'active' && !live.has(record.id)) {
      this.save({ ...record, state: record.agent.tier === 'A' && (record.agent.status === 'busy' || record.agent.status === 'waiting') ? 'interrupted' : 'finished' });
    }
  }
  shutdown(): void {
    for (const record of this.records.values()) if (record.state === 'active') {
      this.save({ ...record, state: record.agent.tier === 'A' && ['busy', 'waiting'].includes(record.agent.status) ? 'interrupted' : 'finished' });
    }
  }
  list(liveAgents: readonly Agent[], query = '', project = '', state = ''): SessionView[] {
    const live = new Map(liveAgents.map(agent => [agent.id, agent]));
    const needle = query.trim().toLowerCase();
    return [...this.records.values()].map(record => {
      const current = live.get(record.id);
      const active = current !== undefined && current.status !== 'stopped';
      const sameConversation = liveAgents.find(agent => agent.vendor === record.agent.vendor && agent.sessionId === record.agent.sessionId && agent.status !== 'stopped');
      const reason = record.teamId ? 'Resume this member from its team.'
        : active || sameConversation ? 'This conversation is already open. Select its live session.'
        : !record.agent.sessionId ? 'No conversation id was recorded before this session ended.'
        : !record.agent.cwd ? 'No project folder was recorded.'
        : record.agent.vendor === 'other' ? 'This provider does not support conversation recovery.' : undefined;
      return { ...record, state: active ? 'active' as const : record.state, live: active, canResume: !reason, resumeBlockedReason: reason };
    }).filter(record => (!project || record.agent.cwd === project)
      && (!state || record.state === state)
      && (!needle || `${record.agent.name} ${record.agent.project} ${record.agent.cwd ?? ''} ${record.originalRequest ?? ''} ${record.latestResult ?? ''}`.toLowerCase().includes(needle)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  archivedAgent(id: string): Agent | undefined {
    const record = this.get(id);
    return record ? { ...record.agent, status: 'stopped', pid: undefined, canInstruct: false, intercepting: false, inTerminal: false,
      source: 'Session history', stopBlockedReason: 'This session is in history. Resume it to continue.' } : undefined;
  }
  private save(record: SessionRecord): void { this.store.saveRecord('session_history', record); this.records.set(record.id, record); }
}
