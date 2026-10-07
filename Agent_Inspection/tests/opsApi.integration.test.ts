import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tempDir } from './helpers.ts';

const PORT = 47_322;
const TOKEN = 'ops-token-0123456789abcdef';
const towerHome = join(tempDir('tower-'), 'agent-tower');
mkdirSync(towerHome, { recursive: true });
process.env.AGENT_TOWER_HOME = towerHome;
process.env.CLAUDE_HOME = tempDir('claude-home-');

const sdkOptions: Array<Record<string, unknown>> = [];
const askResults: unknown[] = [];
let messageSeq = 0;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: AsyncIterable<{ message: { content: string } }>; options: Record<string, unknown> }) => {
    sdkOptions.push(params.options);
    const canUseTool = params.options.canUseTool as (n: string, i: Record<string, unknown>, o: object) => Promise<unknown>;
    const model = (params.options.model as string | undefined) ?? 'claude-opus-5-5';
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: (params.options.resume as string | undefined) ?? `sdk-${sdkOptions.length}`, model };
      for await (const msg of params.prompt) {
        if (msg.message.content.includes('ask')) {
          askResults.push(await canUseTool('AskUserQuestion', {
            questions: [{ question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: 'SQL' }, { label: 'SQLite', description: 'File' }] }],
          }, {}));
        }
        messageSeq += 1;
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            id: `msg-${messageSeq}`, model,
            usage: { input_tokens: 1000, output_tokens: 500_000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 },
            content: [{ type: 'text', text: `did: ${msg.message.content}` }],
          },
        };
        yield { type: 'result', subtype: 'success', modelUsage: { [model]: { contextWindow: 1_000_000 } } };
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

const api = async (method: string, path: string, body?: unknown, token = TOKEN) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-tower-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

async function until<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
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

describe('operator features through the API', () => {
  it('rejects requests without the token', async () => {
    expect((await api('GET', '/api/usage', undefined, 'wrong')).status).toBe(401);
  });

  it('shows model, usage and context on a managed agent, and records spend', async () => {
    const launched = await api('POST', '/api/managed', { vendor: 'claude', cwd: tempDir(), prompt: 'work', name: 'Spender', model: 'claude-sonnet-5-5' });
    const id = launched.json.agent.id as string;
    const agent = await until(() => {
      const a = tower.registry.get(id);
      return a?.status === 'idle' && a.usage ? a : undefined;
    });
    expect(agent.model).toBe('claude-sonnet-5-5');
    expect(agent.usage).toMatchObject({ contextTokens: 10_000, contextWindow: 1_000_000 });
    // Sonnet 5.5: 1000 input * $2 + 500k output * $10 + 9000 cache reads * $0.20, per million.
    expect(agent.usage?.costUsd).toBeCloseTo(0.002 + 5 + 0.0018, 4);
    const { json } = await api('GET', '/api/usage?days=7');
    expect(json.usage.today.costUsd).toBeGreaterThan(5);
    expect(json.usage.byAgent.find((row: { agentId: string }) => row.agentId === id)).toMatchObject({ name: 'Spender', priced: true });
  });

  it('holds an agent question for the operator and returns the answer to the agent', async () => {
    const launched = await api('POST', '/api/managed', { vendor: 'claude', cwd: tempDir(), prompt: 'please ask me' });
    const id = launched.json.agent.id as string;
    const pending = await until(() => tower.interceptions.list().find((p) => p.agentId === id));
    expect(pending.toolName).toBe('AskUserQuestion');
    expect(tower.registry.get(id)?.status).toBe('waiting');
    const answer = { behavior: 'allow', updatedInput: { ...pending.input, answers: { 'Which database?': 'SQLite' } } };
    expect((await api('POST', `/api/interceptions/${pending.id}`, answer)).status).toBe(200);
    const result = await until(() => askResults[0] as { behavior: string; updatedInput: { answers: Record<string, string> } } | undefined);
    expect(result).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which database?': 'SQLite' } } });
  });

  it('renames an agent and restarts it on the same conversation with a new model', async () => {
    const launched = await api('POST', '/api/managed', { vendor: 'claude', cwd: tempDir(), prompt: 'start', model: 'claude-sonnet-5-5' });
    const id = launched.json.agent.id as string;
    await until(() => tower.registry.get(id)?.status === 'idle');
    const sessionId = tower.registry.get(id)?.sessionId;
    expect(sessionId).toBeTruthy();

    expect((await api('POST', `/api/agents/${id}/name`, { name: 'Renamed' })).json).toEqual({ ok: true, name: 'Renamed' });
    expect(tower.registry.get(id)?.name).toBe('Renamed');

    expect((await api('POST', `/api/agents/${id}/restart`, { model: 'claude-opus-5-5' })).status).toBe(400);
    const restarted = await api('POST', `/api/agents/${id}/restart`, { model: 'claude-opus-5-5', confirm: true });
    expect(restarted.status).toBe(200);
    expect(restarted.json.agent.id).toBe(id);
    expect(sdkOptions.at(-1)).toMatchObject({ resume: sessionId, forkSession: false, model: 'claude-opus-5-5' });
    await until(() => tower.registry.get(id)?.model === 'claude-opus-5-5' && tower.registry.get(id)?.status === 'idle');
    expect(tower.registry.get(id)?.name).toBe('Renamed');

    expect((await api('POST', '/api/agents/claude:not-managed/restart', { confirm: true })).status).toBe(400);
  });

  it('saves and deletes templates, validates schedules, and lists prerequisites', async () => {
    const created = await api('POST', '/api/templates', { label: 'Reviewer', vendor: 'claude', model: 'claude-haiku-4-5', instructions: 'Review only.' });
    expect(created.status).toBe(200);
    expect((await api('GET', '/api/templates')).json.templates).toHaveLength(1);
    expect((await api('POST', '/api/templates', { label: 'Bad', vendor: 'claude', model: '--x' })).status).toBe(400);
    expect((await api('POST', `/api/templates/${created.json.template.id}/delete`)).status).toBe(200);

    const schedule = await api('POST', '/api/schedules', { label: 'Nightly', time: '02:30', days: [1, 2], launch: { vendor: 'claude', cwd: tempDir(), prompt: 'tidy up' } });
    expect(schedule.status).toBe(200);
    expect(schedule.json.schedule.nextRunAt).toBeGreaterThan(Date.now());
    expect((await api('POST', '/api/schedules', { label: 'Bad', time: '02:30', days: [1], launch: { vendor: 'claude', cwd: 'C:\\no\\such\\dir', prompt: 'x' } })).status).toBe(400);
    expect((await api('POST', `/api/schedules/${schedule.json.schedule.id}/delete`, {})).status).toBe(400);
    expect((await api('POST', `/api/schedules/${schedule.json.schedule.id}/delete`, { confirm: true })).status).toBe(200);

    const prereqs = await api('GET', '/api/prerequisites');
    expect(prereqs.json.prerequisites.map((p: { id: string }) => p.id)).toEqual(['node', 'git', 'claude', 'codex', 'terminal', 'hooks']);
  });
});
