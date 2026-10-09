import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from './helpers.ts';
import { acquireInstance } from '../daemon/runtime/instance.ts';
import { AttentionTracker, externalUrl, isStationUrl, trustedSender } from '../desktop/security.mjs';
import { defaultSettings, daemonEnvironment, readSettings, validatePreferences, writeSettings } from '../desktop/settings.mjs';
import { probeDaemon, supportsNode, verifyNode } from '../desktop/runtime.mjs';

describe('desktop security', () => {
  const origin = 'http://127.0.0.1:4317';
  it('permits only the station origin and shell path', () => {
    expect(isStationUrl(`${origin}/#token=abc`, origin)).toBe(true);
    for (const value of ['file:///C:/secrets.txt', 'javascript:alert(1)', 'https://example.com/', `${origin}/api/state`, 'http://127.0.0.1:9999/', 'http://user@127.0.0.1:4317/']) expect(isStationUrl(value, origin)).toBe(false);
  });
  it('opens only normal external web links', () => {
    expect(externalUrl('https://example.com/help')).toBe('https://example.com/help');
    for (const value of ['file:///C:/secret', 'javascript:alert(1)', 'powershell:cmd', 'https://user:pass@example.com', `${origin}/`, 'http://localhost:4317/', 'http://[::1]:4317/']) expect(externalUrl(value)).toBeUndefined();
  });
  it('requires the current window and its main frame for native actions', () => {
    const frame = { url: `${origin}/` };
    const webContents = { mainFrame: frame };
    const window = { isDestroyed: () => false, webContents };
    expect(trustedSender({ sender: webContents, senderFrame: frame }, window, origin)).toBe(true);
    expect(trustedSender({ sender: webContents, senderFrame: { url: `${origin}/` } }, window, origin)).toBe(false);
    expect(trustedSender({ sender: {}, senderFrame: frame }, window, origin)).toBe(false);
    frame.url = 'https://example.com/';
    expect(trustedSender({ sender: webContents, senderFrame: frame }, window, origin)).toBe(false);
  });
});

describe('attention notifications', () => {
  it('baselines existing attention, deduplicates events, and notices a new guard', () => {
    const tracker = new AttentionTracker();
    const agent = { id: 'a', status: 'waiting' };
    const approval = { id: 'first', agentId: 'a' };
    expect(tracker.update([agent], [approval])).toMatchObject({ raised: false, attention: 1, approvals: 1 });
    expect(tracker.update([agent], [approval]).raised).toBe(false);
    expect(tracker.update([agent], [approval, { id: 'second', agentId: 'a' }]).raised).toBe(true);
    tracker.update([{ ...agent, status: 'idle' }], []);
    expect(tracker.update([{ ...agent, breaker: { level: 'warned', since: 1 } }], []).raised).toBe(true);
    expect(tracker.update([{ ...agent, breaker: { level: 'warned', since: 1 } }], []).raised).toBe(false);
  });
});

describe('desktop preferences and runtime', () => {
  it('round trips settings without putting tokens in the preferences file', () => {
    const home = tempDir('desktop-settings-');
    const settings = { ...defaultSettings(), setupComplete: true, notifications: false, window: { width: 1120, height: 780, maximized: true } };
    writeSettings(home, settings);
    expect(readSettings(home)).toEqual(settings);
    expect(readFileSync(join(home, 'desktop.json'), 'utf8')).not.toContain('token');
    writeFileSync(join(home, 'desktop.json'), '{');
    expect(readSettings(home)).toEqual(defaultSettings());
  });
  it('validates configured paths and rejects relative/missing paths and arbitrary preferences', () => {
    const folder = tempDir('desktop path with spaces-');
    const exe = join(folder, 'claude.exe'); writeFileSync(exe, 'fixture');
    const js = join(folder, 'codex.js'); writeFileSync(js, 'fixture');
    const valid = { ...defaultSettings(), paths: { claudeHome: folder, codexHome: folder, claudeExe: exe, codexJs: js } };
    expect(validatePreferences(valid).paths).toEqual(valid.paths);
    expect(() => validatePreferences({ ...valid, paths: { ...valid.paths, claudeHome: 'relative' } })).toThrow(/absolute/);
    expect(() => validatePreferences({ ...valid, paths: { ...valid.paths, codexHome: exe } })).toThrow(/folder/);
    expect(() => validatePreferences({ ...valid, paths: { ...valid.paths, claudeExe: js } })).toThrow(/exe/);
    expect(() => validatePreferences({ paths: valid.paths })).toThrow(/incomplete/);
  });
  it('overrides only configured paths and removes Electron runtime mode', () => {
    const settings = defaultSettings(); settings.paths.codexHome = 'C:\\custom';
    const env = daemonEnvironment(settings, { PATH: 'original', CODEX_HOME: 'original-home', ELECTRON_RUN_AS_NODE: '1' });
    expect(env.PATH).toBe('original'); expect(env.CODEX_HOME).toBe('C:\\custom'); expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
  it('requires the supported Node version and a real executable', () => {
    expect(supportsNode('v22.20.0')).toBe(true); expect(supportsNode('v24.0.0')).toBe(true);
    for (const version of ['v20.20.0', 'v22.19.9', 'garbage']) expect(supportsNode(version)).toBe(false);
    expect(verifyNode(process.execPath)).toBe(process.version);
    expect(() => verifyNode('node')).toThrow(/npm run desktop/);
  });
  it('does not mistake an unrelated HTTP response for its daemon', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ app: 'unrelated' })); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as import('node:net').AddressInfo).port;
      expect(await probeDaemon({ port, pid: 1, token: 'abc', startedAt: 1, dev: false })).toBe(false);
    } finally { server.close(); }
  });
});

describe('single daemon ownership', () => {
  it('refuses live owners, recovers dead owners, and releases only its own lock', () => {
    const file = join(tempDir('daemon-lock-'), 'daemon.lock');
    const release = acquireInstance(file);
    expect(() => acquireInstance(file)).toThrow(/already running/);
    release();
    writeFileSync(file, JSON.stringify({ pid: 1234, id: 'stale' }));
    const releaseRecovered = acquireInstance(file, () => false);
    writeFileSync(file, JSON.stringify({ pid: 4321, id: 'replacement' }));
    releaseRecovered();
    expect(JSON.parse(readFileSync(file, 'utf8')).id).toBe('replacement');
  });
});
