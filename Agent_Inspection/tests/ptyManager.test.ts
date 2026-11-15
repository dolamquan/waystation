import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_RUNNING_CONSOLES, PtyManager, SCROLLBACK_CHARS, commandLineFor, consoleEnv, validateCreate,
} from '../daemon/pty/ptyManager.ts';
import { parseClientMessage } from '../daemon/pty/ptySocket.ts';
import { ConsoleInputError, type ConsoleServerMessage, type PtyHandle, type PtySpawn } from '../daemon/pty/types.ts';

class FakePty implements PtyHandle {
  readonly pid = 4242;
  readonly written: string[] = [];
  size = { cols: 0, rows: 0 };
  killed = false;
  private data: (value: string) => void = () => undefined;
  private exit: (code: number) => void = () => undefined;
  onData(listener: (data: string) => void) { this.data = listener; }
  onExit(listener: (exitCode: number) => void) { this.exit = listener; }
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.size = { cols, rows }; }
  kill() { this.killed = true; this.exit(0); }
  print(text: string) { this.data(text); }
  end(code: number) { this.exit(code); }
}

let folder: string;
let spawned: FakePty[];
let spawnArgs: Array<{ file: string; args: readonly string[]; env: Readonly<Record<string, string>> }>;
const spawn: PtySpawn = async (file, args, options) => {
  const pty = new FakePty();
  spawned.push(pty);
  spawnArgs.push({ file, args, env: options.env });
  return pty;
};

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'waystation-pty-'));
  spawned = [];
  spawnArgs = [];
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

describe('validateCreate', () => {
  it('accepts a known kind in an existing absolute folder and clamps the size', () => {
    const request = validateCreate({ kind: 'claude', cwd: folder, cols: 9999, rows: 1, name: '  Review  ' });
    expect(request).toMatchObject({ kind: 'claude', cwd: folder, cols: 400, rows: 5, name: 'Review' });
  });

  it.each([
    [{ kind: 'shell', cwd: '\\\\fileserver\\share' }, /Network folders/],
    [{ kind: 'shell', cwd: '//fileserver/share' }, /Network folders/],
    [{ kind: 'bash', cwd: '' }, /kind must be/],
    [{ kind: 'shell', cwd: 'relative/path' }, /absolute/],
    [{ kind: 'shell', cwd: join(tmpdir(), 'waystation-does-not-exist-xyz') }, /Folder not found/],
    [undefined, /kind must be/],
  ])('refuses %j', (body, message) => {
    expect(() => validateCreate(body)).toThrow(ConsoleInputError);
    expect(() => validateCreate(body)).toThrow(message);
  });
});

describe('command lines', () => {
  it('launches only fixed commands, keeping the shell open after an agent CLI exits', () => {
    expect(commandLineFor('claude', 'win32')).toEqual({ file: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', 'claude'] });
    expect(commandLineFor('codex', 'win32').args.at(-1)).toBe('codex');
    expect(commandLineFor('shell', 'win32')).toEqual({ file: 'powershell.exe', args: ['-NoLogo'] });
    expect(commandLineFor('codex', 'linux', { SHELL: '/bin/zsh' })).toEqual({ file: '/bin/zsh', args: ['-c', 'codex; exec "/bin/zsh"'] });
  });

  it('keeps the daemon’s private variables out of a console', () => {
    const env = consoleEnv({ PATH: 'p', WAYSTATION_AGENT_ID: 'secret', AGENT_TOWER_TOKEN: 'secret', Waystation_Mixed: 'secret', agent_tower_lower: 'secret' });
    expect(env).toMatchObject({ PATH: 'p', TERM: 'xterm-256color' });
    expect(Object.keys(env).filter((key) => /WAYSTATION_|AGENT_TOWER_/i.test(key))).toEqual([]);
  });
});

describe('PtyManager', () => {
  it('lists a new console as running and names it by kind', async () => {
    const manager = new PtyManager(spawn, () => 1000);
    const info = await manager.create({ kind: 'codex', cwd: folder });
    expect(info).toMatchObject({ kind: 'codex', name: 'Codex 1', state: 'running', createdAt: 1000, lastOutputAt: 1000 });
    expect(manager.list()).toEqual([info]);
    expect(spawnArgs[0].env).not.toHaveProperty('WAYSTATION_AGENT_ID');
  });

  it('streams output to subscribers and replays it for a late one', async () => {
    let clock = 1000;
    const manager = new PtyManager(spawn, () => clock);
    const { id } = await manager.create({ kind: 'shell', cwd: folder });
    const seen: ConsoleServerMessage[] = [];
    spawned[0].print('hello ');
    clock = 2000;
    const subscription = manager.subscribe(id, (message) => seen.push(message))!;
    spawned[0].print('world');
    expect(subscription.replay).toBe('hello ');
    expect(seen).toEqual([{ type: 'output', data: 'world' }]);
    expect(manager.get(id)?.lastOutputAt).toBe(2000);
    subscription.unsubscribe();
    spawned[0].print('!');
    expect(seen).toHaveLength(1);
  });

  it('keeps only the most recent output', async () => {
    const manager = new PtyManager(spawn);
    const { id } = await manager.create({ kind: 'shell', cwd: folder });
    spawned[0].print('a'.repeat(SCROLLBACK_CHARS));
    spawned[0].print('tail');
    const { replay } = manager.subscribe(id, () => undefined)!;
    expect(replay).toHaveLength(SCROLLBACK_CHARS);
    expect(replay.endsWith('tail')).toBe(true);
  });

  it('passes input and resizes to a running console only', async () => {
    const manager = new PtyManager(spawn);
    const { id } = await manager.create({ kind: 'shell', cwd: folder });
    manager.write(id, 'ls\r');
    manager.resize(id, 120, 40);
    expect(spawned[0].written).toEqual(['ls\r']);
    expect(spawned[0].size).toEqual({ cols: 120, rows: 40 });
    spawned[0].end(3);
    manager.write(id, 'ignored');
    expect(spawned[0].written).toEqual(['ls\r']);
    expect(manager.get(id)).toMatchObject({ state: 'exited', exitCode: 3 });
  });

  it('tells subscribers when the process exits', async () => {
    const manager = new PtyManager(spawn);
    const { id } = await manager.create({ kind: 'claude', cwd: folder });
    const seen: ConsoleServerMessage[] = [];
    manager.subscribe(id, (message) => seen.push(message));
    spawned[0].end(7);
    expect(seen).toEqual([{ type: 'exit', code: 7 }]);
  });

  it('kills a console but keeps it listed until dismissed', async () => {
    const manager = new PtyManager(spawn);
    const { id } = await manager.create({ kind: 'shell', cwd: folder });
    expect(manager.kill(id)).toBe(true);
    expect(spawned[0].killed).toBe(true);
    expect(manager.get(id)?.state).toBe('exited');
    expect(manager.dismiss(id)).toBe(true);
    expect(manager.list()).toEqual([]);
    expect(manager.kill(id)).toBe(false);
  });

  it('stops launching at the running limit and frees a slot when one exits', async () => {
    const manager = new PtyManager(spawn);
    for (let index = 0; index < MAX_RUNNING_CONSOLES; index += 1) await manager.create({ kind: 'shell', cwd: folder });
    await expect(manager.create({ kind: 'shell', cwd: folder })).rejects.toThrow(/At most/);
    spawned[0].end(0);
    await expect(manager.create({ kind: 'shell', cwd: folder })).resolves.toMatchObject({ state: 'running' });
  });

  it('counts consoles that are still starting against the limit', async () => {
    const releases: Array<() => void> = [];
    const slowSpawn: PtySpawn = (file, args, options) => new Promise((resolve) => {
      releases.push(() => { void spawn(file, args, options).then(resolve); });
    });
    const manager = new PtyManager(slowSpawn);
    const attempts = Array.from({ length: MAX_RUNNING_CONSOLES + 3 }, () => manager.create({ kind: 'shell', cwd: folder }).then(() => 'ok', (error: Error) => error.message));
    await new Promise((resolve) => setTimeout(resolve, 10));
    releases.forEach((release) => release());
    const results = await Promise.all(attempts);
    expect(results.filter((result) => result === 'ok')).toHaveLength(MAX_RUNNING_CONSOLES);
    expect(results.filter((result) => /At most/.test(result))).toHaveLength(3);
  });

  it('refuses new consoles after shutdown and ends one that was still starting', async () => {
    let release: () => void = () => undefined;
    const slowSpawn: PtySpawn = (file, args, options) => new Promise((resolve) => {
      release = () => { void spawn(file, args, options).then(resolve); };
    });
    const manager = new PtyManager(slowSpawn);
    const pending = manager.create({ kind: 'shell', cwd: folder }).catch((error: Error) => error.message);
    manager.shutdown();
    release();
    expect(await pending).toMatch(/shutting down/);
    expect(spawned[0].killed).toBe(true);
    expect(manager.list()).toEqual([]);
    await expect(manager.create({ kind: 'shell', cwd: folder })).rejects.toThrow(/shutting down/);
  });

  it('tells open viewers when a console is dismissed or the daemon stops', async () => {
    const manager = new PtyManager(spawn);
    const first = await manager.create({ kind: 'shell', cwd: folder });
    const second = await manager.create({ kind: 'shell', cwd: folder });
    const seen: ConsoleServerMessage[] = [];
    manager.subscribe(first.id, (message) => seen.push(message));
    manager.subscribe(second.id, (message) => seen.push(message));
    // A running console is ended first, so a viewer sees the process exit and then the console go.
    manager.dismiss(first.id);
    expect(seen).toEqual([{ type: 'exit', code: 0 }, { type: 'closed' }]);
    manager.shutdown();
    expect(seen).toEqual([{ type: 'exit', code: 0 }, { type: 'closed' }, { type: 'exit', code: 0 }, { type: 'closed' }]);
  });

  it('ends every process on shutdown', async () => {
    const manager = new PtyManager(spawn);
    await manager.create({ kind: 'shell', cwd: folder });
    await manager.create({ kind: 'codex', cwd: folder });
    manager.shutdown();
    expect(spawned.every((pty) => pty.killed)).toBe(true);
    expect(manager.list()).toEqual([]);
  });
});

describe('parseClientMessage', () => {
  it('accepts input and resize and drops anything else', () => {
    expect(parseClientMessage('{"type":"input","data":"x"}')).toEqual({ type: 'input', data: 'x' });
    expect(parseClientMessage('{"type":"resize","cols":80,"rows":24}')).toEqual({ type: 'resize', cols: 80, rows: 24 });
    expect(parseClientMessage('{"type":"input","data":5}')).toBeUndefined();
    expect(parseClientMessage('{"type":"kill"}')).toBeUndefined();
    expect(parseClientMessage('not json')).toBeUndefined();
    expect(parseClientMessage('null')).toBeUndefined();
  });
});

describe('saved consoles', () => {
  const memoryStore = (initial: Array<{ id: string; name: string; kind: 'claude' | 'codex' | 'shell'; cwd: string; createdAt: number }> = []) => {
    const store = { data: initial, load: () => store.data, save: (specs: typeof initial) => { store.data = [...specs]; } };
    return store;
  };

  it('uses fixed resume command lines per kind', () => {
    expect(commandLineFor('claude', 'win32', {}, true).args.at(-1)).toBe('claude --continue');
    expect(commandLineFor('codex', 'win32', {}, true).args.at(-1)).toBe('codex resume --last');
    expect(commandLineFor('shell', 'win32', {}, true)).toEqual({ file: 'powershell.exe', args: ['-NoLogo'] });
    expect(commandLineFor('claude', 'linux', { SHELL: '/bin/zsh' }, true).args).toEqual(['-c', 'claude --continue; exec "/bin/zsh"']);
  });

  it('saves created consoles, keeps exited ones, and forgets dismissed ones', async () => {
    const store = memoryStore();
    const manager = new PtyManager(spawn, () => 5, store);
    const first = await manager.create({ kind: 'claude', cwd: folder });
    const second = await manager.create({ kind: 'shell', cwd: folder });
    expect(store.data.map((s) => s.id)).toEqual([first.id, second.id]);
    expect(store.data[0]).toEqual({ id: first.id, name: first.name, kind: 'claude', cwd: folder, createdAt: 5 });
    spawned[0].end(1);
    expect(store.data).toHaveLength(2);
    manager.dismiss(first.id);
    expect(store.data.map((s) => s.id)).toEqual([second.id]);
  });

  it('exposes saved specs without launching them, then restores with resume', async () => {
    const spec = { id: 'old-1', name: 'Review', kind: 'claude' as const, cwd: folder, createdAt: 7 };
    const store = memoryStore([spec]);
    const manager = new PtyManager(spawn, () => 9, store);
    expect(manager.savedSpecs()).toEqual([spec]);
    expect(manager.list()).toEqual([]);
    expect(spawned).toHaveLength(0);
    const info = await manager.restore('old-1');
    expect(info).toMatchObject({ id: 'old-1', name: 'Review', kind: 'claude', state: 'running', createdAt: 7 });
    expect(spawnArgs[0].args.at(-1)).toBe('claude --continue');
    expect(manager.savedSpecs()).toEqual([]);
    expect(store.data.map((s) => s.id)).toEqual(['old-1']);
    await expect(manager.restore('old-1')).rejects.toThrow(/no longer available/);
  });

  it('keeps a saved console when its folder is gone, and discards on request', async () => {
    const gone = join(folder, 'missing');
    const store = memoryStore([
      { id: 'a', name: 'A', kind: 'shell', cwd: gone, createdAt: 1 },
      { id: 'b', name: 'B', kind: 'codex', cwd: folder, createdAt: 2 },
    ]);
    const manager = new PtyManager(spawn, undefined, store);
    await expect(manager.restore('a')).rejects.toThrow(/Folder not found/);
    expect(manager.savedSpecs().map((s) => s.id)).toEqual(['a', 'b']);
    expect(manager.discard('b')).toBe(true);
    expect(manager.discard('b')).toBe(false);
    expect(store.data.map((s) => s.id)).toEqual(['a']);
  });

  it('keeps the saved list through a graceful shutdown', async () => {
    const store = memoryStore();
    const manager = new PtyManager(spawn, undefined, store);
    const { id } = await manager.create({ kind: 'shell', cwd: folder });
    manager.shutdown();
    expect(spawned[0].killed).toBe(true);
    expect(manager.list()).toEqual([]);
    expect(store.data.map((s) => s.id)).toEqual([id]);
  });
});

describe('createFromCommand and agent links', () => {
  const command = (extra: Record<string, unknown> = {}) =>
    ({ file: 'node', args: ['--import', 'tsx', 'launch.ts', 'a'.repeat(32), '--home', folder], cwd: folder, name: 'Claude Code · helper', kind: 'claude' as const, ...extra });

  it('runs the given command with a filtered environment and links the agent', async () => {
    process.env.WAYSTATION_TEST_SECRET = 'secret';
    process.env.AGENT_TOWER_TOKEN = 'token';
    try {
      const manager = new PtyManager(spawn);
      const info = await manager.createFromCommand(command({ agentId: 'managed:1' }));
      expect(info).toMatchObject({ kind: 'claude', state: 'running', agentId: 'managed:1', name: 'Claude Code · helper' });
      expect(spawnArgs[0].file).toBe('node');
      expect(spawnArgs[0].args).toEqual(['--import', 'tsx', 'launch.ts', 'a'.repeat(32), '--home', folder]);
      expect(Object.keys(spawnArgs[0].env).filter((key) => /^(WAYSTATION_|AGENT_TOWER_)/i.test(key))).toEqual([]);
      expect(spawnArgs[0].env.TERM).toBe('xterm-256color');
    } finally {
      delete process.env.WAYSTATION_TEST_SECRET;
      delete process.env.AGENT_TOWER_TOKEN;
    }
  });

  it('counts against the running cap, refuses a bad folder and a closed manager', async () => {
    const manager = new PtyManager(spawn);
    for (let index = 0; index < MAX_RUNNING_CONSOLES; index += 1) await manager.createFromCommand(command());
    await expect(manager.createFromCommand(command())).rejects.toThrow(/At most/);
    await expect(new PtyManager(spawn).createFromCommand(command({ cwd: join(folder, 'missing') }))).rejects.toThrow(ConsoleInputError);
    await expect(new PtyManager(spawn).createFromCommand(command({ cwd: '\\server\share' }))).rejects.toThrow(ConsoleInputError);
    manager.shutdown();
    await expect(manager.createFromCommand(command())).rejects.toThrow(/shutting down/);
  });

  it('keeps scrollback and subscribers, runs onExit once, and is never saved for restore', async () => {
    const saves: string[][] = [];
    const store = { load: () => [], save: (specs: readonly { id: string }[]) => { saves.push(specs.map((s) => s.id)); } };
    const manager = new PtyManager(spawn, undefined, store);
    let exits = 0;
    const info = await manager.createFromCommand(command({ onExit: () => { exits += 1; } }));
    const seen: ConsoleServerMessage[] = [];
    const sub = manager.subscribe(info.id, (message) => seen.push(message));
    spawned[0].print('hello');
    expect(manager.subscribe(info.id, () => undefined)?.replay).toBe('hello');
    expect(seen).toEqual([{ type: 'output', data: 'hello' }]);
    spawned[0].end(0);
    spawned[0].end(0);
    expect(exits).toBe(1);
    sub?.unsubscribe();
    const shell = await manager.create({ kind: 'shell', cwd: folder });
    expect(saves.at(-1)).toEqual([shell.id]);
  });

  it('setAgentId updates immutably and emits only on a real change', async () => {
    const manager = new PtyManager(spawn);
    const info = await manager.create({ kind: 'claude', cwd: folder });
    const changes: number[] = [];
    manager.on('changed', () => changes.push(1));
    manager.setAgentId(info.id, 'claude:x');
    manager.setAgentId(info.id, 'claude:x');
    expect(manager.get(info.id)?.agentId).toBe('claude:x');
    expect(info.agentId).toBeUndefined();
    manager.setAgentId(info.id, undefined);
    manager.setAgentId('missing', 'a');
    expect(manager.get(info.id)).not.toHaveProperty('agentId');
    expect(changes).toHaveLength(2);
  });
});

describe('PtyManager shutdown', () => {
  it('does not run exit handlers of the processes it kills while shutting down', async () => {
    const manager = new PtyManager(spawn);
    let exits = 0;
    await manager.createFromCommand({ file: 'x', args: [], cwd: folder, name: 'a', kind: 'claude', onExit: () => { exits += 1; } });
    manager.shutdown();
    expect(spawned[0]?.killed).toBe(true);
    expect(exits).toBe(0);
  });

  it('still runs the exit handler when a console ends on its own', async () => {
    const manager = new PtyManager(spawn);
    let exits = 0;
    await manager.createFromCommand({ file: 'x', args: [], cwd: folder, name: 'a', kind: 'claude', onExit: () => { exits += 1; } });
    spawned[0]?.end(0);
    expect(exits).toBe(1);
  });
});
