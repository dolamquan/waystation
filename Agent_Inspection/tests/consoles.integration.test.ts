import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from './helpers.ts';
import type { ConsoleServerMessage } from '../daemon/pty/types.ts';

const PORT = 47_323;
const TOKEN = 'console-token-0123456789abcdef';
const towerHome = join(tempDir('tower-'), 'agent-tower');
mkdirSync(towerHome, { recursive: true });
process.env.AGENT_TOWER_HOME = towerHome;
process.env.CLAUDE_HOME = tempDir('claude-home-');

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

/** A command whose output (42) differs from its own echoed text, in whichever shell the console starts. */
const MATH_COMMAND = process.platform === 'win32' ? "echo ('e2e-' + (6*7))\r" : 'echo e2e-$((6*7))\r';
const MATH_OUTPUT = 'e2e-42';
const TIMEOUT_MS = 20_000;

const connect = (id: string, token = TOKEN): Promise<{ ws: WebSocket; messages: ConsoleServerMessage[] }> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/pty/${id}`, ['agent-tower', token]);
    const messages: ConsoleServerMessage[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ConsoleServerMessage));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
  });

async function until<T>(fn: () => T | undefined | false, ms = TIMEOUT_MS): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const printed = (messages: ConsoleServerMessage[]): string =>
  messages.map((message) => ('data' in message ? message.data : '')).join('');

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

describe('console board through the API', () => {
  it('requires the token and validates the request', async () => {
    expect((await api('GET', '/api/consoles', undefined, 'wrong')).status).toBe(401);
    expect((await api('POST', '/api/consoles', { kind: 'bash', cwd: tempDir() })).status).toBe(400);
    expect((await api('POST', '/api/consoles', { kind: 'shell', cwd: 'relative' })).status).toBe(400);
  });

  it('team keys and handoffs never type into a plain shell, and validate their input', async () => {
    // Arrange
    const a = (await api('POST', '/api/consoles', { kind: 'shell', cwd: tempDir('keys-a-') })).json.console.id as string;
    const b = (await api('POST', '/api/consoles', { kind: 'shell', cwd: tempDir('keys-b-') })).json.console.id as string;

    // Act / Assert: unknown actions are refused; a shell gets no Esc/"continue"
    expect((await api('POST', `/api/consoles/${a}/keys`, { action: 'rm -rf /' })).status).toBe(400);
    expect((await api('POST', `/api/consoles/${a}/keys`, { action: 'pause' })).json).toEqual({ ok: true, sent: false });
    expect((await api('POST', '/api/consoles/nope/keys', { action: 'pause' })).status).toBe(400);

    // A handoff needs a task and an agent console as the target (a shell would run the brief)
    expect((await api('POST', `/api/consoles/${a}/handoff`, { to: b, task: '' })).status).toBe(400);
    const toShell = await api('POST', `/api/consoles/${a}/handoff`, { to: b, task: 'Review the diff' });
    expect(toShell.status).toBe(400);
    expect(String(toShell.json.error)).toMatch(/shell/);
    expect((await api('POST', `/api/consoles/${a}/handoff`, { to: a, task: 'x' })).status).toBe(400);

    for (const id of [a, b]) await api('POST', `/api/consoles/${id}/dismiss`, { confirm: true });
  });

  it('runs a real terminal: keystrokes in, output and replay back, then end and dismiss', async () => {
    const opened = await api('POST', '/api/consoles', { kind: 'shell', cwd: tempDir('console-cwd-') });
    expect(opened.status).toBe(200);
    const id = opened.json.console.id as string;
    expect(opened.json.console).toMatchObject({ kind: 'shell', state: 'running' });

    const { ws, messages } = await connect(id);
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    ws.send(JSON.stringify({ type: 'input', data: MATH_COMMAND }));
    await until(() => printed(messages).includes(MATH_OUTPUT));

    const { ws: late, messages: lateMessages } = await connect(id);
    await until(() => lateMessages.find((message) => message.type === 'replay' && message.data.includes(MATH_OUTPUT)));
    late.close();

    expect((await api('POST', `/api/consoles/${id}/kill`, {})).status).toBe(400);
    expect((await api('POST', `/api/consoles/${id}/kill`, { confirm: true })).status).toBe(200);
    await until(() => messages.some((message) => message.type === 'exit'));
    expect((await api('GET', '/api/consoles')).json.consoles).toEqual([expect.objectContaining({ id, state: 'exited' })]);

    expect((await api('POST', `/api/consoles/${id}/dismiss`, {})).status).toBe(200);
    expect((await api('GET', '/api/consoles')).json.consoles).toEqual([]);
    ws.close();
  }, TIMEOUT_MS * 2);

  it('refuses a console socket without the token or for an unknown console', async () => {
    const opened = await api('POST', '/api/consoles', { kind: 'shell', cwd: tempDir('console-cwd-') });
    const id = opened.json.console.id as string;
    await expect(connect(id, 'wrong-token')).rejects.toThrow();
    const missing = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/pty/00000000-0000-0000-0000-000000000000`, ['agent-tower', TOKEN]);
      ws.on('close', (code) => resolve(code));
    });
    expect(missing).toBe(4404);
    await api('POST', `/api/consoles/${id}/dismiss`, { confirm: true });
  }, TIMEOUT_MS);

  it.each([
    ['a foreign Origin (cross-site page)', { Origin: 'http://evil.example' }],
    ['a foreign Host (DNS rebinding)', { Host: `evil.example:${PORT}` }],
  ])('refuses a console socket with %s even with the right token', async (_label, headers) => {
    const opened = await api('POST', '/api/consoles', { kind: 'shell', cwd: tempDir('console-cwd-') });
    const id = opened.json.console.id as string;
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/pty/${id}`, ['agent-tower', TOKEN], { headers });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => reject(new Error('the socket was accepted')));
      ws.on('error', () => undefined);
    });
    expect(status).toBe(403);
    await api('POST', `/api/consoles/${id}/dismiss`, { confirm: true });
  }, TIMEOUT_MS);

  it('refuses a network-share folder', async () => {
    const refused = await api('POST', '/api/consoles', { kind: 'shell', cwd: '\\\\fileserver\\share' });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/Network folders/);
  });
});

describe('saved consoles through the API', () => {
  const SAVED_PORT = 47_410;
  const saved = (id: string, name: string) => ({ id, name, kind: 'shell', cwd: tempDir('saved-cwd-'), createdAt: 1 });
  const file = join(tempDir('saved-file-'), 'consoles.json');
  let savedTower: Tower;
  let savedServer: Server;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${SAVED_PORT}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-tower-token': TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };

  beforeAll(async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify({ consoles: [saved('s-1', 'One'), saved('s-2', 'Two')] }));
    const { Tower } = await import('../daemon/tower.ts');
    const { startServer } = await import('../daemon/api/server.ts');
    savedTower = new Tower(':memory:', { consolesFile: file });
    savedServer = await startServer({ tower: savedTower, port: SAVED_PORT, host: '127.0.0.1', token: TOKEN });
  });

  afterAll(async () => {
    savedServer?.close();
    // The second test already shut it down; a second close would throw.
    await savedTower?.shutdown().catch(() => undefined);
  });

  it('lists saved consoles without launching them, then restores and discards', async () => {
    const listed = await call('GET', '/api/consoles/saved');
    expect(listed.json.saved.map((s: { id: string }) => s.id)).toEqual(['s-1', 's-2']);
    expect((await call('GET', '/api/consoles')).json.consoles).toEqual([]);

    const restored = await call('POST', '/api/consoles/saved/s-1/restore', {});
    expect(restored.status).toBe(200);
    expect(restored.json.console).toMatchObject({ id: 's-1', kind: 'shell', state: 'running' });
    expect((await call('GET', '/api/consoles/saved')).json.saved.map((s: { id: string }) => s.id)).toEqual(['s-2']);

    expect((await call('POST', '/api/consoles/saved/s-2/discard', {})).status).toBe(400);
    expect((await call('POST', '/api/consoles/saved/s-2/discard', { confirm: true })).status).toBe(200);
    expect((await call('POST', '/api/consoles/saved/s-2/discard', { confirm: true })).status).toBe(400);
    expect((await call('POST', '/api/consoles/saved/nope/restore', {})).status).toBe(400);
  }, TIMEOUT_MS);

  it('keeps the specs on disk across a graceful shutdown', async () => {
    const { readFileSync } = await import('node:fs');
    await savedTower.shutdown();
    expect(JSON.parse(readFileSync(file, 'utf8')).consoles.map((s: { id: string }) => s.id)).toEqual(['s-1']);
  }, TIMEOUT_MS);
});

describe('opening an agent as a console (internal launcher path)', () => {
  const AGENT_PORT = 47_450;
  let agentTower: Tower;
  let agentServer: Server;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${AGENT_PORT}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-tower-token': TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const project = tempDir('agent-console-project-');
  const observed = {
    id: 'claude:session-under-test', vendor: 'claude', tier: 'B', name: 'Observed helper', sessionId: 'session-under-test',
    cwd: project, project: 'demo', status: 'idle', source: 'test', hooked: false, intercepting: false, canInstruct: false,
  } as const;
  // Stands in for the real launcher: prints its pid (so the test can place an "agent" under the console) and stays open.
  const FAKE_LAUNCHER = "console.log('LAUNCHED pid=' + process.pid + ' ticket=' + process.argv[1]); setTimeout(() => {}, 30000);";
  const seenTickets: string[] = [];
  let previousExe: string | undefined;

  beforeAll(async () => {
    previousExe = process.env.AGENT_TOWER_CLAUDE_EXE;
    process.env.AGENT_TOWER_CLAUDE_EXE = process.execPath;
    const { Tower } = await import('../daemon/tower.ts');
    const { startServer } = await import('../daemon/api/server.ts');
    agentTower = new Tower(':memory:', {
      launcherCommand: (ticketId) => {
        seenTickets.push(ticketId);
        return { file: process.execPath, args: ['-e', FAKE_LAUNCHER, ticketId], cwd: project };
      },
    });
    agentServer = await startServer({ tower: agentTower, port: AGENT_PORT, host: '127.0.0.1', token: TOKEN });
  });

  afterAll(async () => {
    if (previousExe === undefined) delete process.env.AGENT_TOWER_CLAUDE_EXE;
    else process.env.AGENT_TOWER_CLAUDE_EXE = previousExe;
    agentServer?.close();
    await agentTower?.shutdown();
  });

  it('refuses an unknown agent and requires the token', async () => {
    expect((await call('POST', '/api/agents/nope/console', {})).status).toBe(400);
    const res = await fetch(`http://127.0.0.1:${AGENT_PORT}/api/agents/nope/console`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('opens an observed session as a console, links the agent by process tree, and ends cleanly', async () => {
    agentTower.registry.upsert('test', observed);
    const opened = await call('POST', `/api/agents/${observed.id}/console`, {});
    expect(opened.status).toBe(200);
    expect(opened.json).toMatchObject({ ok: true, consoleId: expect.any(String) });
    const consoleId = opened.json.consoleId as string;
    expect(seenTickets[0]).toMatch(/^[0-9a-f]{32}$/);

    const messages: ConsoleServerMessage[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${AGENT_PORT}/pty/${consoleId}`, ['agent-tower', TOKEN]);
    ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ConsoleServerMessage));
    const printedText = await until(() => (printed(messages).match(/LAUNCHED pid=(\d+) ticket=([0-9a-f]{32})/) ?? undefined));
    expect(printedText[2]).toBe(seenTickets[0]);
    expect((await call('GET', '/api/consoles')).json.consoles).toEqual([expect.objectContaining({ id: consoleId, kind: 'claude', state: 'running' })]);

    // Place the "agent" at the fake launcher's pid: the daemon finds its console from the process table.
    agentTower.registry.upsert('test', { ...observed, pid: Number(printedText[1]) });
    await until(() => agentTower.consoles.get(consoleId)?.agentId === observed.id || undefined, TIMEOUT_MS);

    expect((await call('POST', `/api/consoles/${consoleId}/kill`, { confirm: true })).status).toBe(200);
    await until(() => agentTower.consoles.get(consoleId)?.state === 'exited' || undefined);
    // The ticket is gone once the console ends (it was never usable from disk again).
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(process.env.AGENT_TOWER_HOME!, 'cli-tickets', `${seenTickets[0]}.json`))).toBe(false);
    ws.close();
  }, TIMEOUT_MS * 2);
});
