import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeRepo, tempDir } from './helpers.ts';

const PORT = 47_319;
const TOKEN = 'teams-token-0123456789';
const towerHome = join(tempDir('tower-'), 'agent-tower');
mkdirSync(towerHome, { recursive: true });
process.env.AGENT_TOWER_HOME = towerHome;
process.env.CLAUDE_HOME = tempDir('claude-home-');

const BRIDGE = join(__dirname, '..', 'daemon', 'teams', 'team-mcp.mjs');

// Claude agents are simulated and stay mid-turn (busy), so the test drives the team through the bridge.
// An agent that ends its turn without acting would correctly trip the idle guard and pause the team.
const sdkOptions: Array<Record<string, unknown>> = [];
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    sdkOptions.push(params.options);
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: `sdk-${sdkOptions.length}` };
      for await (const _msg of params.prompt) { /* keep working */ }
    }
    const gen = run() as AsyncGenerator<unknown> & { interrupt: () => Promise<void> };
    gen.interrupt = async () => undefined;
    return gen;
  },
}));

type Tower = import('../daemon/tower.ts').Tower;
let tower: Tower;
let server: Server;

const api = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-tower-token': TOKEN, ...(init.headers ?? {}) } });
const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });

/** What the bridge process sees: the server's own env plus the token inherited from the agent's environment. */
const teamEnv = (index: number): Record<string, string> => ({
  ...(sdkOptions[index].mcpServers as Record<string, { env: Record<string, string> }>).team.env,
  AGENT_TOWER_TEAM_TOKEN: (sdkOptions[index].env as Record<string, string>).AGENT_TOWER_TEAM_TOKEN,
});

type RpcResponse = { id: number; result?: any; error?: { code: number; message: string } };

/** Minimal MCP client over the real bridge process. */
function bridge(env: Record<string, string>) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [BRIDGE], { env: { ...process.env, ...env } });
  const pending = new Map<number, (msg: RpcResponse) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line) as RpcResponse;
    pending.get(msg.id)?.(msg);
  });
  let nextId = 1;
  const request = (method: string, params: unknown = {}) => new Promise<RpcResponse>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return {
    request,
    notify: (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
    close: () => child.kill(),
  };
}

async function until(fn: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  const { Tower } = await import('../daemon/tower.ts');
  const { startServer } = await import('../daemon/api/server.ts');
  tower = new Tower(':memory:');
  server = await startServer({ tower, port: PORT, host: '127.0.0.1', token: TOKEN });
});

afterAll(async () => {
  for (const team of tower.teams.list()) await tower.disbandTeam(team.id, true).catch(() => undefined);
  server?.close();
  await tower?.shutdown();
});

describe('teams over HTTP + the MCP bridge', () => {
  let teamId = '';

  it('creates a team through the operator API', async () => {
    const res = await post('/api/teams', {
      name: 'Bridge test',
      goal: 'Write a greeting',
      cwd: makeRepo(),
      members: [{ name: 'lead', role: 'lead', vendor: 'claude' }, { name: 'writer', vendor: 'claude', model: 'claude-sonnet-5-5' }],
    });
    const body = await res.json() as { team: { id: string; status: string } };
    expect(res.status).toBe(200);
    expect(body.team.status).toBe('running');
    teamId = body.team.id;
    expect(sdkOptions).toHaveLength(1);
    expect(teamEnv(0).AGENT_TOWER_TEAM_URL).toBe(`http://127.0.0.1:${PORT}`);
    const state = await (await api('/api/state')).json() as { teams: unknown[] };
    expect(state.teams).toHaveLength(1);
  });

  it('lets an agent coordinate through the stdio bridge with its own token', async () => {
    const client = bridge(teamEnv(0));
    try {
      const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      expect(init.result.serverInfo.name).toBe('agent-tower-team');
      expect(init.result.protocolVersion).toBe('2025-06-18');
      client.notify('notifications/initialized');

      const tools = await client.request('tools/list');
      expect(tools.result.tools.map((t: { name: string }) => t.name)).toContain('finish_team');

      const createdTask = await client.request('tools/call', { name: 'create_task', arguments: { title: 'Greeting', assignee: 'writer' } });
      expect(createdTask.result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'Created t1.' }] });

      const bad = await client.request('tools/call', { name: 'post_message', arguments: { to: 'ghost', text: 'hi' } });
      expect(bad.result.isError).toBe(true);

      const unknown = await client.request('resources/list');
      expect(unknown.error?.code).toBe(-32601);
    } finally {
      client.close();
    }
    // The assignment woke (started) the worker with its own model and a different token.
    await until(() => sdkOptions.length === 2);
    expect(sdkOptions[1].model).toBe('claude-sonnet-5-5');
    expect(teamEnv(1).AGENT_TOWER_TEAM_TOKEN).not.toBe(teamEnv(0).AGENT_TOWER_TEAM_TOKEN);
    expect((sdkOptions[1].hooks as { PreToolUse: Array<{ matcher: string }> }).PreToolUse.map((h) => h.matcher)).toEqual([expect.stringContaining("Write"), expect.stringContaining("Read")]);
  });

  it('refuses agent routes without a member token, even with the operator token', async () => {
    expect((await post('/team/call', { name: 'list_tasks' })).status).toBe(401);
    const forged = await fetch(`http://127.0.0.1:${PORT}/team/tools`, { method: 'POST', headers: { 'x-team-token': 'nope' }, body: '{}' });
    expect(forged.status).toBe(401);
    const client = bridge({ AGENT_TOWER_TEAM_URL: `http://127.0.0.1:${PORT}`, AGENT_TOWER_TEAM_TOKEN: 'forged' });
    try {
      const res = await client.request('tools/call', { name: 'list_tasks', arguments: {} });
      expect(res.result).toMatchObject({ isError: true });
      expect(res.result.content[0].text).toMatch(/not a team member/);
    } finally {
      client.close();
    }
  });

  it('shows the shared timeline and accepts operator messages', async () => {
    const log = await (await api(`/api/teams/${teamId}/log`)).json() as { entries: Array<{ summary: string }> };
    expect(log.entries.map((e) => e.summary).join('\n')).toContain('lead created t1 → writer: Greeting');
    const sent = await post(`/api/teams/${teamId}/message`, { to: 'all', text: 'keep it short' });
    expect(sent.status).toBe(200);
  });

  it('requires confirmation to merge or disband', async () => {
    expect((await post(`/api/teams/${teamId}/members/writer/merge`, {})).status).toBe(400);
    expect((await post(`/api/teams/${teamId}/disband`, {})).status).toBe(400);
    const missing = await post('/api/teams/zzzzzz/pause', {});
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe('Team not found.');
  });

  it('disbands the team and removes its worktrees', async () => {
    const res = await post(`/api/teams/${teamId}/disband`, { confirm: true });
    const body = await res.json() as { keptBranches: string[] };
    expect(res.status).toBe(200);
    expect(body.keptBranches).toHaveLength(2);
    expect(tower.teams.list()).toEqual([]);
  });
});
