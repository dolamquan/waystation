import { timings } from '../config.ts';
import { createHash } from 'node:crypto';
import { BUILTIN_DISCOVERY, type DiscoveryRule } from '../../shared/agentProviders.ts';
import type { Agent } from '../domain/types.ts';
import type { AgentRegistry } from '../domain/registry.ts';
import { classifyObserved, scanProcesses, type ProcInfo } from './processScanner.ts';

export const OBSERVED_SOURCE = 'observed-processes';

/** Polls the process table; feeds Codex liveness and surfaces other CLI agents as Tier C. */
export class ProcessCollector {
  private procs: readonly ProcInfo[] = [];
  private timer: NodeJS.Timeout | undefined;
  private firstSeen = new Map<string, number>();
  private scanning: Promise<void> | undefined;

  constructor(private readonly registry: AgentRegistry, private readonly rules: () => readonly DiscoveryRule[] = () => BUILTIN_DISCOVERY) {}

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

  scan(): Promise<void> {
    // Slow WMI queries must not overlap and publish stale snapshots out of order.
    return this.scanning ??= this.scanOnce().finally(() => { this.scanning = undefined; });
  }

  private async scanOnce(): Promise<void> {
    try {
      this.procs = await scanProcesses();
    } catch (error) {
      console.error('[process-scan] failed:', (error as Error).message);
      return;
    }
    const now = Date.now();
    // Codex cards come from rollouts or managed runners. A bare process has no thread id
    // or working folder, so publishing it creates a second, unassigned Codex card.
    // Keep the full process snapshot above for Codex liveness and stop validation.
    const byPid = new Map(this.procs.map(proc => [proc.pid, proc]));
    const ownedByDaemon = (pid: number): boolean => {
      const seen = new Set<number>();
      while (pid && !seen.has(pid)) {
        if (pid === process.pid) return true;
        seen.add(pid); pid = byPid.get(pid)?.ppid ?? 0;
      }
      return false;
    };
    // SDK runtimes launched by this daemon already have managed session cards.
    const observed = classifyObserved(this.procs, this.rules()).filter(proc => proc.vendor !== 'codex' && !ownedByDaemon(proc.pid));
    const identity = (pid: number) => {
      const created = byPid.get(pid)?.created;
      return `proc:${pid}${created ? `:${createHash('sha256').update(created).digest('hex').slice(0, 16)}` : ''}`;
    };
    this.firstSeen = new Map(observed.map(o => [identity(o.pid), this.firstSeen.get(identity(o.pid)) ?? now]));
    const agents: Agent[] = observed.map((o) => ({
      id: identity(o.pid),
      vendor: o.vendor,
      providerId: o.providerId,
      providerLabel: o.label,
      observation: { processName: byPid.get(o.pid)!.name, created: byPid.get(o.pid)!.created, host: o.host ?? 'cli' },
      tier: 'C',
      name: o.label,
      pid: o.pid,
      project: `pid ${o.pid}`,
      status: 'unknown',
      source: `${o.label} · ${o.host === 'editor' ? 'editor runtime' : 'process'}`,
      currentActivity: 'Process detected. Conversation activity is unavailable.',
      startedAt: this.firstSeen.get(identity(o.pid)),
      stopBlockedReason: o.host === 'editor' ? 'This runtime may serve several editor sessions. Stop it in its original editor.' : !byPid.get(o.pid)?.created ? 'Process identity could not be verified. Stop it in its original terminal.' : undefined,
      hooked: false,
      intercepting: false,
      canInstruct: false,
    }));
    this.registry.replaceSource(OBSERVED_SOURCE, agents);
  }
}
