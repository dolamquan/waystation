import type { Browser, BrowserContext, CDPSession, Dialog, Page } from 'playwright-core';
import type { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { browserUrl, type LocalTile } from '../../shared/canvasTiles.ts';
import { parseBrowserAction, type BrowserAction, type BrowserEvent } from '../../shared/browserTiles.ts';
import type { CanvasStore } from '../automation/canvas.ts';
import { EMPTY_PROFILE, mergeProfile, profileChanges, readProfile, writeProfile, type ProfileState } from './browserProfile.ts';

interface Session {
  context: BrowserContext; page: Page; cdp: CDPSession; viewers: Set<WebSocket>;
  dialog?: Dialog; idle?: NodeJS.Timeout; error?: string; disposed: boolean; loading: boolean;
  /** The cookies this tile last loaded or saved; its own changes are measured against it. */
  baseline: ProfileState; saveTimer?: NodeJS.Timeout;
  /** The page is showing an element full screen (inside its own viewport); the tile mirrors it. */
  fullscreen: boolean;
  /** Chrome refuses a second Page.startScreencast, so it starts once and later viewers share it. */
  screencasting: boolean;
  /** When Chrome last streamed a frame; a still page may stream none after loading. */
  lastFrameAt: number;
}
const IDLE_MS = 5 * 60_000;
const MAX_BUFFERED = 2 * 1024 * 1024;
const PROFILE_SAVE_DELAY_MS = 1000;
const FRAME_GRACE_MS = 300;
const SCREENCAST_QUALITY = 70;
const MAX_WHEEL_DELTA = 10000;
/** Generous room for the window's title bar and borders; the page itself stays exactly the tile's size. */
const WINDOW_FRAME = { width: 40, height: 160 };
const FULLSCREEN_BINDING = '__waystationFullscreen';
/** Top frame only: an embedded player's full screen also changes the top document's fullscreenElement. */
const FULLSCREEN_WATCH = `if (window === window.top) document.addEventListener('fullscreenchange', () => {
  try { window.${FULLSCREEN_BINDING}(Boolean(document.fullscreenElement)); } catch {}
});`;
/** Off-screen so the window never covers the desktop; it still renders, plays sound and streams to its tile. */
const HEADED_ARGS = [
  '--window-position=-32000,-32000', '--window-size=1000,700',
  // Render at 1x on scaled displays: the tile streams page pixels and maps clicks in them (see deviceScaleFactor).
  '--force-device-scale-factor=1',
  // Sites such as YouTube and Google sign-in refuse browsers that announce automation.
  '--disable-blink-features=AutomationControlled',
  '--autoplay-policy=no-user-gesture-required',
  // An off-screen window counts as hidden on Windows; keep painting and playing it.
  '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
];

export interface BrowserTilesOptions {
  /** Where cookies and site storage persist. Without it, every tile is ephemeral and isolated. */
  readonly profileFile?: string;
}

/** Real Chrome pages streamed over the authenticated operator socket, with no public DevTools port.
 * Every tile has its own browser context; with a profile file, those contexts share the operator's sign-ins.
 * Websites never receive the app's token or storage.
 */
export class BrowserTiles {
  private browser?: Promise<Browser>;
  private readonly sessions = new Map<string, Promise<Session>>();
  private stopped = false;
  private profileWrites: Promise<void> = Promise.resolve();
  private readonly changed = (tile: LocalTile) => {
    const pending = this.sessions.get(tile.id);
    if (!pending) return;
    if (tile.kind !== 'browser') { void this.close(tile.id); return; }
    void pending.then(session => {
      if (tile.url && tile.url !== session.page.url() && !session.disposed) this.navigate(session, tile.url);
    }).catch(() => undefined);
  };
  private readonly removed = (id: string) => { void this.close(id); };

  constructor(private readonly canvas: CanvasStore, private readonly launch?: () => Promise<Browser>,
    private readonly options: BrowserTilesOptions = {}) {
    canvas.on('changed', this.changed);
    canvas.on('removed', this.removed);
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = (async () => {
        if (this.launch) return this.launch();
        const { chromium } = await import('playwright-core');
        // Headless Chrome is muted and refused by YouTube and Google sign-in; a real window is the default.
        const headless = process.env.WAYSTATION_BROWSER_HEADLESS === '1';
        const options = { headless, chromiumSandbox: true, timeout: 15000,
          ...(headless ? {} : { args: HEADED_ARGS, ignoreDefaultArgs: ['--enable-automation'] }) };
        if (process.env.WAYSTATION_BROWSER_EXECUTABLE)
          return chromium.launch({ ...options, executablePath: process.env.WAYSTATION_BROWSER_EXECUTABLE });
        for (const channel of ['chrome', 'msedge'] as const) {
          try { return await chromium.launch({ ...options, channel }); } catch { /* Try the other installed browser. */ }
        }
        throw new Error('Install Chrome or Microsoft Edge, then retry opening this tile.');
      })().then(browser => {
        browser.once('disconnected', () => {
          this.browser = undefined;
          for (const id of this.sessions.keys()) void this.close(id);
        });
        return browser;
      }).catch(error => { this.browser = undefined; throw error; });
    }
    return this.browser;
  }

  private send(ws: WebSocket, event: BrowserEvent | Buffer): void {
    if (ws.readyState === 1 && ws.bufferedAmount < MAX_BUFFERED) ws.send(Buffer.isBuffer(event) ? event : JSON.stringify(event));
  }
  private broadcast(session: Session, event: BrowserEvent | Buffer): void {
    for (const viewer of session.viewers) this.send(viewer, event);
  }
  private async state(session: Session): Promise<void> {
    if (session.disposed) return;
    try {
      const history = await session.cdp.send('Page.getNavigationHistory');
      this.broadcast(session, { type: 'state', url: session.page.url(), title: await session.page.title(),
        loading: session.loading,
        back: history.currentIndex > 0 && history.entries[history.currentIndex - 1]?.url !== 'about:blank',
        forward: history.currentIndex < history.entries.length - 1 });
    } catch { /* Page is closing or changing documents. */ }
  }
  private fail(session: Session, message: string): void {
    if (session.disposed) return;
    session.error = message;
    this.broadcast(session, { type: 'error', message });
  }
  private navigate(session: Session, raw: string): void {
    const checked = browserUrl(raw, this.canvas.origin);
    if (!checked.ok) { this.fail(session, checked.reason); return; }
    session.error = undefined;
    void session.page.goto(checked.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(error => {
      if (!session.disposed && !String(error).includes('ERR_ABORTED'))
        this.fail(session, `Could not load ${new URL(checked.url).host}. Check the address or your connection, then reload.`);
    });
  }

  private setFullscreen(session: Session, active: boolean): void {
    if (session.fullscreen === active) return;
    session.fullscreen = active;
    this.broadcast(session, { type: 'fullscreen', active });
  }

  private scheduleSave(session: Session): void {
    if (!this.options.profileFile || session.disposed) return;
    clearTimeout(session.saveTimer);
    session.saveTimer = setTimeout(() => { void this.saveProfile(session); }, PROFILE_SAVE_DELAY_MS);
    session.saveTimer.unref();
  }

  /** Merges this tile's sign-in changes into the shared profile and hands them to the other open tiles. */
  private saveProfile(session: Session): Promise<void> {
    const file = this.options.profileFile;
    if (!file) return Promise.resolve();
    clearTimeout(session.saveTimer);
    this.profileWrites = this.profileWrites.then(async () => {
      const current = await session.context.storageState();
      const changes = profileChanges(session.baseline, current);
      session.baseline = current;
      if (!changes.changed.length && !changes.removed.length && !changes.origins.length) return;
      await writeProfile(file, mergeProfile(await readProfile(file), changes));
      await Promise.all([...this.sessions.values()].map(async pending => {
        const other = await pending.catch(() => undefined);
        if (!other || other === session || other.disposed) return;
        await Promise.all(changes.removed.map(({ name, domain, path }) => other.context.clearCookies({ name, domain, path })));
        if (changes.changed.length) await other.context.addCookies([...changes.changed]);
        other.baseline = mergeProfile(other.baseline, { ...changes, origins: [] });
      }));
    }).catch(() => { /* The page closed mid-save, or the disk is unavailable; the next load retries. */ });
    return this.profileWrites;
  }

  private async create(id: string): Promise<Session> {
    // The UI renders its tile optimistically; allow its queued save to reach the daemon before starting Chrome.
    let tile = this.canvas.list().find(tile => tile.id === id);
    for (let retries = 0; (!tile || tile.kind !== 'browser') && retries < 5 && !this.stopped; retries += 1) {
      await delay(100);
      tile = this.canvas.list().find(tile => tile.id === id);
    }
    if (tile?.kind !== 'browser' || !tile.url) throw new Error('This browser tile is no longer open.');
    const browser = await this.getBrowser();
    if (this.stopped) throw new Error('Waystation is shutting down.');
    const baseline = this.options.profileFile ? await readProfile(this.options.profileFile) : EMPTY_PROFILE;
    // Scale 1: on a scaled display a real window would render (and stream) every frame at up to twice the pixels,
    // which made tiles slow, and the tile maps pointer positions in page pixels.
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false,
      ...(this.options.profileFile ? { storageState: baseline } : {}) });
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      // Fetch pauses each request in a redirect chain. Playwright routes only see its first request.
      cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
        // Resource URLs can contain long signed queries; only the typed destination has a length limit.
        let allowed = false;
        try { const target = new URL(request.url); allowed = ['http:', 'https:'].includes(target.protocol) && browserUrl(target.origin, this.canvas.origin).ok; } catch { /* Invalid destination. */ }
        const reply = allowed ? cdp.send('Fetch.continueRequest', { requestId })
          : cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
        void reply.catch(() => undefined);
      });
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      const session: Session = { context, page, cdp, viewers: new Set(), disposed: false, loading: false, baseline, fullscreen: false, screencasting: false, lastFrameAt: 0 };
      await page.exposeBinding(FULLSCREEN_BINDING, ({ frame }, active: unknown) => {
        if (frame !== page.mainFrame() || session.disposed || typeof active !== 'boolean') return;
        this.setFullscreen(session, active);
      });
      await page.addInitScript({ content: FULLSCREEN_WATCH });
      // Links that ask for another tab stay inside this tile; no external windows are launched.
      context.on('page', popup => {
        if (popup === page) return;
        const navigate = () => { const url = popup.url(); if (url !== 'about:blank') { this.navigate(session, url); void popup.close().catch(() => undefined); } };
        popup.on('framenavigated', navigate); navigate();
      });
      page.on('dialog', dialog => {
        session.dialog = dialog;
        this.broadcast(session, { type: 'dialog', kind: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue() });
      });
      page.on('download', () => this.fail(session, 'To download files, open this page in your browser using the toolbar.'));
      page.on('filechooser', () => this.fail(session, 'To upload files, open this page in your browser using the toolbar.'));
      page.on('crash', () => {
        this.fail(session, 'This browser page stopped responding. Reconnect to reopen it.');
        for (const viewer of session.viewers) viewer.close(1012, 'page crashed');
        void this.close(id);
      });
      page.on('framenavigated', frame => {
        if (frame !== page.mainFrame()) return;
        this.setFullscreen(session, false); // A new document starts windowed.
        const checked = browserUrl(frame.url(), this.canvas.origin);
        if (checked.ok && !session.disposed) {
          const current = this.canvas.list().find(tile => tile.id === id);
          if (current?.kind === 'browser' && current.url !== checked.url) this.canvas.update(id, { url: checked.url });
        }
        void this.state(session);
      });
      page.on('domcontentloaded', () => { session.loading = false; void this.state(session); });
      page.on('load', () => { void this.state(session); this.scheduleSave(session); this.ensureFrame(session); });
      cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
        session.lastFrameAt = Date.now();
        this.broadcast(session, Buffer.from(data, 'base64'));
        void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
      });
      page.on('request', request => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) { session.loading = true; void this.state(session); }
      });
      cdp.on('Page.frameStoppedLoading', () => { session.loading = false; void this.state(session); });
      await cdp.send('Page.enable');
      return session;
    } catch (error) { await context.close(); throw error; }
  }

  async attach(ws: WebSocket, id: string): Promise<void> {
    ws.on('error', () => undefined);
    let pending = this.sessions.get(id);
    const fresh = !pending;
    if (!pending) {
      pending = this.create(id);
      this.sessions.set(id, pending);
      void pending.catch(() => { if (this.sessions.get(id) === pending) this.sessions.delete(id); });
    }
    try {
      const session = await pending;
      if (this.stopped || session.disposed) { ws.close(1001); return; }
      if (ws.readyState !== 1) { if (!session.viewers.size) this.expire(id, session); return; }
      clearTimeout(session.idle);
      session.viewers.add(ws);
      ws.once('close', () => {
        session.viewers.delete(ws);
        if (!session.viewers.size) {
          session.screencasting = false;
          void session.cdp.send('Page.stopScreencast').catch(() => undefined);
          if (session.dialog) { void session.dialog.dismiss().catch(() => undefined); session.dialog = undefined; }
          this.expire(id, session);
        }
      });
      let queue = Promise.resolve(), queued = 0;
      // Hover moves and scrolls arrive far faster than Chrome replays them. Consecutive ones still waiting at the end
      // of the queue merge into one (latest position, summed scroll), so the page never lags behind the pointer;
      // a click or key between them ends the merge, keeping the order of input.
      let moveSlot: { action: BrowserAction } | undefined, wheelSlot: { action: Extract<BrowserAction, { type: 'wheel' }> } | undefined;
      const enqueue = (run: () => Promise<void>) => {
        queued += 1;
        queue = queue.then(run).catch(() => {
          if (!session.disposed) this.send(ws, { type: 'error', message: 'That browser action could not finish. Try again or reload the page.' });
        }).finally(() => { queued -= 1; });
      };
      const clamp = (value: number) => Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, value));
      ws.on('message', (data, binary) => {
        if (binary) return;
        const action = parseBrowserAction(data.toString());
        if (!action || queued > 128) return;
        // A mouse/keyboard command can wait for a modal script to finish. Its answer must bypass that queue.
        if (action.type === 'dialog') { void this.act(session, action).catch(() => undefined); return; }
        if (action.type === 'pointer' && action.action === 'move') {
          if (moveSlot) { moveSlot.action = action; return; }
          const slot = { action }; moveSlot = slot; wheelSlot = undefined;
          enqueue(async () => { if (moveSlot === slot) moveSlot = undefined; await this.act(session, slot.action); });
          return;
        }
        if (action.type === 'wheel') {
          if (wheelSlot) {
            const merged = wheelSlot.action;
            wheelSlot.action = { ...action, deltaX: clamp(merged.deltaX + action.deltaX), deltaY: clamp(merged.deltaY + action.deltaY) };
            return;
          }
          const slot = { action }; wheelSlot = slot; moveSlot = undefined;
          enqueue(async () => { if (wheelSlot === slot) wheelSlot = undefined; await this.act(session, slot.action); });
          return;
        }
        moveSlot = undefined; wheelSlot = undefined;
        enqueue(() => this.act(session, action));
      });
      if (!session.screencasting) await this.startScreencast(session);
      await this.state(session);
      if (session.error) this.send(ws, { type: 'error', message: session.error });
      if (fresh) this.navigate(session, this.canvas.require(id).url!);
      else {
        // A still page may not generate a new screencast frame on reconnect.
        this.send(ws, await session.page.screenshot({ type: 'jpeg', quality: 85 }));
      }
    } catch (error) {
      this.send(ws, { type: 'error', message: error instanceof Error ? error.message.split('\n')[0] : 'Could not start the browser.' });
      ws.close(1011, 'browser unavailable');
    }
  }

  /** Shows a loaded page even when Chrome streams no frame for it (a still page in an off-screen window). */
  private ensureFrame(session: Session): void {
    setTimeout(() => {
      if (session.disposed || !session.viewers.size || Date.now() - session.lastFrameAt < FRAME_GRACE_MS) return;
      void session.page.screenshot({ type: 'jpeg', quality: 85 }).then(frame => this.broadcast(session, frame)).catch(() => undefined);
    }, FRAME_GRACE_MS).unref();
  }

  /** A real window only streams what fits inside it, so it grows with the tile (title bar and borders included). */
  private async fitWindow(session: Session, width: number, height: number): Promise<void> {
    try {
      const { windowId } = await session.cdp.send('Browser.getWindowForTarget');
      await session.cdp.send('Browser.setWindowBounds', { windowId,
        bounds: { width: width + WINDOW_FRAME.width, height: height + WINDOW_FRAME.height } });
    } catch { /* Headless browsers have no window to size. */ }
  }

  private async startScreencast(session: Session): Promise<void> {
    session.screencasting = true;
    try {
      await session.cdp.send('Page.startScreencast', { format: 'jpeg', quality: SCREENCAST_QUALITY, maxWidth: 1920, maxHeight: 1440, everyNthFrame: 1 });
    } catch (error) {
      // Already running (a stop still in flight, or a reconnect racing a close) is the state we want.
      if (!String(error).includes('already active')) { session.screencasting = false; throw error; }
    }
  }

  private expire(id: string, session: Session): void {
    clearTimeout(session.idle);
    session.idle = setTimeout(() => { void this.close(id); }, IDLE_MS);
    session.idle.unref();
  }

  private async act(session: Session, action: BrowserAction): Promise<void> {
    if (session.disposed) return;
    const { page } = session;
    switch (action.type) {
      case 'navigate': this.navigate(session, action.url); break;
      case 'back': case 'forward': case 'reload': {
        session.error = undefined;
        const operation = action.type === 'back' ? page.goBack.bind(page) : action.type === 'forward' ? page.goForward.bind(page) : page.reload.bind(page);
        void operation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => this.fail(session, 'The page could not load. Check your connection and reload.'));
        break;
      }
      case 'exitFullscreen':
        // Not awaited inside the page: its promise can stay pending in an off-screen window and would stall every later action.
        await page.evaluate('void (document.fullscreenElement && document.exitFullscreen().catch(() => undefined))').catch(() => undefined);
        this.setFullscreen(session, false);
        break;
      case 'resize':
        await this.fitWindow(session, action.width, action.height);
        await page.setViewportSize({ width: action.width, height: action.height });
        break;
      case 'pointer':
        await page.mouse.move(action.x, action.y);
        if (action.action !== 'move') await page.mouse[action.action]({ button: action.button, clickCount: action.clicks });
        break;
      case 'wheel': await page.mouse.move(action.x, action.y); await page.mouse.wheel(action.deltaX, action.deltaY); break;
      case 'key': await page.keyboard[action.action](action.key); break;
      case 'text': await page.keyboard.insertText(action.text); break;
      case 'dialog': {
        const dialog = session.dialog; session.dialog = undefined;
        if (dialog) await (action.accept ? dialog.accept(action.text) : dialog.dismiss());
        break;
      }
    }
  }

  async close(id: string): Promise<void> {
    const pending = this.sessions.get(id);
    this.sessions.delete(id);
    if (!pending) return;
    try {
      const session = await pending;
      clearTimeout(session.idle);
      await this.saveProfile(session);
      session.disposed = true;
      for (const viewer of session.viewers) viewer.close(1000, 'tile closed');
      if (session.dialog) await session.dialog.dismiss().catch(() => undefined);
      // Release intercepted requests and the screencast before closing the context/process.
      await session.cdp.send('Page.stopScreencast').catch(() => undefined);
      await session.cdp.send('Fetch.disable').catch(() => undefined);
      await session.cdp.detach().catch(() => undefined);
      await session.context.close();
    } catch { /* A failed startup has no context to close. */ }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.canvas.off('changed', this.changed); this.canvas.off('removed', this.removed);
    await Promise.all([...this.sessions.keys()].map(id => this.close(id)));
    try { await (await this.browser)?.close(); } catch { /* Browser already exited. */ }
  }
}
