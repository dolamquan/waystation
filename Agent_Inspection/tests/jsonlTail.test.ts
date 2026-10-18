import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlTailer } from '../daemon/collectors/jsonlTail.ts';
import { tempDir } from './helpers.ts';

describe('JsonlTailer', () => {
  it('holds back a partial trailing line until it is completed', () => {
    const tailer = new JsonlTailer('unused');
    expect(tailer.consume('{"a":1}\n{"b":')).toEqual([{ a: 1 }]);
    expect(tailer.consume('2}\n')).toEqual([{ b: 2 }]);
  });

  it('skips malformed lines instead of throwing', () => {
    const tailer = new JsonlTailer('unused');
    expect(tailer.consume('not json\n{"ok":true}\n')).toEqual([{ ok: true }]);
  });

  it('reads only appended data from a real file', async () => {
    const file = join(tempDir(), 'log.jsonl');
    writeFileSync(file, '{"n":1}\n');
    const tailer = new JsonlTailer(file);
    expect(await tailer.readNew()).toEqual([{ n: 1 }]);
    expect(await tailer.readNew()).toEqual([]);
    appendFileSync(file, '{"n":2}\n{"n":');
    expect(await tailer.readNew()).toEqual([{ n: 2 }]);
    appendFileSync(file, '3}\n');
    expect(await tailer.readNew()).toEqual([{ n: 3 }]);
  });

  it('backfills only the tail of large files and drops a cut first line', async () => {
    const file = join(tempDir(), 'big.jsonl');
    const pad = '{"pad":"xxxxxxxxxx"}\n'; // 21 bytes
    const last = '{"last":true}\n'; // 14 bytes
    writeFileSync(file, `${pad.repeat(50)}${last}`);
    // Window starts mid-line: the partial line is discarded.
    expect(await new JsonlTailer(file, 20).readNew()).toEqual([{ last: true }]);
    // Window starts exactly at a line start: that complete line is kept.
    expect(await new JsonlTailer(file, pad.length + last.length).readNew()).toEqual([{ pad: 'xxxxxxxxxx' }, { last: true }]);
  });

  it('starts over when the file shrinks (rewritten)', async () => {
    const file = join(tempDir(), 'rewrite.jsonl');
    writeFileSync(file, '{"n":1}\n{"n":2}\n');
    const tailer = new JsonlTailer(file);
    await tailer.readNew();
    writeFileSync(file, '{"n":9}\n');
    expect(await tailer.readNew()).toEqual([{ n: 9 }]);
  });

  it('returns nothing for a missing file', async () => {
    expect(await new JsonlTailer(join(tempDir(), 'missing.jsonl')).readNew()).toEqual([]);
  });
});
