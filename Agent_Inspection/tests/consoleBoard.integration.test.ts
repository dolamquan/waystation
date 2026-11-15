import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { Agent } from '../daemon/domain/types.ts';
import type { ProcInfo } from '../daemon/collectors/processScanner.ts';
import { tempDir } from './helpers.ts';
import { buildBoardItems } from '../web/src/components/consoles/boardItems.ts';

// Exercise real HTTP snapshots and linking without starting a paid agent or a visible terminal.
vi.mock('../daemon/pty/nodePtySpawn.ts', () => ({
  spawnNodePty: async () => ({ pid: 100, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }),
}));
vi.mock('../daemon/collectors/processScanner.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../daemon/collectors/processScanner.ts')>(),
  scanProcesses: vi.fn(),
}));

process.env.AGENT_TOWER_HOME = join(tempDir('board-home-'), 'tower');
process.env.CLAUDE_HOME = tempDir('board-claude-');
const token = 'board-test-token';
const project = tempDir('board-project-');
let tower: import('../daemon/tower.ts').Tower;
let server: Server;
let base: string;

const list = async () => {
  const response = await fetch(`${base}/api/consoles`, { headers: { 'x-tower-token': token } });
  expect(response.status).toBe(200);
  return await response.json() as Awaited<ReturnType<typeof tower.consoleBoardSnapshot>>;
};

beforeAll(async () => {
  const { Tower } = await import('../daemon/tower.ts');
  const { startServer } = await import('../daemon/api/server.ts');
  tower = new Tower(':memory:');
  server = await startServer({ tower, port: 47_451, host: '127.0.0.1', token });
  base = 'http://127.0.0.1:47451';
});

afterAll(async () => { server?.close(); await tower?.shutdown(); });

describe('matched console board snapshots', () => {
  it('never publishes the observed duplicate while ownership detection is still running', async () => {
    const { scanProcesses } = await import('../daemon/collectors/processScanner.ts');
    let release!: (rows: ProcInfo[]) => void;
    vi.mocked(scanProcesses).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const console = await tower.consoles.create({ kind: 'claude', cwd: project });
    const inside = {
      id: 'claude:inside', vendor: 'claude', tier: 'B', name: 'Inside', pid: 102,
      cwd: project, project: 'test', status: 'idle', source: 'test', startedAt: Date.now(),
      hooked: false, intercepting: false, canInstruct: false,
    } satisfies Agent;
    tower.registry.upsert('fixture', inside);
    let published = false;
    const pending = list().then(snapshot => { published = true; return snapshot; });
    await vi.waitFor(() => expect(scanProcesses).toHaveBeenCalled());
    expect(published).toBe(false);
    release([
      { pid: 102, ppid: 101, name: 'claude.exe', commandLine: '', created: '' },
      { pid: 101, ppid: 100, name: 'powershell.exe', commandLine: '', created: '' },
    ]);
    const snapshot = await pending;
    expect(snapshot.agents.map(agent => agent.id)).toContain(inside.id);
    expect(snapshot.consoles[0]?.agentId).toBe(inside.id);
    expect(buildBoardItems(snapshot.consoles, snapshot.agents).map(item => item.key)).toEqual([`console:${console.id}`]);
  });

  it('still displays a real external session, including one in the same project', async () => {
    const { scanProcesses } = await import('../daemon/collectors/processScanner.ts');
    vi.mocked(scanProcesses).mockResolvedValue([
      { pid: 102, ppid: 100, name: 'claude.exe', commandLine: '', created: '' },
      { pid: 999, ppid: 998, name: 'claude.exe', commandLine: '', created: '' },
    ]);
    const inside = tower.registry.get('claude:inside')!;
    tower.registry.upsert('fixture', { ...inside, id: 'claude:outside', pid: 999, name: 'Outside' });
    const snapshot = await list();
    expect(buildBoardItems(snapshot.consoles, snapshot.agents).map(item => item.key)).toEqual([
      `console:${snapshot.consoles[0]!.id}`, 'agent:claude:outside',
    ]);
  });
});
