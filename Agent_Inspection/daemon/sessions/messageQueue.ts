import { randomUUID } from 'node:crypto';
import type { TowerStore } from '../store/db.ts';
import type { QueuedMessage } from './types.ts';

export class QueueError extends Error {}
const mutable = (message: QueuedMessage) => message.state === 'queued' || message.state === 'review';

/** Delivery is recorded before touching a runner. Uncertain submissions are never retried automatically. */
export class MessageQueue {
  private messages = new Map<string, QueuedMessage>();
  constructor(private readonly store: TowerStore, private readonly changed: (agentId: string) => void = () => {}) {
    for (const message of store.loadRecords<QueuedMessage>('message_queue')) {
      const recovered: QueuedMessage = message.state === 'queued' || message.state === 'delivering'
        ? { ...message, state: 'review', updatedAt: Date.now(), reason: message.state === 'delivering'
          ? 'Delivery was interrupted. Check the conversation before sending again.'
          : 'Waystation restarted. Review this message before sending it.' }
        : message;
      this.messages.set(recovered.id, recovered);
      if (recovered !== message) this.store.saveRecord('message_queue', recovered);
    }
  }
  list(agentId: string): QueuedMessage[] {
    return [...this.messages.values()].filter(message => message.agentId === agentId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  enqueue(agentId: string, text: string): QueuedMessage {
    if (this.list(agentId).filter(mutable).length >= 20) throw new QueueError('This session already has 20 pending messages. Cancel one or wait for delivery.');
    const createdAt = Math.max(Date.now(), ...this.list(agentId).map(message => message.createdAt + 1));
    return this.save({ id: randomUUID(), agentId, text: this.validText(text), state: 'queued', createdAt, updatedAt: Date.now() });
  }
  next(agentId: string): QueuedMessage | undefined { return this.list(agentId).find(message => message.state === 'queued'); }
  bindHook(agentId: string, id: string, sessionId: string, file: string): void {
    this.save({ ...this.get(agentId, id), hook: { sessionId, file }, updatedAt: Date.now() });
  }
  all(): QueuedMessage[] { return [...this.messages.values()]; }
  private get(agentId: string, id: string): QueuedMessage {
    const message = this.messages.get(id);
    if (!message || message.agentId !== agentId) throw new QueueError('Queued message not found for this session.');
    return message;
  }
  edit(agentId: string, id: string, text: string): QueuedMessage {
    const message = this.get(agentId, id);
    if (!mutable(message)) throw new QueueError('This message has already been submitted and cannot be edited.');
    return this.save({ ...message, text: this.validText(text), updatedAt: Date.now() });
  }
  cancel(agentId: string, id: string): QueuedMessage {
    const message = this.get(agentId, id);
    if (!mutable(message)) throw new QueueError('This message has already been submitted and cannot be cancelled.');
    return this.save({ ...message, state: 'cancelled', updatedAt: Date.now(), reason: 'Cancelled by you.' });
  }
  release(agentId: string, id: string, confirm: boolean): QueuedMessage {
    const message = this.get(agentId, id);
    if (message.state !== 'review') throw new QueueError('This message does not need delivery review.');
    if (!confirm) throw new QueueError('Confirm that you checked the conversation before resending this message.');
    return this.save({ ...message, state: 'queued', updatedAt: Date.now(), reason: undefined });
  }
  transition(agentId: string, id: string, state: 'delivering' | 'delivered' | 'review', reason?: string): QueuedMessage {
    return this.save({ ...this.get(agentId, id), state, reason, updatedAt: Date.now() });
  }
  hold(agentId: string, reason: string): void {
    for (const message of this.list(agentId)) if (message.state === 'queued' || message.state === 'delivering') {
      this.transition(agentId, message.id, 'review', reason);
    }
  }
  private validText(text: string): string {
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new QueueError('Messages must contain between 1 and 8,000 characters.');
    return text.trim();
  }
  private save(message: QueuedMessage): QueuedMessage {
    this.store.saveRecord('message_queue', message);
    this.messages.set(message.id, message);
    this.changed(message.agentId);
    return message;
  }
}
