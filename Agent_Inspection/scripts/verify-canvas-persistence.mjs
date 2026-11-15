import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';
const fixture = fork('scripts/file-workspace-fixture.ts', [], { execArgv: ['--import', 'tsx'], silent: true, windowsHide: true });
const ready = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Fixture did not start')), 20000);
  createInterface({ input: fixture.stdout }).on('line', line => { try { const data = JSON.parse(line); if (data.ready) { clearTimeout(timeout); resolve(data); } } catch {} }); fixture.on('error', reject);
});
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const consoleId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const agents = ['A', 'B'].map((name, index) => ({ id: `managed:layout-${name}`, name: `Layout builder ${name}`, vendor: index ? 'codex' : 'claude', tier: 'A', status: 'idle', cwd: ready.root, project: 'Layout fixture', source: 'fixture', canInstruct: false, startedAt: Date.now(), lastEventAt: Date.now() }));
  const keys = ['agent:managed:layout-A', 'agent:managed:layout-B', `console:${consoleId}`, 'tile:workspace'];
  const rects = {
    [keys[0]]: { x: -360, y: 480, width: 780, height: 500 },
    [keys[1]]: { x: 1500, y: 600, width: 640, height: 430 },
    [keys[2]]: { x: 600, y: 1200, width: 850, height: 600 },
    [keys[3]]: { x: 2400, y: -100, width: 1000, height: 700 },
  };
  let socket;
  await page.routeWebSocket('**/ws', ws => { socket = ws; setTimeout(() => ws.send(JSON.stringify({ type: 'snapshot', agents, pending: [], teams: [], hooks: { installed: true } })), 400); });
  await page.routeWebSocket('**/pty/**', ws => ws.send(JSON.stringify({ type: 'replay', data: 'Fixture agent terminal\r\n' })));
  await page.route('**/api/consoles', async route => {
    await new Promise(resolve => setTimeout(resolve, 900));
    await route.fulfill({ json: { consoles: [{ id: consoleId, name: 'Layout terminal', kind: 'claude', cwd: ready.root, state: 'running', createdAt: Date.now() - 300000, lastOutputAt: Date.now() - 300000, attention: 'ready' }] } });
  });
  await page.route('**/api/canvas/tiles', async route => { if (route.request().method() === 'GET') await new Promise(resolve => setTimeout(resolve, 900)); await route.continue(); });
  await page.addInitScript(({ root, rects, keys }) => {
    if (window.top !== window) return;
    localStorage.setItem('waystation-mode', 'consoles'); localStorage.setItem('waystation-console-layout', 'canvas');
    if (!sessionStorage.getItem('layout-fixture-seeded')) {
      sessionStorage.setItem('layout-fixture-seeded', '1');
      localStorage.setItem('waystation-canvas-tiles', JSON.stringify([{ id: 'workspace', kind: 'file', project: 'all', root, path: 'analysis.ipynb', createdAt: Date.now() }]));
      localStorage.setItem('waystation-console-canvas', JSON.stringify({ version: 1, rects, order: keys, viewports: { all: { panX: 400, panY: 70, zoom: .22 } } }));
    }
  }, { root: ready.root, rects, keys });
  const read = () => page.evaluate(() => { const value = JSON.parse(localStorage.getItem('waystation-console-canvas')); return { rects: value.rects, order: value.order, viewports: value.viewports }; });
  const waitTiles = () => page.waitForFunction(() => document.querySelectorAll('.canvas-tile').length === 4);
  const returnToBoard = async () => { await page.locator('.sidebar-nav').getByRole('button', { name: /^Console board/ }).click(); await waitTiles(); };
  const leave = async () => { await page.locator('.sidebar-nav').getByRole('button', { name: /^Agent overview/ }).click(); await page.locator('.console-canvas').waitFor({ state: 'detached' }); };
  await page.goto(`http://127.0.0.1:${ready.port}/#token=0123456789abcdef0123456789abcdef&autostart=1`);
  await waitTiles();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('waystation-console-canvas')).version === 2);
  assert.deepEqual((await read()).rects, rects, 'Delayed inventories and legacy metadata migration must keep every rectangle');
  assert.equal(await page.locator('.canvas-zoom').textContent(), '22%', 'A deliberately zoomed-out overview must be restored exactly');
  const title = page.getByRole('group', { name: /^Layout builder A title bar/ });
  await title.focus(); await title.press('ArrowRight'); await title.press('Shift+ArrowDown');
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await leave(); // No debounce wait: leaving itself must flush the latest drag/resize/view changes.
  const expected = await read();
  assert.equal(expected.rects[keys[0]].x, rects[keys[0]].x + 24);
  assert.equal(expected.rects[keys[0]].height, rects[keys[0]].height + 24);
  assert.ok(expected.viewports.all.zoom < .22);
  await returnToBoard(); await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
  assert.deepEqual(await read(), expected, 'Navigation and slow console/tile hydration must not change geometry, stacking or viewport');
  await page.reload(); await page.getByRole('button', { name: 'Enter Waystation', exact: true }).click(); await waitTiles();
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
  assert.deepEqual(await read(), expected, 'A full reload must preserve the same layout');
  socket.send(JSON.stringify({ type: 'canvas_reveal', reveal: { requestId: 'layout-regression-reveal', id: 'workspace', project: 'all' } }));
  await page.waitForFunction(() => Number(document.querySelector('.canvas-zoom').textContent.replace('%', '')) > 20);
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click(); await leave();
  const afterReveal = await read();
  await returnToBoard(); await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
  assert.deepEqual(await read(), afterReveal, 'A previously consumed reveal request must not refocus a tile on remount');
  assert.deepEqual(errors, []);
  console.log('Canvas layout survives delayed agent/console/tile inventories, legacy migration, immediate navigation, full reload, and consumed reveal remounts; positions, sizes, order, pan and low zoom preserved.');
} finally { await browser.close(); fixture.send({ shutdown: true }); }
