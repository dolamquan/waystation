import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, timings } from '../config.ts';
import type { Agent } from '../domain/types.ts';
import type { AgentRegistry } from '../domain/registry.ts';
import { projectName } from '../domain/text.ts';
import { JsonlTailer } from './jsonlTail.ts';
import { normalizeCodexLine, parseCodexSessionMeta, type CodexSessionMeta } from './normalizers.ts';
import { hasCodexBackend, type ProcInfo } from './processScanner.ts';

export const CODEX_SOURCE = 'codex-sessions';
const META_CHUNK_BYTES = 64 * 1024;
const META_MAX_BYTES = 2 * 1024 * 1024;
export const CODEX_STOP_BLOCKED =
  'Codex threads share one app-server process with your editor; stopping it would end every Codex thread there. Use Codex itself to stop this thread.';

interface RolloutState {
  readonly meta: CodexSessionMeta;
  readonly tailer: JsonlTailer;
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

export class CodexSessionsCollector {
  private rollouts = new Map<string, RolloutState>();
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly getProcs: () => readonly ProcInfo[],
    private readonly sessionsRoot = join(paths.codexHome, 'sessions'),
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
      if (!hasCodexBackend(this.getProcs())) {
        this.registry.replaceSource(CODEX_SOURCE, []);
        return;
      }
      const recent = await this.recentRollouts(now);
      for (const { file, mtimeMs } of recent) await this.refresh(file, mtimeMs);
      const keep = new Set(recent.map((r) => r.file));
      this.rollouts = new Map([...this.rollouts].filter(([file]) => keep.has(file)));
      this.registry.replaceSource(CODEX_SOURCE, [...this.rollouts.values()].map((state) => this.toAgent(state, now)));
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

  private async refresh(file: string, mtimeMs: number): Promise<void> {
    let state = this.rollouts.get(file);
    if (!state) {
      const meta = await readMeta(file);
      if (!meta) return;
      state = { meta, tailer: new JsonlTailer(file), turnOpen: false, mtimeMs };
      this.rollouts.set(file, state);
    }
    state.mtimeMs = mtimeMs;
    const agentId = `codex:${state.meta.id}`;
    for (const line of await state.tailer.readNew()) {
      for (const event of normalizeCodexLine(agentId, line).events) {
        if (event.kind === 'status') state.turnOpen = event.summary === 'turn started';
        else state.activity = event.summary;
        state.lastEventAt = event.ts;
        this.registry.pushEvent(event);
      }
    }
  }

  private toAgent(state: RolloutState, now: number): Agent {
    const { meta } = state;
    const recentlyWritten = now - state.mtimeMs < timings.codexBusyWindowMs;
    return {
      id: `codex:${meta.id}`,
      vendor: 'codex',
      tier: 'C',
      name: `Codex · ${projectName(meta.cwd)}`,
      sessionId: meta.id,
      cwd: meta.cwd,
      project: projectName(meta.cwd),
      status: state.turnOpen || recentlyWritten ? 'busy' : 'idle',
      source: `Codex · ${meta.originator ?? 'unknown'} (likely live)`,
      currentActivity: state.activity,
      startedAt: meta.startedAt,
      lastEventAt: state.lastEventAt ?? state.mtimeMs,
      hooked: false,
      intercepting: false,
      canInstruct: false,
      stopBlockedReason: CODEX_STOP_BLOCKED,
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
