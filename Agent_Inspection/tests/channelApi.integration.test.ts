import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeAgent, tempDir } from './helpers.ts';

const PORT = 47_336;
const TOKEN = 'channels-token-0123456789';
const CLI_LIMIT_MS = 15_000;
const towerHome = join(tempDir('tower-'), 'agent-tower');
mkdirSync(towerHome, { recursive: true });
process.env.AGENT_TOWER_HOME = towerHome;
process.env.CLAUDE_HOME = tempDir('claude-home-');

type Tower = import('../daemon/tower.ts').Tower;
let tower: Tower;
let server: Server;
let cliScript: string;

// Codex sessions Waystation only observes: they cannot be woken, so mail waits in their inbox.
const UI = makeAgent({ id: 'codex:ui', vendor: 'codex', name: 'UI work', pid: 900_001, status: 'busy', sessionId: undefined, hooked: false });
const API = makeAgent({ id: 'codex:api', vendor: 'codex', name: 'API work', pid: 900_002, status: 'idle', sessionId: undefined, hooked: false });

const api = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'content-type': 'application/json', 'x-tower-token': TOKEN },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** Runs the real CLI as a child process speaking for `agentId` (the managed-agent environment variable). */
function cli(agentId: string | undefined, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, AGENT_TOWER_HOME: towerHome, WAYSTATION_AGENT_ID: agentId ?? '' };
    const child = spawn(process.execPath, [cliScript, ...args], { env });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    // A hung CLI fails the test with its output rather than a bare timeout.
    const killer = setTimeout(() => { err += '[killed: no exit]'; child.kill(); }, CLI_LIMIT_MS);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

beforeAll(async () => {
  const { Tower } = await import('../daemon/tower.ts');
  const { startServer } = await import('../daemon/api/server.ts');
  ({ CHANNEL_CLI_SCRIPT: cliScript } = await import('../daemon/channels/skillInstall.ts'));
  tower = new Tower(':memory:');
  server = await startServer({ tower, port: PORT, host: '127.0.0.1', token: TOKEN });
  writeFileSync(join(towerHome, 'channels.json'), JSON.stringify({ port: PORT, token: tower.channels.token }));
  tower.registry.upsert('test', UI);
  tower.registry.upsert('test', API);
});

afterAll(async () => {
  server?.close();
  await tower?.shutdown();
});

describe('channels over HTTP and the ws-channel CLI', () => {
  let channelId = '';

  it('lets the operator create a channel and add running sessions', async () => {
    const created = await (await api('/api/channels', { name: 'Frontend', purpose: 'agree the users API' })).json();
    channelId = created.channel.id;
    const added = await (await api(`/api/channels/${channelId}/members`, { agentId: UI.id, name: 'ui' })).json();
    expect(added.member.name).toBe('ui');
    // An observed Codex session cannot be told directly; the operator sees why.
    expect(added.notice).toMatch(/^Added, but the session was not told/);
    await api(`/api/channels/${channelId}/members`, { agentId: API.id, name: 'api' });
    const listed = await (await api('/api/channels')).json();
    expect(listed.channels[0].members.map((m: { name: string }) => m.name)).toEqual(['ui', 'api']);
  });

  it('rejects agent calls without the channel token', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/agent/channel/whoami`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ caller: { agentId: UI.id } }),
    });
    expect(response.status).toBe(401);
  });

  it('tells an agent who it is and who it can talk to', async () => {
    const result = await cli(UI.id, 'whoami');
    expect(result.code).toBe(0);
    expect(result.out).toContain('#frontend: you are "ui"');
    expect(result.out).toContain('api (codex, idle)');
  });

  it('delivers a message to the other session\'s inbox', async () => {
    const sent = await cli(UI.id, 'send', 'api', 'What', 'does', 'GET /users', 'return?');
    expect(sent.code).toBe(0);
    expect(sent.out).toMatch(/Sent m_\w+ in #frontend\./);
    expect(sent.out).toContain('api: left in inbox');
    const inbox = await cli(API.id, 'inbox');
    expect(inbox.out).toContain('ui → api');
    expect(inbox.out).toContain('What does GET /users return?');
    expect((await cli(API.id, 'inbox')).out).toContain('No unread messages in #frontend.');
  });

  it('hands a reply straight to a member that is waiting for it', async () => {
    const waiting = cli(UI.id, 'wait', '--from', 'api', '--timeout', '20', '--json');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const reply = await cli(API.id, 'send', 'ui', '{ id, name }', '--json');
    expect(JSON.parse(reply.out).deliveries).toEqual([{ to: 'ui', via: 'waiting' }]);
    const result = JSON.parse((await waiting).out);
    expect(result.messages.map((m: { text: string }) => m.text)).toEqual(['{ id, name }']);
  }, 30_000);

  it('refuses sessions that are not on the channel, and unknown recipients', async () => {
    const outsider = makeAgent({ id: 'codex:outsider', vendor: 'codex', pid: 900_003, status: 'idle', sessionId: undefined });
    tower.registry.upsert('test', outsider);
    const denied = await cli(outsider.id, 'send', 'ui', 'hi');
    expect(denied.code).toBe(1);
    expect(denied.err).toContain('not a member of any channel');
    expect((await cli(UI.id, 'send', 'nobody', 'hi')).err).toContain('No member named "nobody"');
  });

  it('identifies a CLI by its process ancestry when no agent id is set', async () => {
    // This test process plays the agent: the CLI it spawns is its child.
    const host = makeAgent({ id: 'codex:host', vendor: 'codex', name: 'Host', pid: process.pid, status: 'busy', sessionId: undefined });
    tower.registry.upsert('test', host);
    await api(`/api/channels/${channelId}/members`, { agentId: host.id, name: 'host' });
    const result = await cli(undefined, 'whoami');
    expect(result.err).toBe('');
    expect(result.out).toContain('you are "host"');
  }, 30_000);

  it('installs the skill only with confirmation', async () => {
    const refused = await api('/api/channels/skill/install', {});
    expect(refused.status).toBe(400);
    const status = await (await api('/api/channels/skill')).json();
    expect(status.targets).toHaveLength(2);
  });
});
