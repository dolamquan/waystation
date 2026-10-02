import { timings } from '../config.ts';
import type { Agent } from '../domain/types.ts';
import type { AgentRegistry } from '../domain/registry.ts';
import { classifyObserved, scanProcesses, type ProcInfo } from './processScanner.ts';

export const OBSERVED_SOURCE = 'observed-processes';

/** Polls the process table; feeds Codex liveness and surfaces other CLI agents as Tier C. */
export class ProcessCollector {
  private procs: readonly ProcInfo[] = [];
  private timer: NodeJS.Timeout | undefined;
  private firstSeen = new Map<number, number>();

  constructor(private readonly registry: AgentRegistry) {}

  latest(): readonly ProcInfo[] {
    return this.procs;
  }

  async start(): Promise<void> {
    await this.scan();
    this.timer = setInterval(() => void this.scan(), timings.processScanPollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async scan(): Promise<void> {
    try {
      this.procs = await scanProcesses();
    } catch (error) {
      console.error('[process-scan] failed:', (error as Error).message);
      return;
    }
    const now = Date.now();
    const observed = classifyObserved(this.procs);
    this.firstSeen = new Map(observed.map((o) => [o.pid, this.firstSeen.get(o.pid) ?? now] as const));
    const agents: Agent[] = observed.map((o) => ({
      id: `proc:${o.pid}`,
      vendor: o.vendor,
      tier: 'C',
      name: o.label,
      pid: o.pid,
      project: `pid ${o.pid}`,
      status: 'unknown',
      source: `${o.label} · process`,
      startedAt: this.firstSeen.get(o.pid),
      hooked: false,
      intercepting: false,
      canInstruct: false,
    }));
    this.registry.replaceSource(OBSERVED_SOURCE, agents);
  }
}
