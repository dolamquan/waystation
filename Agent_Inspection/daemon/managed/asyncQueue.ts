/** Minimal push-based async iterable used to stream user messages into a long-lived agent. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) throw new Error('queue is closed');
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items = [...this.items, item];
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) waiter({ value: undefined, done: true });
    this.waiters = [];
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          const [head, ...rest] = this.items;
          this.items = rest;
          return Promise.resolve({ value: head as T, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiters = [...this.waiters, resolve]; });
      },
    };
  }
}
