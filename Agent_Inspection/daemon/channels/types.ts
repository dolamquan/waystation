/**
 * Channels: operator-made groups of already-running agent sessions (any vendor) that may message each other.
 * Being a member is the permission: agents cannot join, invite or leave on their own.
 */

/** Sender name for messages the operator posts from the UI. */
export const CHANNEL_OPERATOR = 'operator';
/** Recipient name for a message to every other member. */
export const CHANNEL_EVERYONE = 'all';

export interface ChannelMember {
  /** Unique, lowercase handle members use to address each other. */
  readonly name: string;
  readonly agentId: string;
  readonly vendor: string;
  readonly joinedAt: number;
}

export interface ChannelMessage {
  /** Increases by one per message in its channel; read positions are kept as sequence numbers. */
  readonly seq: number;
  readonly id: string;
  readonly ts: number;
  /** A member name, or CHANNEL_OPERATOR. */
  readonly from: string;
  /** A member name, or CHANNEL_EVERYONE. */
  readonly to: string;
  readonly text: string;
  readonly replyTo?: string;
}

export interface ChannelState {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly createdAt: number;
  readonly members: readonly ChannelMember[];
  /** The most recent messages (older ones are dropped). */
  readonly messages: readonly ChannelMessage[];
  readonly nextSeq: number;
  /** Per member name: the last sequence number delivered to it. */
  readonly readUpTo: Readonly<Record<string, number>>;
  /** Times of recent automatic wake-ups, for the loop guard. */
  readonly recentWakes: readonly number[];
}

/** How a message reached one recipient. */
export type DeliveryKind = 'waiting' | 'woken' | 'inbox';

export interface Delivery {
  readonly to: string;
  readonly via: DeliveryKind;
  readonly note?: string;
}
