import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRepo, tempDir } from './helpers.ts';

process.env.AGENT_TOWER_HOME = tempDir('worktree-api-home-');
process.env.CLAUDE_HOME = tempDir('worktree-api-claude-');
const TOKEN = 'worktree-operator-test-token';
const PORT = 47_348;
let tower: import('../daemon/tower.ts').Tower;
let server: Server;
let origin: string;
async function api(method: string, path: string, body?: unknown, token = TOKEN) {
  const response = await fetch(`${origin}${path}`, { method, headers: { 'x-tower-token': token, 'content-type': 'application/json', connection: 'close' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json() as Record<string, any> };
}

beforeAll(async () => {
  const { Tower } = await import('../daemon/tower.ts');
  const { startServer } = await import('../daemon/api/server.ts');
  tower = new Tower(':memory:');
  server = await startServer({ tower, host: '127.0.0.1', port: PORT, token: TOKEN });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 30_000);
afterAll(async () => { server?.close(); await tower?.shutdown(); });

describe('worktree API and canvas integration', () => {
  it('requires the operator token for both reads and creation and reports validation errors', async () => {
    expect((await api('GET', '/api/worktrees?root=x', undefined, 'wrong')).status).toBe(401);
    expect((await api('POST', '/api/worktrees', {}, 'wrong')).status).toBe(401);
    expect((await api('GET', '/api/worktrees?root=relative')).status).toBe(400);
    expect((await api('POST', '/api/worktrees', {})).status).toBe(400);
  });

  it('creates a worktree, persists its tile, and starts a real shell there without consuming the worktree tile', async () => {
    const root = makeRepo();
    const path = join(tempDir('api-worktree-'), 'workspace');
    const created = await api('POST', '/api/worktrees', { root, path, branch: 'feature/api-worktree', mode: 'new' });
    expect(created.status).toBe(200);
    const listing = await api('GET', `/api/worktrees?root=${encodeURIComponent(root)}`);
    expect(listing.json.worktrees).toEqual(expect.arrayContaining([expect.objectContaining({ branch: 'feature/api-worktree', path: created.json.worktree.path })]));
    const tile = await api('POST', '/api/canvas/tiles', { kind: 'worktree', project: root.toLowerCase().replace(/\\/g, '/'), root, path, name: 'Feature work' });
    expect(tile.status).toBe(200);
    const id = tile.json.tile.id;
    expect((await api('GET', '/api/canvas/tiles')).json.tiles).toContainEqual(expect.objectContaining({ id, kind: 'worktree' }));
    const opened = await api('POST', '/api/consoles', { kind: 'shell', cwd: path, name: 'Worktree shell' });
    expect(opened.status).toBe(200);
    const consoleId = opened.json.console.id;
    try {
      expect(resolve(opened.json.console.cwd)).toBe(resolve(path));
      tower.consoles.write(consoleId, 'git branch --show-current\r');
      await expect.poll(() => tower.consoles.scrollbackOf(consoleId), { timeout: 15_000 }).toContain('feature/api-worktree');
      // Closing the manager tile leaves both the worktree and its terminal intact.
      expect((await api('POST', `/api/canvas/tiles/${id}/close`)).status).toBe(200);
      expect(tower.consoles.get(consoleId)?.state).toBe('running');
      expect((await api('GET', `/api/worktrees?root=${encodeURIComponent(root)}`)).json.worktrees).toHaveLength(2);
    } finally { await api('POST', `/api/consoles/${consoleId}/dismiss`, { confirm: true }); }
  }, 30_000);
});
