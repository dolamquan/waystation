import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, tempDir } from './helpers.ts';

const sdkOptions: Array<Record<string, unknown>> = [];
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: AsyncIterable<{ message: { content: string } }>; options: Record<string, unknown> }) => {
    sdkOptions.push(params.options);
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: params.options.resume ?? 'claude-saved-session' };
      for await (const message of params.prompt) {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: `did: ${message.message.content}` }] } };
        yield { type: 'result', subtype: 'success' };
      }
    }
    const query = run() as AsyncGenerator<unknown> & { interrupt: () => Promise<void> };
    query.interrupt = async () => undefined;
    return query;
  },
}));

process.env.AGENT_TOWER_HOME = tempDir('sessions-tower-');
process.env.CLAUDE_HOME = tempDir('sessions-claude-');
process.env.CODEX_HOME = tempDir('sessions-codex-');
process.env.AGENT_TOWER_CODEX_JS = join(__dirname, 'fixtures', 'fake-codex.mjs');
const { Tower } = await import('../daemon/tower.ts');
const { startServer } = await import('../daemon/api/server.ts');
const TOKEN = 'sessions-token-0123456789';
let tower: InstanceType<typeof Tower> | undefined;
let server: Server | undefined;
const port = 47421;
const until = async (fn: () => boolean) => {
  const deadline = Date.now() + 10000;
  while (!fn()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
async function open(database: string) {
  tower = new Tower(database);
  server = await startServer({ tower, port, host: '127.0.0.1', token: TOKEN });
}
const api = async (method: string, path: string, body?: unknown, token = TOKEN) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-tower-token': token, 'content-type': 'application/json', connection: 'close' }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, json: await response.json() as Record<string, any> };
};
afterEach(async () => { server?.close(); if (tower) await tower.shutdown(); tower = undefined; });

describe('session history and editable queue API', () => {
  it('restores Claude in the same conversation, idle until a new instruction', async () => {
    const database = join(tempDir(), 'tower.db');
    await open(database);
    const launched = await api('POST', '/api/managed', { vendor: 'claude', cwd: tempDir(), prompt: 'Claude original task' });
    expect(launched.status).toBe(200);
    const id = launched.json.agent.id as string;
    await until(() => tower!.registry.get(id)?.status === 'idle');
    server!.close(); await tower!.shutdown(); tower = undefined;
    await open(database);
    expect((await api('POST', `/api/sessions/${encodeURIComponent(id)}/resume`)).json.agent).toMatchObject({ id, status: 'idle', sessionId: 'claude-saved-session' });
    expect(sdkOptions.at(-1)).toMatchObject({ resume: 'claude-saved-session', forkSession: false });
    expect(tower!.registry.recentEvents(id).some(event => event.kind === 'prompt')).toBe(false);
    expect(tower!.events(id).some(event => event.summary === 'Claude original task')).toBe(true);
    expect((await api('POST', `/api/agents/${encodeURIComponent(id)}/instruct`, { text: 'Claude follow-up' })).status).toBe(200);
    await until(() => tower!.events(id).some(event => event.summary === 'did: Claude follow-up'));
  }, 30000);

  it('resends uncertain terminal delivery only after confirmation and a fresh readiness check', async () => {
    await open(':memory:');
    const agent = makeAgent({ id: 'claude:terminal-review', sessionId: 'terminal-review', vendor: 'claude', tier: 'B', status: 'idle', pid: 1234, canInstruct: true });
    tower!.registry.upsert('test', agent);
    vi.spyOn(tower!.terminals, 'connected').mockReturnValue(true);
    const ready = vi.spyOn(tower!['claude'], 'readSessionFile').mockResolvedValue({ sessionId: agent.sessionId!, pid: agent.pid!, status: 'idle', kind: 'interactive', entrypoint: 'cli', procStart: '1234567890123' });
    const send = vi.spyOn(tower!.terminals, 'send').mockRejectedValueOnce(new Error('Lost terminal acknowledgement')).mockResolvedValue(undefined);
    const path = `/api/agents/${encodeURIComponent(agent.id)}`;
    expect((await api('POST', `${path}/instruct`, { text: 'terminal task' })).status).toBe(400);
    const message = tower!.messageQueue.list(agent.id)[0];
    expect(message.state).toBe('review');
    expect((await api('POST', `${path}/queue/${message.id}/send`, { confirm: false })).status).toBe(400);
    expect(send).toHaveBeenCalledTimes(1);
    ready.mockResolvedValueOnce(undefined);
    expect((await api('POST', `${path}/queue/${message.id}/send`, { confirm: true })).status).toBe(400);
    expect(tower!.messageQueue.list(agent.id)[0].state).toBe('review');
    expect((await api('POST', `${path}/queue/${message.id}/send`, { confirm: true })).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(tower!.messageQueue.list(agent.id)[0].state).toBe('delivered');
  });

  it('keeps saved messages on hold after restart and resumes the same conversation without spending a turn', async () => {
    const database = join(tempDir(), 'tower.db');
    await open(database);
    const launched = await api('POST', '/api/managed', { vendor: 'codex', cwd: tempDir(), prompt: 'original task', name: 'Recovered Codex' });
    expect(launched.status, JSON.stringify(launched.json)).toBe(200);
    const id = launched.json.agent.id as string;
    const path = `/api/agents/${encodeURIComponent(id)}`;
    await until(() => tower!.registry.get(id)?.status === 'idle');
    await api('POST', `${path}/instruct`, { text: 'SLOW current turn' });
    await api('POST', `${path}/instruct`, { text: 'queued original' });
    await api('POST', `${path}/instruct`, { text: 'cancel this' });
    let messages = (await api('GET', `${path}/queue`)).json.messages;
    const queued = messages.find((message: any) => message.text === 'queued original');
    const cancelled = messages.find((message: any) => message.text === 'cancel this');
    expect((await api('POST', `${path}/queue/${queued.id}/edit`, { text: 'edited after queueing' })).status).toBe(200);
    expect((await api('POST', `${path}/queue/${cancelled.id}/cancel`)).status).toBe(200);
    server!.close(); await tower!.shutdown(); tower = undefined;
    await open(database);
    const history = (await api('GET', '/api/sessions?q=Recovered')).json.sessions;
    expect(history[0]).toMatchObject({ id, state: 'interrupted', canResume: true });
    expect(tower!.registry.list()).toHaveLength(0);
    messages = (await api('GET', `${path}/queue`)).json.messages;
    expect(messages.find((message: any) => message.id === queued.id)).toMatchObject({ state: 'review', text: 'edited after queueing' });
    expect(messages.find((message: any) => message.id === cancelled.id).state).toBe('cancelled');
    expect((await api('GET', `${path}/outputs`)).status).toBe(200);
    const restored = await api('POST', `/api/sessions/${encodeURIComponent(id)}/resume`);
    expect(restored.status).toBe(200);
    expect(restored.json.agent).toMatchObject({ id, status: 'idle', sessionId: 'thread-123' });
    expect(tower!.registry.recentEvents(id).some(event => event.kind === 'prompt')).toBe(false);
    expect(tower!.events(id).some(event => event.kind === 'prompt' && event.summary === 'original task')).toBe(true);
    expect((await api('POST', `${path}/queue/${queued.id}/send`, { confirm: false })).status).toBe(400);
    expect((await api('POST', `${path}/queue/${queued.id}/send`, { confirm: true })).status).toBe(200);
    await until(() => tower!.registry.recentEvents(id).some(event => event.summary === 'resumed: edited after queueing'));
    expect(tower!.registry.recentEvents(id).some(event => event.summary === 'resumed: cancel this')).toBe(false);
    expect((await api('GET', '/api/sessions', undefined, 'wrong-token')).status).toBe(401);
  }, 30000);
});
