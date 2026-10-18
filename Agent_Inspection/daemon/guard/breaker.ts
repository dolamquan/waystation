import type { AgentEvent, BreakerInfo, BreakerLevel } from '../domain/types.ts';

export interface BreakerConfig {
  /** Identical tool calls in a row (nothing else in between) that count as a loop. */
  readonly repeatLimit: number;
  /** Errors within `errorWindowMs` that count as an error storm. */
  readonly errorLimit: number;
  readonly errorWindowMs: number;
  /** Per-agent spend ceiling (list-price estimate). Undefined: no ceiling. */
  readonly costLimitUsd?: number;
  /** Allow the last rung (stop the agent). Off by default: the ladder then stops at "constrained". */
  readonly hardStop: boolean;
  /** A warning clears after this long without another trip. */
  readonly calmMs: number;
}

export const DEFAULT_BREAKER: BreakerConfig = {
  repeatLimit: 6,
  errorLimit: 6,
  errorWindowMs: 3 * 60_000,
  hardStop: false,
  calmMs: 15 * 60_000,
};

/**
 * AGENT_TOWER_AGENT_BUDGET_USD sets a per-agent spend ceiling; AGENT_TOWER_BREAKER_HARD_STOP=1
 * lets the guard stop an agent on the last rung.
 */
export function breakerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BreakerConfig {
  const budget = Number(env.AGENT_TOWER_AGENT_BUDGET_USD);
  return {
    ...DEFAULT_BREAKER,
    ...(Number.isFinite(budget) && budget > 0 ? { costLimitUsd: budget } : {}),
    hardStop: env.AGENT_TOWER_BREAKER_HARD_STOP === '1',
  };
}

export interface Trip {
  readonly agentId: string;
  readonly level: Exclude<BreakerLevel, 'ok'>;
  readonly reason: string;
}

const LADDER: readonly BreakerLevel[] = ['ok', 'warned', 'constrained', 'stopped'];

interface Track {
  readonly lastCall?: string;
  readonly repeats: number;
  readonly errors: readonly number[];
  readonly costTripped: boolean;
  readonly info?: BreakerInfo;
  readonly lastTripAt: number;
}

const FRESH: Track = { repeats: 0, errors: [], costTripped: false, lastTripAt: 0 };

/**
 * Runaway guard policy, side-effect free: it reads agent events and spend and returns
 * escalation decisions. The tower carries them out (steer, constrain, stop).
 * One rung per trip, never straight to a stop, and each trip needs fresh evidence.
 */
export class Breaker {
  private tracks = new Map<string, Track>();

  constructor(private readonly config: BreakerConfig = DEFAULT_BREAKER) {}

  observe(event: AgentEvent): Trip | undefined {
    const track = this.tracks.get(event.agentId) ?? FRESH;
    if (event.kind === 'prompt') {
      // The operator (or a teammate) spoke: whatever came before is not a loop anymore.
      this.tracks.set(event.agentId, { ...track, lastCall: undefined, repeats: 0 });
      return undefined;
    }
    if (event.kind === 'tool_call') {
      const repeats = event.summary === track.lastCall ? track.repeats + 1 : 1;
      if (repeats < this.config.repeatLimit) {
        this.tracks.set(event.agentId, { ...track, lastCall: event.summary, repeats });
        return undefined;
      }
      this.tracks.set(event.agentId, { ...track, lastCall: undefined, repeats: 0 });
      return this.escalate(event.agentId, `Repeated the same tool call ${repeats} times in a row: ${event.summary}`, event.ts);
    }
    if (event.kind === 'error') {
      const errors = [...track.errors.filter((ts) => event.ts - ts < this.config.errorWindowMs), event.ts];
      if (errors.length < this.config.errorLimit) {
        this.tracks.set(event.agentId, { ...track, errors });
        return undefined;
      }
      this.tracks.set(event.agentId, { ...track, errors: [] });
      const minutes = Math.round(this.config.errorWindowMs / 60_000);
      return this.escalate(event.agentId, `${errors.length} errors within ${minutes} minutes`, event.ts);
    }
    return undefined;
  }

  observeCost(agentId: string, costUsd: number | undefined, now = Date.now()): Trip | undefined {
    const limit = this.config.costLimitUsd;
    const track = this.tracks.get(agentId) ?? FRESH;
    if (limit === undefined || costUsd === undefined || costUsd < limit || track.costTripped) return undefined;
    // Money already spent: skip the warning rung.
    const trip = this.escalate(agentId, `Spent about $${costUsd.toFixed(2)}, over the $${limit.toFixed(2)} per-agent limit`, now, 'constrained');
    // Marked only once it took effect: an agent already at the top rung keeps being checked (and its reason updated).
    if (trip) this.tracks.set(agentId, { ...(this.tracks.get(agentId) ?? FRESH), costTripped: true });
    return trip;
  }

  /** Clears warnings that have gone quiet. Returns the agents whose state changed. */
  tick(now = Date.now()): string[] {
    const calmed = [...this.tracks].filter(([, track]) =>
      track.info?.level === 'warned' && now - track.lastTripAt >= this.config.calmMs);
    for (const [agentId, track] of calmed) this.tracks.set(agentId, { ...track, info: undefined });
    return calmed.map(([agentId]) => agentId);
  }

  state(agentId: string): BreakerInfo | undefined {
    return this.tracks.get(agentId)?.info;
  }

  /**
   * The operator looked at it and wants the agent to carry on. Being over budget stays acknowledged,
   * so the guard does not step straight back in on the next spend check.
   */
  reset(agentId: string): void {
    const costTripped = this.tracks.get(agentId)?.costTripped ?? false;
    this.tracks.set(agentId, { ...FRESH, costTripped });
  }

  forget(agentId: string): void {
    this.tracks.delete(agentId);
  }

  private escalate(agentId: string, reason: string, now: number, atLeast: BreakerLevel = 'warned'): Trip | undefined {
    const track = this.tracks.get(agentId) ?? FRESH;
    const current = LADDER.indexOf(track.info?.level ?? 'ok');
    const cap = LADDER.indexOf(this.config.hardStop ? 'stopped' : 'constrained');
    const next = Math.min(Math.max(current + 1, LADDER.indexOf(atLeast)), cap);
    if (next <= current) {
      // Already at the top rung: record the newest reason, but don't repeat the action.
      this.tracks.set(agentId, { ...track, lastTripAt: now, info: track.info && { ...track.info, reason } });
      return undefined;
    }
    const level = LADDER[next] as Trip['level'];
    this.tracks.set(agentId, { ...track, lastTripAt: now, info: { level, reason, since: now } });
    return { agentId, level, reason };
  }
}
