import { OPERATOR, type Actor, type TeamMessage } from './types.ts';

/**
 * A member's reply is the last assistant text of its turn, addressed to whoever woke it for that turn.
 * Intermediate text blocks are overwritten; nothing here is ever delivered as mail.
 */

/** OPERATOR when any delivered message came from the operator, else the first sender. */
export function wakerOf(delivered: readonly TeamMessage[]): Actor | undefined {
  if (delivered.some((message) => message.from === OPERATOR)) return OPERATOR;
  return delivered[0]?.from;
}

export interface TurnReply {
  readonly text: string;
  readonly to?: Actor;
}

export class ReplyTracker {
  /** Per agent id: the latest assistant text of the running turn. */
  private lastText = new Map<string, string>();
  /** Per `${teamId}/${memberId}`: who woke the member for its current turn. */
  private wakers = new Map<string, Actor>();

  wokeBy(teamId: string, memberId: string, waker: Actor | undefined): void {
    const key = `${teamId}/${memberId}`;
    this.wakers = waker
      ? new Map([...this.wakers, [key, waker]])
      : new Map([...this.wakers].filter(([k]) => k !== key));
  }

  onAssistant(agentId: string, text: string): void {
    if (!text.trim()) return;
    this.lastText = new Map([...this.lastText, [agentId, text]]);
  }

  /** The turn ended: hand back its reply once, then forget it. */
  endTurn(agentId: string, teamId: string, memberId: string): TurnReply | undefined {
    const text = this.lastText.get(agentId);
    if (text === undefined) return undefined;
    const key = `${teamId}/${memberId}`;
    const to = this.wakers.get(key);
    this.lastText = new Map([...this.lastText].filter(([id]) => id !== agentId));
    this.wakers = new Map([...this.wakers].filter(([k]) => k !== key));
    return { text, to };
  }

  forgetAgent(agentId: string): void {
    this.lastText = new Map([...this.lastText].filter(([id]) => id !== agentId));
  }
}
