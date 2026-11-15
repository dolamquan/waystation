import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SAVED_CONSOLES, createConsoleStore } from '../daemon/pty/consoleStore.ts';
import type { SavedConsoleSpec } from '../daemon/pty/types.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'waystation-consoles-'));
  file = join(dir, 'consoles.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const spec = (n: number, over: Partial<SavedConsoleSpec> = {}): SavedConsoleSpec =>
  ({ id: `id-${n}`, name: `Console ${n}`, kind: 'shell', cwd: dir, createdAt: n, ...over });

describe('consoleStore', () => {
  it('loads nothing when the file does not exist', () => {
    expect(createConsoleStore(file).load()).toEqual([]);
  });

  it('round-trips specs and stores nothing else', () => {
    const store = createConsoleStore(file);
    const specs = [spec(1), spec(2, { kind: 'claude' })];
    store.save(specs);
    expect(store.load()).toEqual(specs);
    expect(JSON.parse(readFileSync(file, 'utf8')).consoles[0]).not.toHaveProperty('state');
  });

  it('drops malformed entries and survives a corrupt file', () => {
    writeFileSync(file, JSON.stringify({ consoles: [spec(1), { id: 5 }, null, spec(2, { kind: 'bash' as never }), spec(3, { cwd: '' }), spec(1)] }));
    expect(createConsoleStore(file).load().map((s) => s.id)).toEqual(['id-1']);
    writeFileSync(file, '{not json');
    expect(createConsoleStore(file).load()).toEqual([]);
    writeFileSync(file, '[1,2]');
    expect(createConsoleStore(file).load()).toEqual([]);
  });

  it('caps how many specs are kept', () => {
    const many = Array.from({ length: MAX_SAVED_CONSOLES + 10 }, (_, n) => spec(n));
    const store = createConsoleStore(file);
    store.save(many);
    expect(store.load()).toHaveLength(MAX_SAVED_CONSOLES);
  });

  it('writes atomically and leaves no temp file behind', () => {
    const store = createConsoleStore(file);
    store.save([spec(1)]);
    store.save([spec(2)]);
    expect(readdirSync(dir)).toEqual(['consoles.json']);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('never throws when the folder cannot be written', () => {
    writeFileSync(join(dir, 'blocker'), 'a file, not a folder');
    expect(() => createConsoleStore(join(dir, 'blocker', 'x.json')).save([spec(1)])).not.toThrow();
  });
});
