import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tempDir } from './helpers.ts';
import { WebSocket } from 'ws';
import { NOTIFY_TOKEN_ENV } from '../daemon/notify/notifier.ts';

const PORT = 47_318;
const TOKEN = 'actions-token-0123456789';
const towerHome = join(tempDir('tower-'), 'agent-tower');
const claudeHome = tempDir('claude-home-');
mkdirSync(towerHome, { recursive: true });
process.env.AGENT_TOWER_HOME = towerHome;
process.env.CLAUDE_HOME = claudeHome;
process.env.AGENT_TOWER_CODEX_JS = join(__dirname, 'fixtures', 'fake-codex.mjs');

// A user skill the tower can attach.
const skillDir = join(claudeHome, 'skills', 'release-notes');
mkdirSync(skillDir, { recursive: true });
writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: release-notes\ndescription: Write release notes\n---\n');

const sdkOptions: Array<Record<string, unknown>> = [];
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: AsyncIterable<{ message: { content: string } }>; options: Record<string, unknown> }) => {
    sdkOptions.push(params.options);
    const canUseTool = params.options.canUseTool as (n: string, i: Record<string, unknown>, o: object) => Promise<unknown>;
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: `sdk-${sdkOptions.length}` };
      for await (const msg of params.prompt) {
        await canUseTool('Write', { file_path: 'notes.md' }, {});
        yield { type: 'assistant', message: { content: [{ type: 'text', text: `did: ${msg.message.content}` }] } };
        yield { type: 'result', subtype: 'success' };
      }
    }
    const gen = run() as AsyncGenerator<unknown> & { interrupt: () => Promise<void> };
    gen.interrupt = async () => undefined;
    return gen;
  },
}));

type Tower = import('../daemon/tower.ts').Tower;
let tower: Tower;
let server: Server;

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-tower-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

async function until<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  const { Tower } = await import('../daemon/tower.ts');
  const { startServer } = await import('../daemon/api/server.ts');
  tower = new Tower(':memory:');
  server = await startServer({ tower, port: PORT, host: '127.0.0.1', token: TOKEN });
});

afterAll(async () => {
  server?.close();
  await tower?.shutdown();
});

describe('managed agents through the API', () => {
  it('routes an agent notification through an authenticated desktop connection', async () => {
    const launched = await api('POST', '/api/managed', { vendor: 'claude', cwd: tempDir(), prompt: 'desktop update' });
    expect(launched.status).toBe(200);
    const id = launched.json.agent.id as string;
    const options = sdkOptions.at(-1)!;
    const env = options.env as Record<string, string>;
    expect(options.systemPrompt).toMatchObject({ append: expect.stringContaining('configured by Waystation') });
    expect((options.mcpServers as Record<string, unknown>).notify).toMatchObject({ alwaysLoad: true });
    expect(tower.library.notifier.authenticate(env[NOTIFY_TOKEN_ENV])?.agentId).toBe(id);
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, ['agent-tower', TOKEN]);
    try {
      const ready = new Promise<void>((resolve) => socket.once('message', () => resolve()));
      socket.on('message', (data) => {
        const message = JSON.parse(String(data));
        if (message.type === 'desktop:notify') {
          expect(message.title).toBe('Test update');
          socket.send(JSON.stringify({ type: 'desktop:ack', id: message.id, ok: true }));
        }
      });
      await ready;
      socket.send(JSON.stringify({ type: 'desktop:register' }));
      // A subsequent frame proves the server processed registration before the HTTP send.
      await new Promise<void>((resolve) => { socket.once('pong', () => resolve()); socket.ping(); });
      const response = await fetch(`http://127.0.0.1:${PORT}/agent/notify`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-token': env[NOTIFY_TOKEN_ENV] },
        body: JSON.stringify({ title: 'Test update', body: 'Sent from the managed agent' }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).results).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true })]));
      expect(tower.library.notifier.notifications().notifications[0]).toMatchObject({ title: 'Test update', agentId: id, deliveries: [expect.objectContaining({ ok: true })] });
    } finally { socket.terminate(); }
    expect((await api('POST', `/api/agents/${encodeURIComponent(id)}/stop`, { confirm: true })).status).toBe(200);
  });

  it('launches a Claude agent, intercepts its tool call, and approves it from the API', async () => {
    const project = tempDir();
    const launched = await api('POST', '/api/managed', { vendor: 'claude', cwd: project, prompt: 'write notes', intercept: true });
    expect(launched.status).toBe(200);
    const id = launched.json.agent.id as string;
    expect((sdkOptions.at(-1)?.env as Record<string, string>).AGENT_TOWER_MANAGED).toBe('1');

    const pending = await until(() => tower.interceptions.list()[0]);
    expect(pending).toMatchObject({ agentId: id, toolName: 'Write', origin: 'managed' });
    expect(tower.registry.get(id)?.status).toBe('waiting');
    expect((await api('POST', `/api/interceptions/${pending.id}`, { behavior: 'allow', updatedInput: [1] })).status).toBe(400);
    expect((await api('POST', `/api/interceptions/${pending.id}`, { behavior: 'maybe' })).status).toBe(400);
    expect((await api('POST', `/api/interceptions/${pending.id}`, { behavior: 'allow' })).status).toBe(200);
    await until(() => tower.registry.get(id)?.status === 'idle');

    expect((await api('POST', `/api/agents/${id}/intercept`, { on: false })).status).toBe(200);
    expect((await api('POST', `/api/agents/${id}/instruct`, { text: 'now summarize' })).json.message).toBe('Sent.');
    await until(() => tower.events(id).some((e) => e.summary === 'did: now summarize'));
    expect((await api('POST', `/api/agents/${id}/interrupt`)).status).toBe(200);
    expect((await api('GET', `/api/agents/${id}/events`)).json.events.length).toBeGreaterThan(0);

    // Attach a skill: copied into the project and announced to the agent.
    const skills = (await api('GET', '/api/skills')).json.skills as Array<{ id: string; name: string }>;
    const skill = skills.find((s) => s.name === 'release-notes');
    expect(skill).toBeDefined();
    expect((await api('POST', `/api/agents/${id}/skills`, { skillId: skill!.id })).status).toBe(400);
    const attached = await api('POST', `/api/agents/${id}/skills`, { skillId: skill!.id, confirm: true });
    expect(attached.status).toBe(200);
    expect(existsSync(join(project, '.claude', 'skills', 'release-notes', 'SKILL.md'))).toBe(true);
    expect((await api('POST', `/api/agents/${id}/skills`, { skillId: 'nope', confirm: true })).json.error).toMatch(/Unknown skill/);

    // Delegate: forks the session into a new managed agent and stops the original.
    const sessionId = tower.registry.get(id)?.sessionId;
    const delegated = await api('POST', `/api/agents/${id}/delegate`, { prompt: 'write the changelog', stopOriginal: true });
    expect(delegated.status).toBe(200);
    expect(sdkOptions.at(-1)).toMatchObject({ resume: sessionId, forkSession: true });
    await until(() => tower.registry.get(id)?.status === 'stopped');
    expect((await api('POST', `/api/agents/${id}/delegate`, { prompt: '' })).json.error).toMatch(/Describe/);
  });

  it('launches a Codex agent and stops it', async () => {
    const launched = await api('POST', '/api/managed', { vendor: 'codex', cwd: tempDir(), prompt: 'hello codex' });
    const id = launched.json.agent.id as string;
    await until(() => tower.registry.get(id)?.status === 'idle');
    expect((await api('POST', `/api/agents/${id}/intercept`, { on: true })).json.error).toMatch(/not available/);
    expect((await api('POST', `/api/agents/${id}/stop`, { confirm: true })).status).toBe(200);
    expect(tower.registry.get(id)?.status).toBe('stopped');
    expect((await api('POST', `/api/agents/${id}/instruct`, { text: 'more' })).json.error).toMatch(/stopped/);
  });

  it('accepts a follow-up while Codex is working and delivers it after the current turn', async () => {
    const launched = await api('POST', '/api/managed', { vendor: 'codex', cwd: tempDir(), prompt: 'first task' });
    const id = launched.json.agent.id as string;
    expect(launched.json.agent.canInstruct).toBe(true);
    const response = await api('POST', `/api/agents/${id}/instruct`, { text: 'follow-up task' });
    expect(response.status).toBe(200);
    expect(response.json.message).toMatch(/Queued/);
    await until(() => tower.registry.recentEvents(id).some(event => event.summary === 'resumed: follow-up task'));
    await until(() => tower.registry.get(id)?.status === 'idle');
    expect(tower.registry.get(id)?.sessionId).toBe('thread-123');
    await api('POST', `/api/agents/${id}/stop`, { confirm: true });
  });
});

describe('guards on observe-only and missing agents', () => {
  it('explains why actions are unavailable', async () => {
    tower.registry.upsert('test', {
      id: 'codex:observed', vendor: 'codex', tier: 'C', name: 'obs', project: 'p', status: 'busy', source: 's',
      hooked: false, intercepting: false, canInstruct: false, stopBlockedReason: 'shared app-server', cwd: tempDir(),
    });
    expect((await api('POST', '/api/agents/codex%3Aobserved/instruct', { text: 'x' })).json.error).toMatch(/observe-only/);
    expect((await api('POST', '/api/agents/codex%3Aobserved/instruct', { text: '' })).json.error).toMatch(/required/);
    expect((await api('POST', '/api/agents/codex%3Aobserved/intercept', { on: true })).json.error).toMatch(/Claude Code sessions/);
    expect((await api('POST', '/api/agents/codex%3Aobserved/interrupt')).json.error).toMatch(/launched from the tower/);
    expect((await api('POST', '/api/agents/codex%3Aobserved/stop', { confirm: true })).json.error).toBe('shared app-server');
    expect((await api('POST', '/api/agents/missing/intercept', { on: true })).json.error).toMatch(/not found/);
    expect((await api('POST', '/api/hooks/install', {})).json.error).toMatch(/confirm/);

    // Delegating from a non-Claude agent hands off a summary instead of resuming.
    tower.registry.pushEvent({ agentId: 'codex:observed', ts: Date.now(), kind: 'tool_call', summary: 'exec: npm run build' });
    const delegated = await api('POST', '/api/agents/codex%3Aobserved/delegate', { prompt: 'finish the build' });
    expect(delegated.status).toBe(200);
    expect(sdkOptions.at(-1)?.resume).toBeUndefined();
  });

  it('records hook events, including session lifecycle', () => {
    const sid = '12345678-1234-1234-1234-123456789abc';
    tower.handleHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'start' });
    tower.handleHookEvent({ hook_event_name: 'SessionStart', session_id: sid, source: 'resume' });
    tower.handleHookEvent({ hook_event_name: 'Stop', session_id: sid, delivered: ['x'] });
    tower.handleHookEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'exit' });
    tower.handleHookEvent({ hook_event_name: 'Notification', session_id: sid });
    tower.handleHookEvent({ hook_event_name: 'Stop' });
    const kinds = tower.events(`claude:${sid}`).map((e) => e.kind);
    expect(kinds).toEqual(['prompt', 'system', 'status', 'system', 'stop']);
  });
});
