import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConsoleStore } from '../daemon/pty/consoleStore.ts';
import { PtyManager } from '../daemon/pty/ptyManager.ts';
import { ConsoleInputError, type PtyHandle, type PtySpawn, type SavedConsoleSpec } from '../daemon/pty/types.ts';

class FakePty implements PtyHandle {
  readonly pid = 4242;
  onData() { /* no output */ }
  onExit() { /* never exits */ }
  write() { /* ignored */ }
  resize() { /* ignored */ }
  kill() { /* ignored */ }
}

let folder: string;
let saved: readonly SavedConsoleSpec[];
const spawn: PtySpawn = async () => new FakePty();
const store = { load: () => [], save: (specs: readonly SavedConsoleSpec[]) => { saved = specs; } } as unknown as ConsoleStore;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'waystation-rename-'));
  saved = [];
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

describe('renaming a console', () => {
  it('takes a name at creation and a new one later, keeps it for the next start, and tells listeners', async () => {
    const manager = new PtyManager(spawn, () => 1000, store);
    const created = await manager.create({ kind: 'claude', cwd: folder, name: '  Researcher  ' });
    expect(created.name).toBe('Researcher');
    const changes: string[] = [];
    manager.on('changed', (list: readonly { name: string }[]) => changes.push(list[0]!.name));
    expect(manager.rename(created.id, '  Lead reviewer ')).toBe(true);
    expect(manager.get(created.id)?.name).toBe('Lead reviewer');
    expect(saved.map((spec) => spec.name)).toEqual(['Lead reviewer']);
    expect(changes).toEqual(['Lead reviewer']);
    manager.shutdown();
  });
  it('caps a long name, refuses an empty one, and reports an unknown console', async () => {
    const manager = new PtyManager(spawn, () => 1000, store);
    const created = await manager.create({ kind: 'shell', cwd: folder });
    manager.rename(created.id, 'x'.repeat(200));
    expect(manager.get(created.id)?.name).toHaveLength(60);
    expect(() => manager.rename(created.id, '   ')).toThrow(ConsoleInputError);
    expect(() => manager.rename(created.id, 7)).toThrow(ConsoleInputError);
    expect(manager.rename('no-such-console', 'x')).toBe(false);
    manager.shutdown();
  });
});
