import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { WebSocket, WebSocketServer } from 'ws';
import { TowerStore } from '../daemon/store/db.ts';
import { CanvasStore } from '../daemon/automation/canvas.ts';
import { BrowserTiles } from '../daemon/browser/browserTiles.ts';
import { parseBrowserAction, type BrowserAction, type BrowserEvent } from '../shared/browserTiles.ts';

describe('browser input protocol', () => {
  it('accepts bounded browser interactions and rejects raw DevTools and oversized input', () => {
    expect(parseBrowserAction('{"type":"navigate","url":"https://example.com"}')).toEqual({ type: 'navigate', url: 'https://example.com' });
    expect(parseBrowserAction('{"type":"resize","width":800,"height":600}')).toEqual({ type: 'resize', width: 800, height: 600 });
    for (const raw of ['null', '[]', '{', '{"type":"Runtime.evaluate","expression":"process.exit()"}', '{"type":"resize","width":999999,"height":600}', JSON.stringify({ type: 'text', text: 'x'.repeat(16001) })])
      expect(parseBrowserAction(raw)).toBeUndefined();
  });
});

describe('real browser tiles', () => {
  let browser: Browser, runtime: BrowserTiles, fixture: Server, app: Server, wss: WebSocketServer;
  let canvas: CanvasStore, store: TowerStore, site: string, origin: string;
  let privateHits = 0;
  const sockets = new Set<WebSocket>();
  const events: BrowserEvent[] = [];
  let frames = 0;
  const listen = async (server: Server) => {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  const connect = async (id: string) => {
    const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/${id}`);
    sockets.add(ws);
    ws.on('message', (data, binary) => { if (binary) frames += 1; else events.push(JSON.parse(data.toString())); });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Browser tile did not become ready')), 15000);
      ws.on('message', (data, binary) => {
        if (binary) return;
        const event = JSON.parse(data.toString()) as BrowserEvent;
        if (event.type === 'state' && event.url !== 'about:blank') { clearTimeout(timeout); resolve(); }
        if (event.type === 'error') { clearTimeout(timeout); reject(new Error(event.message)); }
      });
    });
    return ws;
  };
  const send = (ws: WebSocket, action: BrowserAction) => ws.send(JSON.stringify(action));

  beforeAll(async () => {
    fixture = createServer((req, res) => {
      if (req.url?.startsWith('/long.js?')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('window.longResourceLoaded = true;'); return; }
      if (req.url === '/redirect-private') { res.writeHead(302, { location: `${origin}/private` }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'cache-control': 'no-store' });
      res.end(`<!doctype html><title>${req.url === '/second' ? 'Second page' : 'Frame-blocking site'}</title>
        <style>body{margin:20px;font:18px Arial;min-height:2400px}input{width:300px;height:40px}button{height:40px}</style>
        <h1>Real browser content</h1><input aria-label="Search"><button id="prompt" onclick="document.body.dataset.reply=prompt('Your name?','Visitor')">Prompt</button>
        <a href="/second">Next page</a><a href="/second" target="_blank">New tab link</a>
        <img src="${origin}/private"><script src="/long.js?token=${'x'.repeat(2100)}"></script><script>localStorage.setItem('site-data', 'inside-tile')</script>`);
    });
    site = await listen(fixture);
    app = createServer((_req, res) => { privateHits += 1; res.end('private app'); });
    origin = await listen(app);
    wss = new WebSocketServer({ server: app });
    store = new TowerStore(':memory:'); canvas = new CanvasStore(store); canvas.origin = origin;
    runtime = new BrowserTiles(canvas, async () => {
      browser = await chromium.launch({ channel: process.platform === 'win32' ? 'chrome' : undefined, headless: true, chromiumSandbox: true });
      return browser;
    });
    wss.on('connection', (ws, req) => { void runtime.attach(ws, req.url!.slice(1)); });
  });
  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    await runtime?.shutdown(); wss?.close();
    app?.close(); fixture?.close(); store?.close();
  }, 30000);
  afterEach(async () => {
    await Promise.all(canvas.list().map(tile => runtime.close(tile.id)));
    for (const tile of canvas.list()) canvas.remove(tile.id);
  });

  it('streams frame-blocking pages and supports typing, scrolling, resizing, history, dialogs and reconnect', async () => {
    const tile = canvas.create({ kind: 'browser', project: 'p', url: site });
    const ws = await connect(tile.id);
    await expect.poll(() => browser?.contexts()[0]?.pages()[0]?.url()).toBe(`${site}/`);
    const page: Page = browser.contexts()[0].pages()[0];
    await page.waitForLoadState();
    // A loaded but still page can take a moment to paint its first frame on a busy machine.
    await expect.poll(() => frames, { timeout: 10000 }).toBeGreaterThan(0);
    expect(await page.title()).toBe('Frame-blocking site');
    expect(await page.evaluate(() => (window as any).longResourceLoaded)).toBe(true);
    expect(privateHits).toBe(0);
    expect(await page.evaluate(() => ({ opener: window.opener, bridge: typeof (window as any).waystationDesktop, token: sessionStorage.getItem('agent-tower-token') })))
      .toEqual({ opener: null, bridge: 'undefined', token: null });
    send(ws, { type: 'resize', width: 800, height: 600 });
    await expect.poll(() => page.viewportSize()).toEqual({ width: 800, height: 600 });
    const box = (await page.getByRole('textbox', { name: 'Search' }).boundingBox())!;
    const point = { x: box.x + 10, y: box.y + 10, button: 'left' as const, clicks: 1 };
    send(ws, { type: 'pointer', action: 'down', ...point }); send(ws, { type: 'pointer', action: 'up', ...point });
    send(ws, { type: 'text', text: 'hello from the tile' });
    send(ws, { type: 'key', action: 'down', key: 'End' }); send(ws, { type: 'key', action: 'up', key: 'End' });
    send(ws, { type: 'key', action: 'down', key: '!' }); send(ws, { type: 'key', action: 'up', key: '!' });
    await expect.poll(() => page.getByRole('textbox').inputValue()).toBe('hello from the tile!');
    send(ws, { type: 'wheel', x: 750, y: 500, deltaX: 0, deltaY: 500 });
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
    send(ws, { type: 'wheel', x: 750, y: 100, deltaX: 0, deltaY: -2000 });
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    const promptBox = (await page.locator('#prompt').boundingBox())!;
    const promptPoint = { x: promptBox.x + 10, y: promptBox.y + 10, button: 'left' as const, clicks: 1 };
    send(ws, { type: 'pointer', action: 'down', ...promptPoint }); send(ws, { type: 'pointer', action: 'up', ...promptPoint });
    await expect.poll(() => events.some(event => event.type === 'dialog' && event.message === 'Your name?')).toBe(true);
    send(ws, { type: 'dialog', accept: true, text: 'Tile user' });
    await expect.poll(() => page.evaluate(() => document.body.dataset.reply)).toBe('Tile user');
    send(ws, { type: 'navigate', url: `${site}/second` });
    await expect.poll(() => page.title()).toBe('Second page');
    await expect.poll(() => canvas.require(tile.id).url).toBe(`${site}/second`);
    await expect.poll(() => events.some(event => event.type === 'state' && event.back)).toBe(true);
    send(ws, { type: 'back' }); await expect.poll(() => page.title()).toBe('Frame-blocking site');
    send(ws, { type: 'forward' }); await expect.poll(() => page.title()).toBe('Second page');
    send(ws, { type: 'reload' }); await expect.poll(() => page.getByRole('heading').textContent()).toBe('Real browser content');
    ws.close(); await once(ws, 'close');
    const reconnected = await connect(tile.id);
    await expect.poll(() => events.filter(event => event.type === 'state' && event.url === `${site}/second`).length).toBeGreaterThan(1);
    expect(browser.contexts()).toHaveLength(1);
    send(reconnected, { type: 'navigate', url: `${origin}/private` });
    await expect.poll(() => events.some(event => event.type === 'error' && event.message.includes('Waystation itself'))).toBe(true);
    send(reconnected, { type: 'navigate', url: `${site}/redirect-private` });
    await expect.poll(() => ({ privateHits, url: page.url(), errors: events.filter(event => event.type === 'error') })).toMatchObject({
      privateHits: 0, errors: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('Could not load') })]),
    });
    expect(privateHits).toBe(0);
    canvas.remove(tile.id);
    await expect.poll(() => browser.contexts().length).toBe(0);
  }, 30000);

  it('isolates site storage between tiles and releases contexts when tiles change kind', async () => {
    const first = canvas.create({ kind: 'browser', project: 'p', url: site });
    const second = canvas.create({ kind: 'browser', project: 'p', url: site });
    await connect(first.id); await connect(second.id);
    await expect.poll(() => browser.contexts().length).toBe(2);
    const contexts = browser.contexts();
    await Promise.all(contexts.map(context => context.pages()[0].waitForURL(`${site}/`)));
    await contexts[0].addCookies([{ name: 'private', value: 'first-only', url: site }]);
    expect(await contexts[1].cookies()).toEqual([]);
    canvas.update(first.id, { kind: 'blank' }); canvas.remove(second.id);
    await expect.poll(() => browser.contexts().length).toBe(0);
  });

  it('lets a second viewer join a tile that is already streaming', async () => {
    const tile = canvas.create({ kind: 'browser', project: 'p', url: site });
    const first = await connect(tile.id);
    await expect.poll(() => browser?.contexts()[0]?.pages()[0]?.url()).toBe(`${site}/`);
    const before = events.filter(event => event.type === 'error').length;
    const second = await connect(tile.id);
    expect(events.filter(event => event.type === 'error').slice(before)).toEqual([]);
    expect(second.readyState).toBe(WebSocket.OPEN);
    first.close(); await once(first, 'close');
    const third = await connect(tile.id);
    expect(third.readyState).toBe(WebSocket.OPEN);
  }, 30000);

  it('reports page full screen to the tile and leaves it when the tile asks', async () => {
    const tile = canvas.create({ kind: 'browser', project: 'p', url: site });
    const ws = await connect(tile.id);
    await expect.poll(() => browser?.contexts()[0]?.pages()[0]?.url()).toBe(`${site}/`);
    const page = browser.contexts()[0].pages()[0];
    await page.waitForLoadState();
    await page.evaluate("document.body.insertAdjacentHTML('beforeend', '<button id=fs onclick=document.body.requestFullscreen()>Full</button>')");
    const isFullscreen = () => page.evaluate('Boolean(document.fullscreenElement)');
    await page.click('#fs');
    await expect.poll(isFullscreen).toBe(true);
    await expect.poll(() => events.some(event => event.type === 'fullscreen' && event.active)).toBe(true);
    send(ws, { type: 'exitFullscreen' });
    await expect.poll(isFullscreen).toBe(false);
    await expect.poll(() => events.some(event => event.type === 'fullscreen' && !event.active)).toBe(true);
    expect(parseBrowserAction('{"type":"exitFullscreen"}')).toEqual({ type: 'exitFullscreen' });
    // The tile grows while full screen and shrinks back afterwards; the page must follow both sizes.
    await page.click('#fs'); await expect.poll(isFullscreen).toBe(true);
    send(ws, { type: 'resize', width: 1480, height: 1032 });
    await expect.poll(() => page.evaluate('[innerWidth, innerHeight]')).toEqual([1480, 1032]);
    send(ws, { type: 'exitFullscreen' }); send(ws, { type: 'resize', width: 998, height: 585 });
    await expect.poll(isFullscreen).toBe(false);
    await expect.poll(() => page.evaluate('[innerWidth, innerHeight]')).toEqual([998, 585]);
  }, 30000);
});
