import { open, stat } from 'node:fs/promises';

const INITIAL_BACKFILL_BYTES = 64 * 1024;

/**
 * Incremental JSONL reader. Tracks a byte offset, holds back a trailing partial
 * line until it is completed, and resets if the file shrinks (rewritten).
 */
export class JsonlTailer {
  private offset: number | undefined;
  private carry = '';

  constructor(
    readonly filePath: string,
    private readonly backfillBytes = INITIAL_BACKFILL_BYTES,
  ) {}

  async readNew(): Promise<unknown[]> {
    let size: number;
    try {
      size = (await stat(this.filePath)).size;
    } catch {
      return [];
    }
    let skipFirstLine = false;
    if (this.offset === undefined) {
      // Start one byte early and discard up to the first newline: if the window began exactly
      // at a line start, the discarded "line" is just that preceding newline.
      const start = Math.max(0, size - this.backfillBytes);
      this.offset = start > 0 ? start - 1 : 0;
      skipFirstLine = start > 0;
    } else if (size < this.offset) {
      this.offset = 0;
      this.carry = '';
    }
    if (size === this.offset) return [];

    const handle = await open(this.filePath, 'r');
    try {
      const length = size - this.offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, this.offset);
      this.offset = size;
      return this.consume(buffer.toString('utf8'), skipFirstLine);
    } finally {
      await handle.close();
    }
  }

  /** Exposed for tests: feed raw text as if appended to the file. */
  consume(chunk: string, skipFirstLine = false): unknown[] {
    const text = this.carry + chunk;
    const lines = text.split('\n');
    this.carry = lines.pop() ?? '';
    const complete = skipFirstLine ? lines.slice(1) : lines;
    return complete.flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      try {
        return [JSON.parse(trimmed) as unknown];
      } catch {
        return [];
      }
    });
  }
}
