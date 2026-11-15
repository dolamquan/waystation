import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from './helpers.ts';

vi.mock('../daemon/collectors/processScanner.ts', async original => ({
  ...await original<typeof import('../daemon/collectors/processScanner.ts')>(),
  scanProcesses: vi.fn(async () => [
    { pid: 123, ppid: 1, name: 'copilot-runtime.exe', commandLine: 'copilot-runtime.exe --token SECRET-MUST-NOT-LEAK', created: '2026-10-19T00:00:00Z' },
    { pid: 124, ppid: 1, name: 'my-agent.exe', commandLine: 'my-agent.exe --prompt private', created: '2026-10-19T00:00:01Z' },
  ]),
}));
process.env.AGENT_TOWER_HOME = tempDir('discovery-home-');
process.env.CLAUDE_HOME = tempDir('discovery-claude-');
process.env.CODEX_HOME = tempDir('discovery-codex-');
const { Tower } = await import('../daemon/tower.ts');
const { startServer } = await import('../daemon/api/server.ts');
const { scanProcesses } = await import('../daemon/collectors/processScanner.ts');
const TOKEN = 'discovery-token-0123456789';
let tower: InstanceType<typeof Tower> | undefined;
let server: Server | undefined;
let port: number;
async function open(database: string) {
  tower = new Tower(database);
  server = await startServer({ tower, port: 47449, host: '127.0.0.1', token: TOKEN });
  port = (server.address() as { port: number }).port;
}
const api = async (method: string, path: string, body?: unknown, token = TOKEN) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-tower-token': token, 'content-type': 'application/json', connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, json: await response.json() as Record<string, any> };
};
afterEach(async () => { server?.close(); if (tower) await tower.shutdown(); tower = undefined; });

describe('provider discovery end to end', () => {
  it('discovers Copilot, authenticates rule changes, updates the fleet, retains history and persists rules across restart', async () => {
    const database = join(tempDir(), 'tower.db');
    await open(database);
    await tower!.refreshDiscovery();
    const discovery = await api('GET', '/api/discovery');
    expect(discovery.status).toBe(200);
    expect(discovery.json.agents).toEqual([expect.objectContaining({ providerId: 'copilot', observation: expect.objectContaining({ host: 'editor' }) })]);
    expect(JSON.stringify(discovery.json)).not.toContain('SECRET-MUST-NOT-LEAK');
    expect((await api('POST', '/api/discovery', { label: 'My Agent', executable: 'my-agent.exe' }, 'bad-token')).status).toBe(401);
    expect((await api('POST', '/api/discovery', { label: 'Bad', executable: 'Code.exe' })).status).toBe(400);
    const added = await api('POST', '/api/discovery', { label: 'My Agent', executable: 'my-agent.exe' });
    expect(added.status).toBe(200);
    expect(tower!.registry.list()).toHaveLength(2);
    const copilot = tower!.registry.list().find(agent => agent.providerId === 'copilot')!;
    expect((await api('POST', `/api/agents/${encodeURIComponent(copilot.id)}/stop`)).status).toBe(400);
    expect((await api('POST', `/api/agents/${encodeURIComponent(copilot.id)}/instruct`, { text: 'hello' })).status).toBe(400);
    const history = await api('GET', '/api/sessions?q=Copilot');
    expect(history.json.sessions).toEqual([expect.objectContaining({ live: true, canResume: false })]);
    const id = added.json.rule.id;
    server!.close(); await tower!.shutdown(); tower = undefined;
    await open(database);
    expect((await api('GET', '/api/discovery')).json.rules.some((rule: { id: string }) => rule.id === id)).toBe(true);
    await tower!.refreshDiscovery();
    expect(tower!.registry.list()).toHaveLength(2);
    expect((await api('POST', '/api/discovery/copilot/remove')).status).toBe(400);
    expect((await api('POST', `/api/discovery/${id}/remove`)).status).toBe(200);
    expect(tower!.registry.list()).toHaveLength(1);
    vi.mocked(scanProcesses).mockResolvedValueOnce([]);
    await tower!.refreshDiscovery();
    expect((await api('GET', '/api/sessions?q=Copilot')).json.sessions[0]).toMatchObject({ state: 'finished', live: false, canResume: false });
  });
});
