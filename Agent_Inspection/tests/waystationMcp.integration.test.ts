import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';
import { tempDir } from './helpers.ts';
import { AUTOMATION_SCRIPT, AUTOMATION_TOKEN_ENV } from '../daemon/automation/automation.ts';
import { CanvasStore } from '../daemon/automation/canvas.ts';
import { TowerStore } from '../daemon/store/db.ts';
import { claudeSdkMcp } from '../daemon/managed/claudeRunner.ts';
import { codexArgs, codexEnv } from '../daemon/managed/codexRunner.ts';
import { acpMcpServers } from '../daemon/managed/acpRunner.ts';
import { copilotMcpServers } from '../daemon/managed/copilotRunner.ts';

const PORT = 47_336;
const ROOT = tempDir('waystation-mcp-project-');
const OTHER = tempDir('waystation-mcp-other-');
const HOME = tempDir('waystation-mcp-home-');
process.env.AGENT_TOWER_HOME = HOME;
process.env.CLAUDE_HOME = tempDir('waystation-mcp-claude-');
let tower: import('../daemon/tower.ts').Tower;
let server: Server;
let sequence = 0;
const post = (body: unknown, token = tower.library.automation.token, extra: Record<string, string> = {}) => fetch(`http://127.0.0.1:${PORT}/mcp`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify(body),
});
const rpc = async (method: string, params: unknown = {}, token?: string) => (await post({ jsonrpc: '2.0', id: ++sequence, method, params }, token)).json();
const call = async (name: string, args: Record<string, unknown> = {}, token?: string) => (await rpc('tools/call', { name, arguments: { project: ROOT, ...args } }, token)).result;

beforeAll(async () => {
  const { Tower } = await import('../daemon/tower.ts');
  const { startServer } = await import('../daemon/api/server.ts');
  tower = new Tower(':memory:');
  server = await startServer({ tower, port: PORT, host: '127.0.0.1', token: 'operator-only-token' });
  writeFileSync(join(ROOT, 'result.md'), '# Results\n42 checks passed.');
});
afterAll(async () => { server?.close(); await tower?.shutdown(); });

describe('Waystation MCP over HTTP and stdio', () => {
  it('requires the operator token and a trusted origin for browser tile sockets', async () => {
    for (const [token, origin] of [['wrong', `http://127.0.0.1:${PORT}`], ['operator-only-token', 'https://evil.example']]) {
      const status = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/browser/no-such-tile`, ['agent-tower', token], { origin });
        ws.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); ws.terminate(); });
        ws.on('error', () => undefined);
        ws.on('open', () => { ws.terminate(); reject(new Error('Unauthenticated browser socket opened')); });
      });
      expect(status).toBe(403);
    }
  });

  it('requires its own token and validates HTTP and protocol envelopes', async () => {
    expect((await post({}, 'operator-only-token')).status).toBe(401);
    expect((await post({}, 'wrong')).status).toBe(401);
    expect((await post({}, undefined, { origin: 'http://evil.test' })).status).toBe(403);
    expect((await post({}, undefined, { 'mcp-protocol-version': '2099-01-01' })).status).toBe(400);
    expect((await post([])).status).toBe(200);
    expect((await (await post([])).json()).error.code).toBe(-32600);
    expect((await rpc('unknown')).error.code).toBe(-32601);
    expect((await rpc('initialize', { protocolVersion: '2025-11-25' })).result.serverInfo.name).toBe('waystation');
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const tools = (await rpc('tools/list')).result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toContain('create_note');
    expect(tools.map((tool: { name: string }) => tool.name)).not.toContain('execute');
    expect(JSON.stringify(tools)).not.toContain(tower.library.automation.token);
  });

  it('creates, reads, updates, reveals and closes notes through the same store as the UI', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, ['agent-tower', 'operator-only-token']);
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    try {
      const revealed = new Promise<any>(resolve => ws.on('message', data => {
        const message = JSON.parse(String(data)); if (message.type === 'canvas_reveal') resolve(message.reveal);
      }));
      const created = await call('create_note', { name: 'Results', content: '# Done\n- Passed' });
      expect(created.isError).toBe(false);
      const tile = created.structuredContent.tile;
      expect((await revealed).id).toBe(tile.id);
      const response = await fetch(`http://127.0.0.1:${PORT}/api/canvas/tiles`, { headers: { 'x-tower-token': 'operator-only-token' } });
      expect((await response.json()).tiles).toContainEqual(tile);
      expect((await call('get_tile', { id: tile.id })).structuredContent.tile.content).toContain('# Done');
      expect((await call('list_tiles')).structuredContent.tiles.find((other: any) => other.id === tile.id).content).toBeUndefined();
      expect((await call('update_tile', { id: tile.id, content: 'Updated', name: 'Final results' })).structuredContent.tile.name).toBe('Final results');
      expect((await call('get_tile', { id: tile.id })).structuredContent.tile.content).toBe('Updated');
      const conflicting = await fetch(`http://127.0.0.1:${PORT}/api/canvas/tiles/${tile.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-token': 'operator-only-token' }, body: JSON.stringify({ content: 'Overwrite', expectedContent: '# Done\n- Passed' }) });
      expect(conflicting.status).toBe(400);
      expect((await call('get_tile', { id: tile.id })).structuredContent.tile.content).toBe('Updated');
      expect((await call('close_tile', { id: tile.id, confirm: false })).isError).toBe(true);
      expect((await call('close_tile', { id: tile.id, confirm: true })).isError).toBe(false);
      expect((await call('get_tile', { id: tile.id })).isError).toBe(true);
    } finally { ws.terminate(); }
  });

  it('opens project files and local previews while refusing missing files and escapes', async () => {
    const opened = await call('open_file', { path: 'result.md', reveal: false });
    expect(opened.isError).toBe(false);
    expect((await call('open_file', { path: 'result.md', reveal: false })).structuredContent.tile.id).toBe(opened.structuredContent.tile.id);
    expect((await call('open_file', { path: '../outside.md' })).isError).toBe(true);
    expect((await call('open_file', { path: 'missing.md' })).isError).toBe(true);
    expect((await call('open_preview', { url: 'https://example.com', reveal: false })).structuredContent.tile.url).toBe('https://example.com/');
    expect((await call('open_preview', { url: 'https://example.com:47336', reveal: false })).isError).toBe(false);
    expect((await call('open_preview', { url: `http://localhost:${PORT}` })).isError).toBe(true);
    expect((await call('open_preview', { url: 'http://localhost:3000', reveal: false })).structuredContent.tile.url).toBe('http://localhost:3000/');
    expect((await call('list_files')).structuredContent.listing.entries.map((file: any) => file.name)).toContain('result.md');
    expect((await call('create_note', { name: 'Bad', content: 42 })).isError).toBe(true);
    expect((await call('create_note', { name: 'Bad', content: 'x'.repeat(100_001) })).isError).toBe(true);
    expect((await call('update_tile', { id: opened.structuredContent.tile.id, content: 'Wrong kind' })).isError).toBe(true);
  });

  it('attaches a private scoped grant supported by each managed provider and revokes it on exit', async () => {
    const launch = tower.library.automation.attachDefaults({ vendor: 'claude', cwd: ROOT, prompt: '', agentId: 'managed:mcp-test' });
    const token = launch.env![AUTOMATION_TOKEN_ENV];
    expect(launch.mcpServers!.waystation.inheritEnv).toContain(AUTOMATION_TOKEN_ENV);
    expect(JSON.stringify(launch.mcpServers)).not.toContain(token);
    expect(claudeSdkMcp(launch).mcpServers!.waystation).toMatchObject({ env: { [AUTOMATION_TOKEN_ENV]: '${WAYSTATION_MCP_TOKEN}' } });
    expect(codexEnv(launch, {})[AUTOMATION_TOKEN_ENV]).toBe(token);
    expect(codexArgs('codex.js', launch).join(' ')).not.toContain(token);
    expect(acpMcpServers(launch).find(server => server.name === 'waystation')).toMatchObject({ env: expect.arrayContaining([{ name: AUTOMATION_TOKEN_ENV, value: token }]) });
    expect(copilotMcpServers(launch).waystation).toMatchObject({ env: { [AUTOMATION_TOKEN_ENV]: token } });
    const created = await call('create_note', { name: 'Scoped', content: 'Private project', reveal: false }, token);
    expect(created.isError).toBe(false);
    expect((await call('list_tiles', { project: OTHER }, token)).isError).toBe(true);
    tower.library.notifier.revoke(launch.agentId!);
    expect((await post({}, token)).status).toBe(401);
  });

  it('runs the standalone stdio bridge and re-reads discovery after token rotation', async () => {
    const info = join(HOME, 'mcp.json');
    writeFileSync(info, JSON.stringify({ url: `http://127.0.0.1:${PORT}`, token: 'stale' }));
    const bridge = spawn(process.execPath, [AUTOMATION_SCRIPT], { cwd: ROOT, env: { ...process.env, AGENT_TOWER_HOME: HOME } });
    const waiting = new Map<number, (value: any) => void>();
    const lines = createInterface({ input: bridge.stdout });
    lines.on('line', line => { const message = JSON.parse(line); waiting.get(message.id)?.(message); waiting.delete(message.id); });
    let id = 0;
    const request = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(() => { waiting.delete(next); reject(new Error('stdio MCP timed out')); }, 5000);
      waiting.set(next, value => { clearTimeout(timer); resolve(value); });
      bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`);
    });
    try {
      expect((await request('initialize', { protocolVersion: '2025-11-25' })).error).toBeDefined();
      writeFileSync(info, JSON.stringify({ url: `http://127.0.0.1:${PORT}`, token: tower.library.automation.token }));
      expect((await request('initialize', { protocolVersion: '2025-11-25' })).result.serverInfo.name).toBe('waystation');
      expect((await request('tools/call', { name: 'create_note', arguments: { name: 'From stdio', content: 'Created by a coding agent', reveal: false } })).result.isError).toBe(false);
    } finally { lines.close(); bridge.kill(); }
  });

  it('persists tiles across a database restart without discarding tiles when full', () => {
    const db = join(tempDir('waystation-canvas-db-'), 'canvas.db');
    let store = new TowerStore(db);
    let canvas = new CanvasStore(store);
    const note = canvas.create({ kind: 'note', project: 'p', name: 'Persistent', content: '**Saved**' });
    store.close(); store = new TowerStore(db); canvas = new CanvasStore(store);
    try {
      expect(canvas.require(note.id).content).toBe('**Saved**');
      for (let i = 1; i < 32; i++) canvas.create({ kind: 'blank', project: 'p' });
      expect(() => canvas.create({ kind: 'blank', project: 'p' })).toThrow(/Close a tile/);
      expect(canvas.require(note.id).content).toBe('**Saved**');
    } finally { store.close(); }
  });
});
