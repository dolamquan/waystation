import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { tempDir } from './helpers.ts';

const PORT = 47_317;
const TOKEN = 'test-token-0123456789';
const SESSION = '0862ffad-c0dd-4138-96b5-778c574d5945';
const towerHome = join(tempDir('tower-'), 'agent-tower');
mkdirSync(towerHome, { recursive: true });
const claudeHome = tempDir('claude-home-');
process.env.AGENT_TOWER_HOME = towerHome;
process.env.CLAUDE_HOME = claudeHome;

const HOOK = join(__dirname, '..', 'daemon', 'hooks', 'claude-hook.mjs');

type Tower = import('../daemon/tower.ts').Tower;
let tower: Tower;
let server: Server;

function runHook(payload: object, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, AGENT_TOWER_HOME: towerHome, ...env } });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-tower-token': TOKEN, ...(init.headers ?? {}) } });

beforeAll(async () => {
  const { Tower } = await import('../daemon/tower.ts');
  const { startServer } = await import('../daemon/api/server.ts');
  tower = new Tower(':memory:');
  server = await startServer({ tower, port: PORT, host: '127.0.0.1', token: TOKEN });
  writeFileSync(join(towerHome, 'daemon.json'), JSON.stringify({ port: PORT, token: TOKEN }));
});

afterAll(async () => {
  server?.close();
  tower?.store.close();
});

const preToolUse = {
  hook_event_name: 'PreToolUse',
  session_id: SESSION,
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf build' },
};

describe('hook bridge (real hook script <-> real server)', () => {
  it('passes straight through when intercept is off', async () => {
    const result = await runHook(preToolUse);
    expect(result).toEqual({ code: 0, stdout: '' });
    const events = tower.events(`claude:${SESSION}`);
    expect(events.some((e) => e.summary === 'Bash: rm -rf build')).toBe(true);
  });

  it('holds the tool call until approved with edited input', async () => {
    tower.flags.setIntercepting(SESSION, true);
    const hook = runHook(preToolUse);
    const pending = await waitFor(() => tower.interceptions.list()[0]);
    expect(pending).toMatchObject({ toolName: 'Bash', sessionId: SESSION, origin: 'hook' });
    const response = await api(`/api/interceptions/${pending.id}`, {
      method: 'POST',
      body: JSON.stringify({ behavior: 'allow', updatedInput: { command: 'rm -rf build/tmp' } }),
    });
    expect(response.status).toBe(200);
    const result = await hook;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({
      permissionDecision: 'allow',
      updatedInput: { command: 'rm -rf build/tmp' },
    });
  });

  it('denies with an instruction', async () => {
    const hook = runHook(preToolUse);
    const pending = await waitFor(() => tower.interceptions.list()[0]);
    await api(`/api/interceptions/${pending.id}`, { method: 'POST', body: JSON.stringify({ behavior: 'deny', message: 'clean only dist/' }) });
    const out = JSON.parse((await hook).stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toContain('clean only dist/');
  });

  it('falls back to "ask" (not allow) when nobody decides in time', async () => {
    const result = await runHook(preToolUse, { AGENT_TOWER_HOOK_TIMEOUT_MS: '600' });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
    await waitFor(() => (tower.interceptions.list().length === 0 ? true : undefined));
    tower.flags.setIntercepting(SESSION, false);
  });

  it('never blocks a non-intercepted session when the daemon is down', async () => {
    const isolated = tempDir('tower-down-');
    writeFileSync(join(isolated, 'daemon.json'), JSON.stringify({ port: 1, token: 'x' }));
    expect(await runHook(preToolUse, { AGENT_TOWER_HOME: isolated })).toEqual({ code: 0, stdout: '' });
  });

  it('falls back to "ask" for an intercepted session when the daemon is down, gone, or rejects the token', async () => {
    const { SessionFlags } = await import('../daemon/hooks/sessionFlags.ts');
    const down = tempDir('tower-down-');
    writeFileSync(join(down, 'daemon.json'), JSON.stringify({ port: 1, token: 'x' }));
    new SessionFlags(down).setIntercepting(SESSION, true);
    const unreachable = await runHook(preToolUse, { AGENT_TOWER_HOME: down });
    expect(JSON.parse(unreachable.stdout).hookSpecificOutput.permissionDecision).toBe('ask');

    const noInfo = tempDir('tower-none-');
    new SessionFlags(noInfo).setIntercepting(SESSION, true);
    const missing = await runHook(preToolUse, { AGENT_TOWER_HOME: noInfo });
    expect(JSON.parse(missing.stdout).hookSpecificOutput.permissionDecision).toBe('ask');

    const stale = tempDir('tower-stale-');
    writeFileSync(join(stale, 'daemon.json'), JSON.stringify({ port: PORT, token: 'stale-token' }));
    new SessionFlags(stale).setIntercepting(SESSION, true);
    const rejected = await runHook(preToolUse, { AGENT_TOWER_HOME: stale });
    expect(JSON.parse(rejected.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('forgets intercept flags and queued instructions when the session ends', async () => {
    tower.flags.setIntercepting(SESSION, true);
    tower.flags.queueInstruction(SESSION, 'never delivered');
    await runHook({ hook_event_name: 'SessionEnd', session_id: SESSION, reason: 'exit' });
    expect(tower.flags.isIntercepting(SESSION)).toBe(false);
    expect(tower.flags.queuedInstructions(SESSION)).toEqual([]);
  });

  it('delivers queued instructions on Stop exactly once', async () => {
    tower.flags.queueInstruction(SESSION, 'also update the changelog');
    const first = await runHook({ hook_event_name: 'Stop', session_id: SESSION, stop_hook_active: false });
    expect(JSON.parse(first.stdout)).toEqual({ decision: 'block', reason: expect.stringContaining('also update the changelog') });
    const second = await runHook({ hook_event_name: 'Stop', session_id: SESSION, stop_hook_active: true });
    expect(second.stdout).toBe('');
    await waitFor(() => tower.events(`claude:${SESSION}`).find((e) => e.summary.startsWith('Delivered instruction')));
  });

  it('injects queued instructions after a tool call', async () => {
    tower.flags.queueInstruction(SESSION, 'prefer small commits');
    const result = await runHook({ hook_event_name: 'PostToolUse', session_id: SESSION, tool_name: 'Bash' });
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('prefer small commits');
  });

  it('ignores sessions launched by the tower itself', async () => {
    tower.flags.setIntercepting(SESSION, true);
    const result = await runHook(preToolUse, { AGENT_TOWER_MANAGED: '1' });
    expect(result).toEqual({ code: 0, stdout: '' });
    tower.flags.setIntercepting(SESSION, false);
  });
});

describe('WebSocket and robustness', () => {
  it('streams a snapshot to clients presenting the token as a subprotocol', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, ['agent-tower', TOKEN]);
    const first = await new Promise<{ type: string }>((resolve, reject) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data))));
      ws.once('error', reject);
    });
    expect(first.type).toBe('snapshot');
    ws.close();
  });

  it('rejects WebSocket clients with a wrong token or a foreign origin', async () => {
    const attempt = (protocols: string[], origin?: string) => new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, protocols, origin ? { origin } : {});
      ws.once('open', () => { ws.close(); resolve('open'); });
      ws.once('error', () => resolve('rejected'));
    });
    expect(await attempt(['agent-tower', 'wrong'])).toBe('rejected');
    expect(await attempt(['agent-tower', TOKEN], 'https://evil.example')).toBe('rejected');
  });

  it('serves the UI with security headers and answers malformed URLs with 400 instead of crashing', async () => {
    const { startServer } = await import('../daemon/api/server.ts');
    const dist = tempDir('dist-');
    writeFileSync(join(dist, 'index.html'), '<html><head></head><body>ui</body></html>');
    const uiPort = PORT + 10;
    const uiServer = await startServer({ tower, port: uiPort, host: '127.0.0.1', token: TOKEN, webDist: dist });
    try {
      const page = await fetch(`http://127.0.0.1:${uiPort}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(page.headers.get('x-frame-options')).toBe('DENY');
      expect(await page.text()).not.toContain(TOKEN);
      expect((await fetch(`http://127.0.0.1:${uiPort}/%E0%A4%A`)).status).toBe(400);
      expect((await fetch(`http://127.0.0.1:${uiPort}/..%2F..%2Fsecret`)).status).toBe(200);
    } finally {
      uiServer.close();
    }
    expect((await api('/api/agents/%E0%A4%A/events')).status).toBe(400);
    expect((await api('/api/state')).status).toBe(200);
  });
});

describe('API guards', () => {
  it('rejects missing tokens, foreign origins and foreign hosts', async () => {
    expect((await fetch(`http://127.0.0.1:${PORT}/api/state`)).status).toBe(401);
    expect((await api('/api/state', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const state = await (await api('/api/state')).json() as { agents: unknown[]; hooks: { installed: boolean } };
    expect(state.hooks.installed).toBe(false);
  });

  it('requires explicit confirmation for destructive actions and validates input', async () => {
    const stop = await api('/api/agents/claude%3Anope/stop', { method: 'POST', body: '{}' });
    expect(stop.status).toBe(400);
    const missing = await api('/api/agents/claude%3Anope/stop', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    expect(((await missing.json()) as { error: string }).error).toMatch(/not found/);
    const badJson = await api('/api/managed', { method: 'POST', body: '{oops' });
    expect(badJson.status).toBe(400);
    const badLaunch = await api('/api/managed', { method: 'POST', body: JSON.stringify({ vendor: 'claude', cwd: 'relative', prompt: 'x' }) });
    expect(((await badLaunch.json()) as { error: string }).error).toMatch(/absolute/);
    const unknownDecision = await api('/api/interceptions/nope', { method: 'POST', body: JSON.stringify({ behavior: 'allow' }) });
    expect(unknownDecision.status).toBe(400);
    expect((await api('/api/nothing')).status).toBe(404);
  });

  it('lets the UI instruct a hooked session only after hooks are installed', async () => {
    tower.registry.upsert('test', {
      id: `claude:${SESSION}`, vendor: 'claude', tier: 'B', name: 'x', sessionId: SESSION, project: 'p', cwd: towerHome,
      status: 'busy', source: 't', hooked: false, intercepting: false, canInstruct: false,
    });
    const before = await api(`/api/agents/claude%3A${SESSION}/instruct`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
    expect(((await before.json()) as { error: string }).error).toMatch(/Install the tower hooks/);
    const install = await api('/api/hooks/install', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    expect(install.status).toBe(200);
    const after = await api(`/api/agents/claude%3A${SESSION}/instruct`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
    expect(((await after.json()) as { message: string }).message).toMatch(/Queued/);
    expect(tower.flags.queuedInstructions(SESSION)).toEqual(['hi']);
    tower.flags.clearInbox(SESSION);
    expect((await api('/api/hooks/uninstall', { method: 'POST' })).status).toBe(200);
    const audit = await (await api('/api/audit')).json() as { entries: Array<{ action: string }> };
    expect(audit.entries.map((e) => e.action)).toEqual(expect.arrayContaining(['hooks_install', 'instruct', 'hooks_uninstall']));
  });
});
