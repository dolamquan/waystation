import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectPreview } from '../daemon/preview/detect.ts';
import { findLoopbackUrl, PreviewManager, stripAnsi } from '../daemon/preview/manager.ts';
import { resolveSitePath, serveStaticSite } from '../daemon/preview/staticServer.ts';
import type { PreviewView } from '../daemon/preview/types.ts';
import { tempDir } from './helpers.ts';

function project(files: Record<string, string>, dirs: readonly string[] = []): string {
  const dir = tempDir('preview-');
  for (const sub of dirs) mkdirSync(join(dir, sub), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const pkg = (body: object) => JSON.stringify(body);

describe('detectPreview', () => {
  it('runs the dev script with the runner its lockfile names', () => {
    const dir = project({ 'package.json': pkg({ scripts: { dev: 'vite' } }), 'pnpm-lock.yaml': '' }, ['node_modules']);
    expect(detectPreview(dir)).toMatchObject({ kind: 'script', runner: 'pnpm', script: 'dev', command: 'pnpm run dev', needsInstall: false });
  });

  it('installs first when packages are missing', () => {
    const dir = project({ 'package.json': pkg({ scripts: { dev: 'next dev' } }) });
    expect(detectPreview(dir)).toMatchObject({ kind: 'script', runner: 'npm', needsInstall: true });
  });

  it('uses start only for projects that depend on a web tool', () => {
    expect(detectPreview(project({ 'package.json': pkg({ scripts: { start: 'react-scripts start' }, dependencies: { 'react-scripts': '5' } }) })))
      .toMatchObject({ kind: 'script', script: 'start' });
    expect(detectPreview(project({ 'package.json': pkg({ scripts: { start: 'node bot.js' } }) })).kind).toBe('none');
  });

  it('serves a plain website, checking common folders', () => {
    expect(detectPreview(project({ 'index.html': '<h1>hi</h1>' }))).toMatchObject({ kind: 'static' });
    const nested = project({}, ['public']);
    writeFileSync(join(nested, 'public', 'index.html'), 'x');
    expect(detectPreview(nested)).toMatchObject({ kind: 'static', root: join(nested, 'public') });
  });

  it('explains when there is nothing to show', () => {
    expect(detectPreview(undefined).kind).toBe('none');
    expect(detectPreview(join(tempDir(), 'missing'))).toMatchObject({ kind: 'none', reason: expect.stringContaining('no longer exists') });
    expect(detectPreview(project({ 'notes.md': '# notes' }))).toMatchObject({ kind: 'none', reason: expect.stringContaining('Nothing to preview yet') });
    expect(detectPreview(project({ 'package.json': '{ not json' })).kind).toBe('none');
  });
});

describe('findLoopbackUrl', () => {
  it('reads the address dev servers print', () => {
    expect(findLoopbackUrl('  \u001b[32m➜\u001b[39m  Local:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m')).toBe('http://localhost:5173/');
    expect(findLoopbackUrl('- Local: http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/');
    expect(findLoopbackUrl('ready on http://0.0.0.0:8080/app/')).toBe('http://localhost:8080/app/');
    expect(findLoopbackUrl('http://[::1]:4000/')).toBe('http://localhost:4000/');
  });

  it('ignores network and remote addresses', () => {
    expect(findLoopbackUrl('Network: http://192.168.1.4:5173/')).toBeUndefined();
    expect(findLoopbackUrl('see https://vite.dev for docs')).toBeUndefined();
    expect(stripAnsi('\u001b[1mbold\u001b[22m')).toBe('bold');
  });
});

describe('static site', () => {
  it('stays inside the folder and never serves hidden files', () => {
    const root = project({ 'index.html': 'home', '.env': 'SECRET=1' }, ['about', '.git']);
    writeFileSync(join(root, 'about', 'index.html'), 'about');
    expect(resolveSitePath(root, '/')).toBe(join(root, 'index.html'));
    expect(resolveSitePath(root, '/about/?x=1')).toBe(join(root, 'about', 'index.html'));
    expect(resolveSitePath(root, '/.env')).toBeUndefined();
    expect(resolveSitePath(root, '/.git/config')).toBeUndefined();
    expect(resolveSitePath(root, '/../outside.txt')).toBeUndefined();
    expect(resolveSitePath(root, '/%2e%2e/outside.txt')).toBeUndefined();
    expect(resolveSitePath(root, '/C:/Windows/win.ini')).toBeUndefined();
    expect(resolveSitePath(root, '/%E0%A4%A')).toBeUndefined();
  });

  it('refuses a junction that leads out of the folder', () => {
    const root = project({ 'index.html': 'home' });
    const outside = project({ 'secret.txt': 'nope' });
    try {
      symlinkSync(outside, join(root, 'escape'), 'junction');
    } catch {
      return;
    }
    expect(resolveSitePath(root, '/escape/secret.txt')).toBeUndefined();
  });

  it('serves pages to loopback hosts only', async () => {
    const site = await serveStaticSite(project({ 'index.html': '<h1>hello</h1>' }));
    try {
      const page = await fetch(site.url);
      expect(page.status).toBe(200);
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(await page.text()).toContain('hello');
      expect((await fetch(`${site.url}missing.png`)).status).toBe(404);
      expect((await fetch(site.url, { method: 'POST' })).status).toBe(405);
    } finally {
      await site.close();
    }
  });
});

describe('PreviewManager', () => {
  const managers: PreviewManager[] = [];
  const manager = (options?: ConstructorParameters<typeof PreviewManager>[0]) => {
    const created = new PreviewManager(options);
    managers.push(created);
    return created;
  };
  afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.stopAll())); });

  async function until(read: () => PreviewView, done: (view: PreviewView) => boolean, timeoutMs = 25_000): Promise<PreviewView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = read();
      if (done(view) || Date.now() > deadline) return view;
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
  }

  it('refuses folders with nothing to run', async () => {
    await expect(manager().start(project({ 'notes.md': 'x' }))).rejects.toThrow(/Nothing to preview yet/);
  });

  it('serves a plain website immediately and stops it', async () => {
    const previews = manager();
    const dir = project({ 'index.html': '<p>site</p>' });
    const view = await previews.start(dir);
    expect(view.status).toBe('running');
    expect(await (await fetch(view.url!)).text()).toContain('site');
    expect((await previews.stop(dir)).status).toBe('idle');
    await expect(fetch(view.url!)).rejects.toThrow();
  });

  it('runs the dev script, finds its address, and stops it', async () => {
    const server = "import { createServer } from 'node:http'; const port = Number(process.env.PORT); createServer((q, s) => s.end('<h1>built by an agent</h1>')).listen(port, '127.0.0.1', () => console.log(`  Local: http://localhost:${port}/`));";
    const dir = project({ 'package.json': pkg({ scripts: { dev: 'node server.mjs' } }), 'server.mjs': server }, ['node_modules']);
    const previews = manager();
    expect((await previews.start(dir)).status).toBe('starting');
    const view = await until(() => previews.view(dir), (v) => v.status !== 'starting');
    expect(view).toMatchObject({ status: 'running', url: expect.stringMatching(/^http:\/\/localhost:\d+\/$/) });
    expect(await (await fetch(view.url!.replace('localhost', '127.0.0.1'))).text()).toContain('built by an agent');
    expect((await previews.start(dir)).url).toBe(view.url);
    await previews.stop(dir);
    await expect(fetch(view.url!.replace('localhost', '127.0.0.1'))).rejects.toThrow();
  });

  it('reports a script that crashes, keeping its output', async () => {
    const dir = project({ 'package.json': pkg({ scripts: { dev: 'node crash.mjs' } }), 'crash.mjs': "console.error('Cannot find module react'); process.exit(3);" }, ['node_modules']);
    const previews = manager();
    await previews.start(dir);
    const view = await until(() => previews.view(dir), (v) => v.status === 'failed');
    expect(view.status).toBe('failed');
    expect(view.error).toMatch(/couldn’t start/);
    expect(view.log.join('\n')).toContain('Cannot find module react');
  });

  it('gives up on a script that never serves a page', async () => {
    const dir = project({ 'package.json': pkg({ scripts: { dev: 'node idle.mjs' } }), 'idle.mjs': 'setInterval(() => {}, 1000);' }, ['node_modules']);
    const previews = manager({ startTimeoutMs: 1500 });
    await previews.start(dir);
    const view = await until(() => previews.view(dir), (v) => v.status === 'failed');
    expect(view.error).toMatch(/never opened a web page/);
  });
});
