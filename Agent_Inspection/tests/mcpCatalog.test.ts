import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LibraryDeps } from '../daemon/library/deps.ts';
import { McpCatalog } from '../daemon/library/mcpCatalog.ts';
import { normalizeStdioCommand, type CommandHost } from '../daemon/library/mcpCommand.ts';
import { MCP_PRESETS } from '../daemon/library/mcpPresets.ts';
import { probeRemote, probeStdio, redact } from '../daemon/library/mcpProbe.ts';
import { SecretStore } from '../daemon/library/secretStore.ts';
import { LibraryInputError } from '../daemon/library/types.ts';
import type { ManagedLaunch } from '../daemon/managed/types.ts';
import { TowerStore } from '../daemon/store/db.ts';
import { tempDir } from './helpers.ts';

const POSIX: CommandHost = { platform: 'linux', pathEnv: '/usr/bin', exists: () => true };
const launch = (vendor: 'claude' | 'codex' = 'claude'): ManagedLaunch => ({ vendor, cwd: 'C:\\work', prompt: 'go', agentId: 'managed:1' });

function setup(host: CommandHost = POSIX) {
  const audits: Array<{ action: string; detail: unknown }> = [];
  const deps: LibraryDeps = {
    store: new TowerStore(':memory:'),
    secrets: new SecretStore(':memory:'),
    paths: { skillsLibraryDir: '', docsDir: '', loadoutsDir: '', claudeHome: '' },
    audit: (action, _target, detail) => audits.push({ action, detail }),
  };
  return { deps, audits, catalog: new McpCatalog(deps, { commandHost: () => host, timeoutMs: 10_000 }) };
}

describe('McpCatalog validation', () => {
  it('rejects bad names, reserved names, duplicates and missing fields', () => {
    const { catalog } = setup();
    catalog.create({ name: 'playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] });
    const bad = [
      { name: 'Bad Name', transport: 'stdio', command: 'x' },
      { name: 'team', transport: 'stdio', command: 'x' },
      { name: 'notify', transport: 'stdio', command: 'x' },
      { name: 'playwright', transport: 'stdio', command: 'x' },
      { name: 'ok', transport: 'stdio' },
      { name: 'ok', transport: 'ftp', command: 'x' },
      { name: 'ok', transport: 'http', url: 'file:///etc/passwd' },
      { name: 'ok', transport: 'http' },
      { name: 'ok', transport: 'stdio', command: 'x', args: Array.from({ length: 51 }, () => 'a') },
      { name: 'ok', transport: 'stdio', command: 'x', args: ['a'.repeat(1001)] },
      { name: 'ok', transport: 'stdio', command: 'x', env: { 'BAD-KEY': 'v' } },
      { name: 'ok', transport: 'stdio', command: 'x', secrets: { 'not valid': 'v' } },
      { name: 'ok', transport: 'http', url: 'https://x.test', secrets: { 'Bad Header': 'v' } },
      { name: 'ok', transport: 'stdio', command: 'x', env: { TOKEN: 'a' }, secrets: { TOKEN: 'b' } },
    ];
    for (const input of bad) expect(() => catalog.create(input), JSON.stringify(input)).toThrow(LibraryInputError);
  });

  it('keeps secret values out of every view and audit entry', () => {
    const { catalog, audits } = setup();
    const created = catalog.create({ name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', secrets: { Authorization: 'ghp_supersecret' } });
    expect(created.secretNames).toEqual(['Authorization']);
    expect(JSON.stringify(catalog.list())).not.toContain('supersecret');
    expect(JSON.stringify(audits)).not.toContain('supersecret');
  });

  it('updates keep omitted secrets, delete "" secrets and allow keeping the same name', () => {
    const { catalog, deps } = setup();
    const s = catalog.create({ name: 'tool', transport: 'stdio', command: 'node', secrets: { A_KEY: 'one', B_KEY: 'two' } });
    const updated = catalog.update(s.id, { name: 'tool', transport: 'stdio', command: 'node', args: ['srv.js'], secrets: { B_KEY: '' } });
    expect(updated.secretNames).toEqual(['A_KEY']);
    expect(updated.args).toEqual(['srv.js']);
    expect(deps.secrets.get(`mcp:${s.id}:A_KEY`)).toBe('one');
  });

  it('removing a server deletes its secrets; setDefault flips defaultOn', () => {
    const { catalog, deps } = setup();
    const s = catalog.create({ name: 'tool', transport: 'stdio', command: 'node', secrets: { A_KEY: 'one' } });
    expect(catalog.setDefault(s.id, true).defaultOn).toBe(true);
    catalog.remove(s.id);
    expect(catalog.list()).toEqual([]);
    expect(deps.secrets.namesUnder(`mcp:${s.id}:`)).toEqual([]);
    expect(() => catalog.remove(s.id)).toThrow(LibraryInputError);
  });

  it('turns a bare Authorization token into a Bearer header', () => {
    const { catalog, deps } = setup();
    const s = catalog.create({ name: 'gh', transport: 'http', url: 'https://x.test/mcp', secrets: { Authorization: 'ghp_abc' } });
    expect(deps.secrets.get(`mcp:${s.id}:Authorization`)).toBe('Bearer ghp_abc');
  });

  it('ships presets that validate', () => {
    const { catalog } = setup();
    for (const preset of MCP_PRESETS) expect(() => catalog.create(preset.input)).not.toThrow();
    expect(catalog.list()).toHaveLength(MCP_PRESETS.length);
  });
});

describe('McpCatalog.contribute', () => {
  it('maps stdio servers with secrets forwarded by name and remote servers with headers', () => {
    const { catalog } = setup();
    const stdio = catalog.create({ name: 'ctx', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { MODE: 'x' }, secrets: { CTX_KEY: 'k1' } });
    const remote = catalog.create({ name: 'gh', transport: 'http', url: 'https://x.test/mcp', secrets: { Authorization: 'Bearer t' } });
    const part = catalog.contribute({ mcpIds: [stdio.id, remote.id] }, launch());
    expect(part.mcpServers).toEqual({ ctx: { command: 'npx', args: ['-y', 'pkg'], env: { MODE: 'x' }, inheritEnv: ['CTX_KEY'] } });
    expect(part.env).toEqual({ CTX_KEY: 'k1' });
    expect(part.remoteMcpServers).toEqual({ gh: { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer t' } } });
  });

  it('ignores other loadout fields and refuses unknown ids', () => {
    const { catalog } = setup();
    expect(catalog.contribute({ skillIds: ['x'] }, launch())).toEqual({});
    expect(() => catalog.contribute({ mcpIds: ['nope'] }, launch())).toThrow(LibraryInputError);
  });

  it('leaves SSE servers out for Codex with a note', () => {
    const { catalog } = setup();
    const sse = catalog.create({ name: 'old', transport: 'sse', url: 'https://x.test/sse' });
    const part = catalog.contribute({ mcpIds: [sse.id] }, launch('codex'));
    expect(part.remoteMcpServers).toBeUndefined();
    expect(part.notes?.[0]).toMatch(/SSE/);
  });

  it('refuses two servers wanting different values for one secret name', () => {
    const { catalog } = setup();
    const a = catalog.create({ name: 'a', transport: 'stdio', command: 'x', secrets: { TOKEN: '1' } });
    const b = catalog.create({ name: 'b', transport: 'stdio', command: 'x', secrets: { TOKEN: '2' } });
    expect(() => catalog.contribute({ mcpIds: [a.id, b.id] }, launch())).toThrow(/TOKEN/);
  });

  it('wraps .cmd shims in cmd /c on Windows', () => {
    const host: CommandHost = { platform: 'win32', pathEnv: 'C:\\node', exists: (p) => p === join('C:\\node', 'npx.cmd') };
    const { catalog } = setup(host);
    const s = catalog.create({ name: 'pw', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] });
    expect(catalog.contribute({ mcpIds: [s.id] }, launch()).mcpServers?.pw).toMatchObject({ command: 'cmd', args: ['/c', 'npx', '-y', '@playwright/mcp@latest'] });
  });
});

describe('normalizeStdioCommand', () => {
  const win = (files: string[]): CommandHost => ({ platform: 'win32', pathEnv: 'C:\\a;C:\\b', exists: (p) => files.includes(p) });

  it('wraps only bare names that resolve to .cmd or .bat', () => {
    expect(normalizeStdioCommand('npx', ['-y'], win([join('C:\\b', 'npx.cmd')]))).toEqual({ command: 'cmd', args: ['/c', 'npx', '-y'] });
    expect(normalizeStdioCommand('node', ['x'], win([join('C:\\a', 'node.exe'), join('C:\\b', 'node.cmd')]))).toEqual({ command: 'node', args: ['x'] });
    expect(normalizeStdioCommand('npx.cmd', [], win([]))).toEqual({ command: 'npx.cmd', args: [] });
    expect(normalizeStdioCommand('C:\\tools\\npx', [], win([]))).toEqual({ command: 'C:\\tools\\npx', args: [] });
    expect(normalizeStdioCommand('npx', ['-y'], { ...win([]), platform: 'linux' })).toEqual({ command: 'npx', args: ['-y'] });
  });

  it('refuses cmd.exe metacharacters in wrapped arguments', () => {
    expect(() => normalizeStdioCommand('npx', ['a&calc'], win([join('C:\\a', 'npx.cmd')]))).toThrow(LibraryInputError);
  });
});

const STUB = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stub' } } }) + '\\n');
  if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo' }, { name: process.env.STUB_TOOL || 'none' }] } }) + '\\n');
});
`;

describe('mcp probe', () => {
  it('lists the tools of a stdio server and passes its secrets in the environment', async () => {
    const dir = tempDir();
    const script = join(dir, 'stub.cjs');
    writeFileSync(script, STUB);
    const result = await probeStdio({ command: process.execPath, args: [script], env: { ...process.env, STUB_TOOL: 'secret_tool' } }, 10_000);
    expect(result).toEqual({ ok: true, tools: ['echo', 'secret_tool'] });
  });

  it('reports a server that exits, without leaking secrets', async () => {
    const result = await probeStdio(
      { command: process.execPath, args: ['-e', 'console.error("token=hunter2-secret"); process.exit(3)'], env: process.env },
      10_000, ['hunter2-secret'],
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited/);
    expect(result.error).not.toContain('hunter2-secret');
  });

  it('reports a command that cannot start', async () => {
    const result = await probeStdio({ command: 'definitely-not-a-command-xyz', args: [], env: process.env }, 10_000);
    expect(result.ok).toBe(false);
  });

  it('reports an unreachable remote server', async () => {
    const result = await probeRemote({ type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer abcdef' } }, 5000);
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('abcdef');
  });

  it('redacts secrets and trims long messages', () => {
    expect(redact('bad token abc123 here', ['abc123'])).toBe('bad token ••• here');
    expect(redact('x'.repeat(1000), []).length).toBeLessThanOrEqual(300);
  });
});

describe('mcp probe over streamable HTTP', () => {
  const serve = (sse: boolean) => new Promise<{ url: string; close: () => void; seen: string[] }>((resolve) => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        seen.push(`${req.method} ${String(req.headers.authorization)} ${String(req.headers['mcp-session-id'])}`);
        if (req.method !== 'POST') { res.writeHead(200).end(); return; }
        const m = JSON.parse(body) as { id?: number; method: string };
        if (m.id === undefined) { res.writeHead(202).end(); return; }
        const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} } : { tools: [{ name: 'search_code' }] };
        const reply = JSON.stringify({ jsonrpc: '2.0', id: m.id, result });
        if (sse) res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' }).end(`event: message\ndata: ${reply}\n\n`);
        else res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }).end(reply);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => server.close(), seen });
    });
  });

  it.each([false, true])('lists tools (SSE replies: %s) and sends the session id and headers', async (sse) => {
    const srv = await serve(sse);
    try {
      const result = await probeRemote({ type: 'http', url: srv.url, headers: { Authorization: 'Bearer t0k' } }, 5000);
      expect(result).toEqual({ ok: true, tools: ['search_code'] });
      expect(srv.seen[0]).toBe('POST Bearer t0k undefined');
      expect(srv.seen[2]).toBe('POST Bearer t0k s1');
    } finally {
      srv.close();
    }
  });
});
