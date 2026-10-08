import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { claudePaths } from '../config.ts';
import type { Agent, AgentStatus } from '../domain/types.ts';
import type { AgentRegistry } from '../domain/registry.ts';
import { JsonlTailer } from './jsonlTail.ts';
import { normalizeClaudeLine } from './normalizers.ts';
import { activityFromEvent } from '../../shared/plainActivity.ts';
import { UsageMeter, claudeUsageSample, scanJsonl } from '../usage/usageMeter.ts';

export const SUBAGENT_SOURCE = 'claude-subagents';
export const SUBAGENT_STOP_BLOCKED = 'Subagents are controlled by their parent session.';
export const MAX_SUBAGENTS_PER_SESSION = 30;
/** No writes for this long while waiting on the model (not a tool) after a plain-text reply: it has answered. */
export const SUBAGENT_ANSWER_QUIET_MS = 30_000;
/** No writes at all for this long: presumed finished (or abandoned). */
export const SUBAGENT_STALE_MS = 15 * 60_000;
/** Finished subagents stay listed this long, then leave. */
export const SUBAGENT_LINGER_MS = 10 * 60_000;
const DISCOVERY_WINDOW_MS = SUBAGENT_STALE_MS + SUBAGENT_LINGER_MS;
const HANDBACK_TOOL = 'SubagentHandback';
const FILE_PATTERN = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;
const FINISHED_RESULT_STATUSES = new Set(['completed', 'failed', 'error', 'killed', 'cancelled']);
const AGENT_MESSAGE_PATTERN = /<agent-message from="([A-Za-z0-9_-]+)">\s*\[Subagent hand-back\]/;

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** `agent-<id>.meta.json`, written by Claude Code when the Agent tool spawns a subagent. */
export interface SubagentMeta {
  readonly agentType?: string;
  readonly description?: string;
  readonly toolUseId?: string;
}

export function parseSubagentMeta(text: string): SubagentMeta | undefined {
  try {
    const raw = asRecord(JSON.parse(text));
    if (!raw) return undefined;
    return { agentType: str(raw.agentType), description: str(raw.description), toolUseId: str(raw.toolUseId) };
  } catch {
    return undefined;
  }
}

export function subagentName(meta: SubagentMeta | undefined, agentId: string): string {
  const parts = [meta?.agentType, meta?.description].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(' · ') : `Subagent ${agentId.slice(0, 8)}`;
}

export const subagentRegistryId = (sessionId: string, agentId: string): string => `claude-sub:${sessionId}:${agentId}`;

/**
 * What the latest transcript line says about the subagent's turn:
 * 'handback' = it handed its report back (done); 'tool' = a tool call is running;
 * 'answer' = a plain-text reply (done, unless more follows); 'working' = anything else.
 */
export type SubagentStep = 'handback' | 'tool' | 'answer' | 'working';

export function subagentStep(line: unknown): SubagentStep | undefined {
  const entry = asRecord(line);
  const content = asRecord(entry?.message)?.content;
  if (entry?.type === 'user') return 'working';
  if (entry?.type !== 'assistant' || !Array.isArray(content)) return undefined;
  const blocks = content.map(asRecord);
  const tools = blocks.filter((block) => block?.type === 'tool_use');
  if (tools.some((block) => block?.name === HANDBACK_TOOL)) return 'handback';
  if (tools.length > 0) return 'tool';
  return blocks.some((block) => block?.type === 'text') ? 'answer' : 'working';
}

/** A parent-transcript line that reports a subagent finished: returns that subagent's id. */
export function finishedSubagentFromParentLine(line: unknown): string | undefined {
  const entry = asRecord(line);
  if (!entry) return undefined;
  const result = asRecord(entry.toolUseResult);
  const status = str(result?.status);
  if (result && status && FINISHED_RESULT_STATUSES.has(status)) return str(result.agentId);
  const attachment = asRecord(entry.attachment);
  const prompt = attachment?.type === 'queued_command' ? str(attachment.prompt) : undefined;
  return prompt ? AGENT_MESSAGE_PATTERN.exec(prompt)?.[1] : undefined;
}

interface ParentAgent {
  readonly id: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly name: string;
  readonly project: string;
}

interface SubagentState {
  readonly agentId: string;
  readonly path: string;
  readonly tailer: JsonlTailer;
  readonly meter: UsageMeter;
  scanned: boolean;
  meta?: SubagentMeta;
  startedAt?: number;
  lastWriteMs: number;
  activity?: string;
  lastEventAt?: number;
  step?: SubagentStep;
  handedBack: boolean;
}

interface SessionSubagents {
  readonly dir: string;
  subagents: ReadonlyMap<string, SubagentState>;
  /** Subagent ids the parent transcript reported as finished. */
  readonly finished: Set<string>;
}

interface FileInfo {
  readonly agentId: string;
  readonly path: string;
  readonly mtimeMs: number;
  readonly birthtimeMs: number;
}

export interface SubagentCollectorDeps {
  readonly registry: AgentRegistry;
  readonly projectsDir?: string;
  readonly now?: () => number;
}

/**
 * Claude Code writes each subagent (Agent/Task tool) to
 * `<projects>/<slug>/<sessionId>/subagents/agent-<id>.jsonl` plus a `.meta.json`. This lists the
 * subagents of every live Claude agent in the registry as read-only agents of their own.
 */
export class SubagentCollector {
  private sessions = new Map<string, SessionSubagents>();

  constructor(private readonly deps: SubagentCollectorDeps) {}

  /** Lines from a parent session's transcript: picks up "subagent finished" reports. */
  noteParentLine(sessionId: string, line: unknown): void {
    const agentId = finishedSubagentFromParentLine(line);
    if (agentId) this.sessions.get(sessionId)?.finished.add(agentId);
  }

  async scan(): Promise<void> {
    const parents = this.parents();
    const present = new Set(parents.map((parent) => parent.sessionId));
    this.sessions = new Map([...this.sessions].filter(([sessionId]) => present.has(sessionId)));
    const agents = await Promise.all(parents.map((parent) => this.scanSession(parent)));
    this.deps.registry.replaceSource(SUBAGENT_SOURCE, agents.flat());
  }

  /** Live Claude agents that own a session transcript; one per session, highest control tier first. */
  private parents(): ParentAgent[] {
    const bySession = new Map<string, ParentAgent>();
    const candidates = this.deps.registry.list()
      .filter((agent) => agent.vendor === 'claude' && !agent.parentId && agent.sessionId && agent.cwd)
      .sort((a, b) => a.tier.localeCompare(b.tier));
    for (const agent of candidates) {
      if (bySession.has(agent.sessionId!)) continue;
      bySession.set(agent.sessionId!, { id: agent.id, sessionId: agent.sessionId!, cwd: agent.cwd!, name: agent.name, project: agent.project });
    }
    return [...bySession.values()];
  }

  private async scanSession(parent: ParentAgent): Promise<Agent[]> {
    const session = this.sessionFor(parent);
    const now = this.now();
    const files = (await listSubagentFiles(session.dir))
      .filter((file) => now - file.mtimeMs <= DISCOVERY_WINDOW_MS)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_SUBAGENTS_PER_SESSION);
    session.subagents = new Map(files.map((file) => [file.agentId, session.subagents.get(file.agentId) ?? this.track(file)] as const));
    await Promise.all(files.map((file) => this.refresh(parent, session.subagents.get(file.agentId)!, file)));
    return [...session.subagents.values()]
      .map((state) => this.toAgent(parent, session, state, now))
      .filter((agent): agent is Agent => agent !== undefined);
  }

  private sessionFor(parent: ParentAgent): SessionSubagents {
    const existing = this.sessions.get(parent.sessionId);
    if (existing) return existing;
    const projectsDir = this.deps.projectsDir ?? claudePaths.projects;
    const slug = parent.cwd.replace(/[^A-Za-z0-9]/g, '-');
    const created: SessionSubagents = { dir: join(projectsDir, slug, parent.sessionId, 'subagents'), subagents: new Map(), finished: new Set() };
    this.sessions.set(parent.sessionId, created);
    return created;
  }

  private track(file: FileInfo): SubagentState {
    const meter = new UsageMeter();
    const state: SubagentState = {
      agentId: file.agentId,
      path: file.path,
      tailer: new JsonlTailer(file.path),
      meter,
      scanned: false,
      startedAt: file.birthtimeMs || undefined,
      lastWriteMs: file.mtimeMs,
      handedBack: false,
    };
    // Same as sessions: count the whole history once, publish usage only after that pass.
    void scanJsonl(file.path, (line) => {
      const sample = claudeUsageSample(line);
      if (sample) meter.addClaude({ ...sample, isMain: true });
    }).catch(() => undefined).finally(() => { state.scanned = true; });
    return state;
  }

  private async refresh(parent: ParentAgent, state: SubagentState, file: FileInfo): Promise<void> {
    state.lastWriteMs = Math.max(state.lastWriteMs, file.mtimeMs);
    if (!state.meta) {
      const metaPath = file.path.replace(/\.jsonl$/, '.meta.json');
      state.meta = await readFile(metaPath, 'utf8').then(parseSubagentMeta, () => undefined);
    }
    const registryId = subagentRegistryId(parent.sessionId, state.agentId);
    for (const line of await state.tailer.readNew()) this.consume(registryId, state, line);
  }

  private consume(registryId: string, state: SubagentState, line: unknown): void {
    const sample = claudeUsageSample(line);
    // The subagent's own requests are its main context, even though they are marked as a sidechain.
    if (sample) state.meter.addClaude({ ...sample, isMain: true });
    const step = subagentStep(line);
    if (step) state.step = step;
    if (step === 'handback') state.handedBack = true;
    const entry = asRecord(line);
    if (!entry) return;
    if (state.startedAt === undefined && typeof entry.timestamp === 'string') state.startedAt = Date.parse(entry.timestamp) || undefined;
    const { events } = normalizeClaudeLine(registryId, { ...entry, isSidechain: false });
    for (const event of events) {
      state.activity = activityFromEvent(event);
      state.lastEventAt = event.ts;
      this.deps.registry.pushEvent(event);
    }
  }

  private toAgent(parent: ParentAgent, session: SessionSubagents, state: SubagentState, now: number): Agent | undefined {
    const finished = state.handedBack || session.finished.has(state.agentId);
    const status = subagentStatus({ finished, step: state.step, quietMs: now - state.lastWriteMs });
    const endedAt = finished || state.step === 'answer' ? state.lastWriteMs : state.lastWriteMs + SUBAGENT_STALE_MS;
    if (status === 'stopped' && now - endedAt > SUBAGENT_LINGER_MS) return undefined;
    return {
      id: subagentRegistryId(parent.sessionId, state.agentId),
      vendor: 'claude',
      tier: 'C',
      name: subagentName(state.meta, state.agentId),
      cwd: parent.cwd,
      project: parent.project,
      status,
      source: 'Claude Code · subagent',
      currentActivity: status === 'stopped' ? (finished ? 'Finished · reported back to its parent' : 'No recent activity') : state.activity,
      startedAt: state.startedAt,
      lastEventAt: Math.max(state.lastEventAt ?? 0, state.lastWriteMs) || undefined,
      hooked: false,
      intercepting: false,
      canInstruct: false,
      stopBlockedReason: SUBAGENT_STOP_BLOCKED,
      model: state.meter.model,
      usage: state.scanned ? state.meter.snapshot() : undefined,
      parentId: parent.id,
      subagent: { type: state.meta?.agentType, description: state.meta?.description, parentName: parent.name },
    };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

export interface StatusInput {
  readonly finished: boolean;
  readonly step?: SubagentStep;
  readonly quietMs: number;
}

/** Busy while producing; stopped once it reported back, gave its final answer, or went quiet for good. */
export function subagentStatus({ finished, step, quietMs }: StatusInput): AgentStatus {
  if (finished || step === 'handback') return 'stopped';
  if (quietMs > SUBAGENT_STALE_MS) return 'stopped';
  if (step === 'answer' && quietMs > SUBAGENT_ANSWER_QUIET_MS) return 'stopped';
  return 'busy';
}

async function listSubagentFiles(dir: string): Promise<FileInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = await Promise.all(names.map(async (name): Promise<FileInfo | undefined> => {
    const match = FILE_PATTERN.exec(name);
    if (!match) return undefined;
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    return info ? { agentId: match[1], path, mtimeMs: info.mtimeMs, birthtimeMs: info.birthtimeMs } : undefined;
  }));
  return files.filter((file): file is FileInfo => file !== undefined);
}
