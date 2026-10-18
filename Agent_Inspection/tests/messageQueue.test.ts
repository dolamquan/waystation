import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TowerStore } from '../daemon/store/db.ts';
import { MessageQueue } from '../daemon/sessions/messageQueue.ts';
import { tempDir } from './helpers.ts';

describe('durable message queue', () => {
  it('preserves ordering, edits, cancellation, exact text and uncertain delivery across a database reopen', () => {
    const path = join(tempDir(), 'queue.db');
    let store = new TowerStore(path);
    let queue = new MessageQueue(store);
    const first = queue.enqueue('agent', 'first\nline two');
    const second = queue.enqueue('agent', 'second');
    const third = queue.enqueue('agent', 'third');
    queue.edit('agent', first.id, 'edited\nline two');
    queue.cancel('agent', third.id);
    queue.transition('agent', second.id, 'delivering');
    store.close();
    store = new TowerStore(path);
    queue = new MessageQueue(store);
    expect(queue.list('agent').map(message => [message.text, message.state])).toEqual([
      ['edited\nline two', 'review'], ['second', 'review'], ['third', 'cancelled'],
    ]);
    expect(queue.next('agent')).toBeUndefined();
    expect(queue.list('agent')[1].reason).toMatch(/Check the conversation/);
    expect(() => queue.release('agent', second.id, false)).toThrow(/Confirm/);
    queue.release('agent', second.id, true);
    expect(queue.next('agent')?.id).toBe(second.id);
    expect(() => queue.edit('other', first.id, 'wrong session')).toThrow(/not found/);
    store.close();
  });
  it('does not permit changing submitted messages and bounds pending messages', () => {
    const store = new TowerStore(':memory:');
    const queue = new MessageQueue(store);
    const first = queue.enqueue('agent', 'hello');
    queue.transition('agent', first.id, 'delivered');
    expect(() => queue.edit('agent', first.id, 'rewrite')).toThrow(/submitted/);
    expect(() => queue.cancel('agent', first.id)).toThrow(/submitted/);
    for (let index = 0; index < 20; index++) queue.enqueue('agent', `message ${index}`);
    expect(() => queue.enqueue('agent', 'overflow')).toThrow(/20 pending/);
    queue.hold('agent', 'Interrupted');
    expect(queue.next('agent')).toBeUndefined();
    expect(queue.list('agent')[0].state).toBe('delivered');
    store.close();
  });
});
