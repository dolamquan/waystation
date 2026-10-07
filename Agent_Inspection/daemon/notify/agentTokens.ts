import { randomBytes } from 'node:crypto';
import { tokensMatch } from '../api/security.ts';

/** What one agent's notify token allows: posting to these channels. */
export interface AgentGrant {
  readonly agentId: string;
  readonly name?: string;
  readonly channelIds: readonly string[];
  readonly token: string;
}

const TOKEN_BYTES = 24;

/** One live token per agent; issuing again replaces the old one. */
export class AgentTokens {
  private grants: ReadonlyMap<string, AgentGrant> = new Map();

  issue(agentId: string, name: string | undefined, channelIds: readonly string[]): string {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    this.grants = new Map([...this.grants, [agentId, { agentId, name, channelIds: [...channelIds], token }]]);
    return token;
  }

  /** Constant-time comparison against every live token. */
  find(token: string | undefined): AgentGrant | undefined {
    if (!token) return undefined;
    return [...this.grants.values()].find((grant) => tokensMatch(token, grant.token));
  }

  revoke(agentId: string): void {
    if (!this.grants.has(agentId)) return;
    this.grants = new Map([...this.grants].filter(([id]) => id !== agentId));
  }
}

/** Sliding-window counter: at most `limit` events per `windowMs` for each key. */
export class RateLimiter {
  private hits: ReadonlyMap<string, readonly number[]> = new Map();

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number) {}

  /** Records an event and says whether it is within the limit. */
  take(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((ts) => now - ts < this.windowMs);
    const allowed = recent.length < this.limit;
    this.hits = new Map([...this.hits, [key, allowed ? [...recent, now] : recent]]);
    return allowed;
  }
}
