import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { InterceptionDecision, PendingInterception } from '../domain/types.ts';

interface PendingEntry {
  readonly item: PendingInterception;
  readonly resolve: (decision: InterceptionDecision) => void;
  readonly timer: NodeJS.Timeout;
}

interface InterceptionEvents {
  changed: [PendingInterception[]];
}

/** Holds tool calls waiting for a human decision (from hooks or managed agents). */
export class InterceptionManager extends EventEmitter<InterceptionEvents> {
  private pending = new Map<string, PendingEntry>();

  request(
    input: Omit<PendingInterception, 'id' | 'createdAt'>,
    timeoutMs: number,
    onTimeout: InterceptionDecision = { behavior: 'ask' },
  ): { id: string; decision: Promise<InterceptionDecision> } {
    const id = randomUUID();
    const item: PendingInterception = { ...input, id, createdAt: Date.now() };
    const decision = new Promise<InterceptionDecision>((resolve) => {
      const timer = setTimeout(() => this.settle(id, onTimeout), timeoutMs);
      this.pending.set(id, { item, resolve, timer });
    });
    this.emitChanged();
    return { id, decision };
  }

  decide(id: string, decision: InterceptionDecision): boolean {
    return this.settle(id, decision);
  }

  /** Requester went away (e.g. user pressed Esc in Claude Code). */
  cancel(id: string): void {
    this.settle(id, { behavior: 'ask' });
  }

  /** The agent stopped or exited: nothing it asked about can still be decided. */
  cancelForAgent(agentId: string): void {
    for (const item of this.forAgent(agentId)) this.settle(item.id, { behavior: 'ask' });
  }

  list(): PendingInterception[] {
    return [...this.pending.values()].map((entry) => entry.item).sort((a, b) => a.createdAt - b.createdAt);
  }

  forAgent(agentId: string): PendingInterception[] {
    return this.list().filter((item) => item.agentId === agentId);
  }

  private settle(id: string, decision: InterceptionDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending = new Map([...this.pending].filter(([key]) => key !== id));
    entry.resolve(decision);
    this.emitChanged();
    return true;
  }

  private emitChanged(): void {
    this.emit('changed', this.list());
  }
}
