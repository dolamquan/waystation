import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, timings } from '../config.ts';
import type { Agent } from '../domain/types.ts';
import type { AgentRegistry } from '../domain/registry.ts';
import { projectName } from '../domain/text.ts';
import { JsonlTailer } from './jsonlTail.ts';
import { normalizeCodexLine, parseCodexSessionMeta, type CodexSessionMeta } from './normalizers.ts';
import { hasCodexBackend, hasCodexExecProcess, type ProcInfo } from './processScanner.ts';
import { UsageMeter, codexRolloutModel, codexRolloutUsage } from '../usage/usageMeter.ts';

export const CODEX_SOURCE = 'codex-sessions';
const META_CHUNK_BYTES = 64 * 1024;
const META_MAX_BYTES = 2 * 1024 * 1024;
export const CODEX_STOP_BLOCKED =
  'Codex threads share one app-server process with your editor; stopping it would end every Codex thread there. Use Codex itself to stop this thread.';

interface RolloutState {
  readonly meta: CodexSessionMeta;
  readonly tailer: JsonlTailer;
  readonly meter: UsageMeter;
  activity?: string;
  lastEventAt?: number;
  turnOpen: boolean;
  mtimeMs: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Day folders to scan: today and yesterday in both local time and UTC. */
export function candidateDayDirs(root: string, now: Date): string[] {
  const days = [0, 1].flatMap((back) => {
    const d = new Date(now.getTime() - back * 86_400_000);
    return [
      [d.getFullYear(), d.getMonth() + 1, d.getDate()],
      [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()],
    ];
  });
  return [...new Set(days.map(([y, m, d]) => join(root, String(y), pad(m), pad(d))))];
}

type Rollout = { file: string; mtimeMs: number };

const LOCK_SUFFIX = '.lock';
const rolloutId = (file: string): string | undefined => /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(file)?.[1];

/**
 * Codex keeps `<threadId>.lock` in its thread-writer-locks folder while a thread is open and
 * deletes it on close. Returns the open thread ids, or undefined when this Codex has no such folder.
 */
async function openThreadIds(locksDir: string): Promise<Set<string> | undefined> {
  const names = await readdir(locksDir).catch(() => undefined);
  if (!names) return undefined;
  return new Set(names.filter((n) => n.endsWith(LOCK_SUFFIX) && !n.startsWith('.')).map((n) => n.slice(0, -LOCK_SUFFIX.length)));
}

/**
 * Fallback for Codex versions without thread-writer locks. Rollout files never record that a
 * session closed, so liveness is inferred:
 * - `codex exec` runs one turn and exits, so it is live only mid-turn with an exec process running.
 * - Editor and CLI threads stay listed while a turn is open, then for a short idle window
 *   counted from the last real activity: closing a thread appends housekeeping lines that
 *   bump the file's mtime without being activity.
 */
function isLive(state: RolloutState, now: number, execRunning: boolean): boolean {
  if (state.meta.originator === 'codex_exec') return state.turnOpen && execRunning;
  return state.turnOpen || now - (state.lastEventAt ?? state.mtimeMs) < timings.codexIdleWindowMs;
}

export class CodexSessionsCollector {
  private rollouts = new Map<string, RolloutState>();
  /** Rollout path per open thread found outside the recent day folders (a search walks the whole tree). */
  private olderRollouts = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly getProcs: () => readonly ProcInfo[],
    private readonly sessionsRoot = join(paths.codexHome, 'sessions'),
    private readonly locksDir = join(paths.codexHome, 'thread-writer-locks'),
  ) {}

  start(): void {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), timings.codexScanPollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async scan(now = Date.now()): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const procs = this.getProcs();
      if (!hasCodexBackend(procs)) {
        this.registry.replaceSource(CODEX_SOURCE, []);
        return;
      }
      const openIds = await openThreadIds(this.locksDir);
      const recent = await this.recentRollouts(now);
      const candidates = openIds ? [...recent, ...await this.olderOpenRollouts(openIds, recent)] : recent;
      for (const { file, mtimeMs } of candidates) await this.refresh(file, mtimeMs);
      const keep = new Set(candidates.map((r) => r.file));
      this.rollouts = new Map([...this.rollouts].filter(([file]) => keep.has(file)));
      const execRunning = hasCodexExecProcess(procs);
      const live = [...this.rollouts.values()].filter(state => !this.isManagedSession(state.meta.id) &&
        (openIds ? openIds.has(state.meta.id) : isLive(state, now, execRunning)));
      this.registry.replaceSource(CODEX_SOURCE, live.map((state) => this.toAgent(state, now)));
    } catch (error) {
      console.error('[codex-sessions] scan failed:', (error as Error).message);
    } finally {
      this.scanning = false;
    }
  }

  private async recentRollouts(now: number): Promise<Array<{ file: string; mtimeMs: number }>> {
    const dirs = candidateDayDirs(this.sessionsRoot, new Date(now));
    const found = await Promise.all(dirs.map(async (dir) => {
      const names = await readdir(dir).catch(() => [] as string[]);
      return Promise.all(names.filter((n) => n.endsWith('.jsonl')).map(async (name) => {
        const file = join(dir, name);
        const info = await stat(file).catch(() => undefined);
        return info ? { file, mtimeMs: info.mtimeMs } : undefined;
      }));
    }));
    return found.flat()
      .filter((r): r is { file: string; mtimeMs: number } => r !== undefined)
      .filter((r) => now - r.mtimeMs < timings.codexLiveWindowMs);
  }

  /** Open threads started before the recent day folders (e.g. an editor thread left open for days). */
  private async olderOpenRollouts(openIds: ReadonlySet<string>, recent: readonly Rollout[]): Promise<Rollout[]> {
    const recentIds = new Set(recent.map((r) => rolloutId(r.file)));
    const missing = [...openIds].filter((id) => !recentIds.has(id));
    this.olderRollouts = new Map([...this.olderRollouts].filter(([id]) => openIds.has(id)));
    if (missing.some((id) => !this.olderRollouts.has(id))) {
      const names = await readdir(this.sessionsRoot, { recursive: true }).catch(() => [] as string[]);
      for (const name of names) {
        const id = rolloutId(name);
        if (id && missing.includes(id)) this.olderRollouts.set(id, join(this.sessionsRoot, name));
      }
    }
    const found = await Promise.all(missing.map(async (id) => {
      const file = this.olderRollouts.get(id);
      const info = file ? await stat(file).catch(() => undefined) : undefined;
      return file && info ? { file, mtimeMs: info.mtimeMs } : undefined;
    }));
    return found.filter((r): r is Rollout => r !== undefined);
  }

  private async refresh(file: string, mtimeMs: number): Promise<void> {
    let state = this.rollouts.get(file);
    const meta = state?.meta ?? await readMeta(file);
    if (!meta) return;
    // Managed runners already stream this transcript under their stable, named agent id.
    // Reading it again would publish a duplicate agent, activity and usage.
    if (this.isManagedSession(meta.id)) {
      this.rollouts.delete(file);
      return;
    }
    if (!state) {
      state = { meta, tailer: new JsonlTailer(file), meter: new UsageMeter(), turnOpen: false, mtimeMs };
      this.rollouts.set(file, state);
    }
    state.mtimeMs = mtimeMs;
    const agentId = `codex:${state.meta.id}`;
    for (const line of await state.tailer.readNew()) {
      const model = codexRolloutModel(line);
      if (model) state.meter.setModel(model);
      const usage = codexRolloutUsage(line);
      if (usage) {
        state.meter.setTotals(usage.total);
        state.meter.setContext(usage.contextTokens, usage.contextWindow);
      }
      for (const event of normalizeCodexLine(agentId, line).events) {
        if (event.kind === 'status') state.turnOpen = event.summary === 'turn started';
        else state.activity = event.summary;
        state.lastEventAt = event.ts;
        this.registry.pushEvent(event);
      }
    }
  }

  private isManagedSession(sessionId: string): boolean {
    return this.registry.list().some(agent => agent.vendor === 'codex' && agent.tier === 'A' && agent.sessionId === sessionId);
  }

  private toAgent(state: RolloutState, now: number): Agent {
    const { meta } = state;
    const recentlyWritten = now - state.mtimeMs < timings.codexBusyWindowMs;
    const parent = meta.parentThreadId ? this.registry.list()
      .filter(agent => agent.vendor === 'codex' && agent.sessionId === meta.parentThreadId)
      .sort((a, b) => a.tier.localeCompare(b.tier))[0] : undefined;
    const parentMeta = meta.parentThreadId ? [...this.rollouts.values()].find(rollout => rollout.meta.id === meta.parentThreadId)?.meta : undefined;
    const parentName = parent?.name ?? (parentMeta ? parentMeta.agentNickname ?? `Codex · ${projectName(parentMeta.cwd)}` : undefined);
    return {
      id: `codex:${meta.id}`,
      vendor: 'codex',
      tier: 'C',
      name: meta.agentNickname ?? (meta.parentThreadId ? `${meta.agentRole ?? 'Subagent'} · ${projectName(meta.cwd)}` : `Codex · ${projectName(meta.cwd)}`),
      sessionId: meta.id,
      cwd: meta.cwd,
      project: projectName(meta.cwd),
      status: state.turnOpen || recentlyWritten ? 'busy' : 'idle',
      source: meta.parentThreadId ? 'Codex · subagent' : `Codex · ${meta.originator ?? 'unknown'} (likely live)`,
      parentId: meta.parentThreadId ? parent?.id ?? `codex:${meta.parentThreadId}` : undefined,
      subagent: meta.parentThreadId ? { type: meta.agentRole, parentName } : undefined,
      currentActivity: state.activity,
      startedAt: meta.startedAt,
      lastEventAt: state.lastEventAt ?? state.mtimeMs,
      hooked: false,
      intercepting: false,
      canInstruct: false,
      stopBlockedReason: CODEX_STOP_BLOCKED,
      model: state.meter.model,
      usage: state.meter.snapshot(),
    };
  }
}

async function readMeta(file: string): Promise<CodexSessionMeta | undefined> {
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    // session_meta embeds the full system instructions, so the first line can be very long.
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < META_MAX_BYTES) {
      const buffer = Buffer.alloc(META_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, META_CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      chunks.push(newline >= 0 ? chunk.subarray(0, newline) : chunk);
      if (newline >= 0) break;
      position += bytesRead;
    }
    return parseCodexSessionMeta(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}
