import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { tempDir } from './helpers.ts';

const PORT = 47_340;
const REMOTE_PORT = 47_341;
const TOKEN = 'remote-local-token-0123456789';
const HOSTNAME = 'station.tail0000.ts.net';
const towerHome = join(tempDir('tower-'), 'agent-tower');
mkdirSync(towerHome, { recursive: true });
process.env.AGENT_TOWER_HOME = towerHome;
process.env.CLAUDE_HOME = tempDir('claude-home-');

type Tower = import('../daemon/tower.ts').Tower;
let tower: Tower;
let server: Server;
const webDist = tempDir('web-dist-');
writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>Waystation</title>');

interface Reply { status: number; json: Record<string, any>; headers: Record<string, string | string[] | undefined>; text: string }

/** node:http, so the Host header can be set (fetch forbids it). */
function call(port: number, method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({ host: '127.0.0.1', port, method, path, headers: {
      ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
      ...options.headers,
    } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, any> = {};
        try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers, text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const local = (method: string, path: string, body?: unknown) => call(PORT, method, path, { body, headers: { 'x-tower-token': TOKEN } });
const remoteHeaders = (cookie?: string) => ({ host: HOSTNAME, origin: `https://${HOSTNAME}`, ...(cookie ? { cookie } : {}) });
const remote = (method: string, path: string, cookie?: string, body?: unknown) => call(REMOTE_PORT, method, path, { body, headers: remoteHeaders(cookie) });

async function pair(role: string, name: string): Promise<string> {
  const offer = await local('POST', '/api/remote/pair', { role });
  const paired = await remote('POST', '/remote/pair', undefined, { code: offer.json.pairing.code, name });
  expect(paired.status).toBe(200);
  const cookie = String(paired.headers['set-cookie']).split(';')[0];
  // Paired over HTTPS: a __Host- cookie, never sent to other services on the same Tailscale name.
  expect(cookie).toMatch(/^__Host-waystation_device=/);
  // Paired from an https:// page (Tailscale Serve): the cookie is HTTPS-only.
  expect(String(paired.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict; Max-Age=\d+; Secure/);
  return cookie;
}

function openSocket(path: string, cookie: string): Promise<{ ws: WebSocket; first: Promise<string> } | { error: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${REMOTE_PORT}${path}`, ['agent-tower'], { headers: { host: HOSTNAME, cookie }, origin: `https://${HOSTNAME}` });
    const first = new Promise<string>((done) => ws.once('message', (data) => done(String(data))));
    ws.once('open', () => resolve({ ws, first }));
    ws.once('unexpected-response', (_req, res) => resolve({ error: String(res.statusCode) }));
    ws.once('error', (error) => resolve({ error: error.message }));
  });
}

beforeAll(async () => {
  const { Tower } = await import('../daemon/tower.ts');
  const { startServer } = await import('../daemon/api/server.ts');
  tower = new Tower(':memory:');
  server = await startServer({ tower, port: PORT, host: '127.0.0.1', token: TOKEN, webDist });
});

afterAll(async () => {
  server?.close();
  await tower?.shutdown();
});

describe('remote access gateway', () => {
  it('is off by default, validates settings, and starts when enabled', async () => {
    expect((await local('GET', '/api/remote')).json.remote).toMatchObject({ running: false, config: { enabled: false } });
    expect((await local('POST', '/api/remote/config', { enabled: true, port: PORT })).status).toBe(400);
    expect((await local('POST', '/api/remote/config', { enabled: true, port: REMOTE_PORT, hostnames: ['https://x'] })).status).toBe(400);
    const on = await local('POST', '/api/remote/config', { enabled: true, port: REMOTE_PORT, hostnames: [HOSTNAME.toUpperCase()] });
    expect(on.json.remote).toMatchObject({ running: true, config: { hostnames: [HOSTNAME] } });
  });

  it('refuses unknown hosts and foreign origins, and unpaired devices', async () => {
    expect((await call(REMOTE_PORT, 'GET', '/api/state', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await call(REMOTE_PORT, 'POST', '/remote/pair', { body: {}, headers: { host: HOSTNAME, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await remote('GET', '/api/state')).status).toBe(401);
    expect((await remote('GET', '/remote/session')).json).toEqual({ paired: false });
    // The UI shell is public, with a CSP that lets the page talk to its own origin.
    const page = await remote('GET', '/');
    expect(page.status).toBe(200);
    expect(String(page.headers['content-security-policy'])).toContain("connect-src 'self'");
    expect(String(page.headers['content-security-policy'])).not.toContain('ws://127.0.0.1');
  });

  it('pairs only with the code shown on the desktop', async () => {
    expect((await remote('POST', '/remote/pair', undefined, { code: 'AAAAAAAA', name: 'Guess' })).status).toBe(400);
    const cookie = await pair('triage', 'Phone');
    expect((await remote('GET', '/remote/session', cookie)).json).toEqual({ paired: true, device: { name: 'Phone', role: 'triage' } });
    expect((await local('GET', '/api/remote')).json.remote.devices).toEqual([expect.objectContaining({ name: 'Phone', role: 'triage' })]);
  });

  it('lets a Triage device read and steer, but not launch, read files or manage remote access', async () => {
    const cookie = await pair('triage', 'Tablet');
    expect((await remote('GET', '/api/state', cookie)).json).toHaveProperty('agents');
    // Allowed and forwarded with the local token: the tower itself answers (no such agent).
    const stop = await remote('POST', '/api/agents/missing/stop', cookie, {});
    expect(stop.status).toBe(400);
    expect(stop.json.error).not.toMatch(/token/i);
    expect((await remote('POST', '/api/managed', cookie, { vendor: 'claude' })).status).toBe(403);
    expect((await remote('GET', '/api/files/read?path=C:\\\\Windows\\\\win.ini', cookie)).status).toBe(403);
    expect((await remote('GET', '/api/remote', cookie)).status).toBe(403);
    expect((await remote('POST', '/api/remote/pair', cookie, { role: 'full' })).status).toBe(403);
    expect((await remote('POST', '/hook/pretooluse', cookie, {})).status).toBe(403);
    // A POST must come from our own origin.
    expect((await call(REMOTE_PORT, 'POST', '/api/agents/missing/stop', { body: {}, headers: { host: HOSTNAME, cookie } })).status).toBe(403);
  });

  it('streams the live feed, refuses terminals below Full, and cuts a revoked device off', async () => {
    const cookie = await pair('view', 'Laptop');
    expect((await remote('POST', '/api/agents/missing/stop', cookie, {})).status).toBe(403);
    // File contents (diffs) need Triage.
    expect((await remote('GET', '/api/agents/missing/outputs/diff', cookie)).status).toBe(403);
    const feed = await openSocket('/ws', cookie);
    expect('ws' in feed).toBe(true);
    if (!('ws' in feed)) return;
    expect(JSON.parse(await feed.first)).toMatchObject({ type: 'snapshot' });
    expect(await openSocket('/pty/abc', cookie)).toEqual({ error: '403' });
    // A remote socket is receive-only: it cannot register as the desktop or VS Code bridge.
    const replies: string[] = [];
    feed.ws.on('message', (data) => replies.push(String(data)));
    feed.ws.send(JSON.stringify({ type: 'terminal:register', version: 1 }));
    feed.ws.send(JSON.stringify({ type: 'desktop:register' }));
    await new Promise((done) => setTimeout(done, 300));
    expect(replies.some((reply) => reply.includes('terminal:config'))).toBe(false);
    const closed = new Promise<void>((done) => feed.ws.once('close', () => done()));
    const device = (await local('GET', '/api/remote')).json.remote.devices.find((entry: { name: string }) => entry.name === 'Laptop');
    expect((await local('POST', `/api/remote/devices/${device.id}/revoke`)).status).toBe(200);
    await closed;
    expect((await remote('GET', '/api/state', cookie)).status).toBe(401);
  });

  it('caps live sockets per device', async () => {
    const cookie = await pair('view', 'Busy');
    const open = await Promise.all(Array.from({ length: 8 }, () => openSocket('/ws', cookie)));
    expect(open.every((entry) => 'ws' in entry)).toBe(true);
    expect(await openSocket('/ws', cookie)).toEqual({ error: '429' });
    for (const entry of open) if ('ws' in entry) entry.ws.close();
  });

  it('applies a role change at once, and lets a device forget itself', async () => {
    const cookie = await pair('view', 'Desk');
    const device = (await local('GET', '/api/remote')).json.remote.devices.find((entry: { name: string }) => entry.name === 'Desk');
    expect((await local('POST', `/api/remote/devices/${device.id}/role`, { role: 'full' })).json.device.role).toBe('full');
    expect((await remote('POST', '/api/managed', cookie, {})).status).toBe(400); // allowed through; the tower rejects the empty launch
    const forgot = await remote('POST', '/remote/forget', cookie, {});
    expect(String(forgot.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await remote('GET', '/api/state', cookie)).status).toBe(401);
  });

  it('stops the gateway when remote access is switched off', async () => {
    expect((await local('POST', '/api/remote/config', { enabled: false, port: REMOTE_PORT, hostnames: [HOSTNAME] })).json.remote.running).toBe(false);
    await expect(remote('GET', '/remote/session')).rejects.toThrow();
  });
});
