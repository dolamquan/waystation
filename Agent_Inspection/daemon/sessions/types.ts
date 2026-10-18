import type { Agent } from '../domain/types.ts';
import type { ManagedLaunch } from '../managed/types.ts';

export type MessageState = 'queued' | 'delivering' | 'delivered' | 'cancelled' | 'review';
export interface QueuedMessage {
  readonly id: string;
  readonly agentId: string;
  readonly text: string;
  readonly state: MessageState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly reason?: string;
  readonly hook?: { readonly sessionId: string; readonly file: string };
}
export interface SessionRecord {
  readonly id: string;
  readonly agent: Agent;
  readonly updatedAt: number;
  readonly state: 'active' | 'finished' | 'interrupted';
  readonly originalRequest?: string;
  readonly latestResult?: string;
  /** Credentials and generated bridge configuration never enter the history. */
  readonly launch?: Pick<ManagedLaunch, 'vendor' | 'cwd' | 'name' | 'model' | 'appendSystemPrompt' | 'writeRoot'>;
  readonly loadout?: unknown;
  readonly teamId?: string;
}
export interface SessionView extends SessionRecord {
  readonly live: boolean;
  readonly canResume: boolean;
  readonly resumeBlockedReason?: string;
}
