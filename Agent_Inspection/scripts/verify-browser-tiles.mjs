// Real UI, daemon, and Chromium sessions, using isolated state and a site that refuses iframes.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

let positions;
const source = createServer((req, res) => {
  if (req.url === '/layout') {
    let data = ''; req.on('data', chunk => { data += chunk; });
    req.on('end', () => { positions = JSON.parse(data); res.writeHead(204); res.end(); }); return;
  }
  if (req.url.startsWith('/submit')) submissions.push(new URL(req.url, 'http://fixture').searchParams.get('text'));
  res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
  res.end(`<!doctype html><meta charset="utf-8"><title>${req.url.startsWith('/second') ? 'Second browser page' : 'Browser tile verification'}</title>
    <style>body{margin:24px;font:18px Arial;color:#1e3040;background:#f5f8fc;min-height:2400px}h1{margin:0 0 24px}input,button,a{font:inherit}input{height:40px;width:320px}button{height:44px}a{display:block;margin-top:32px}</style>
    <h1>A website inside your tile</h1><form action="/submit"><input name="text" aria-label="Website input"><button>Submit</button></form>
    <a href="/second">Next page</a><a href="/second" target="_blank">Open another page</a>
    <button id="website-prompt" style="margin-top:32px" onclick="prompt('A website prompt','Initial reply')">Website prompt</button>
    <button id="website-fullscreen" style="margin-top:32px" onclick="document.documentElement.requestFullscreen()">Website full screen</button>
    <p>This site blocks embedded frames. Its real Chromium page still works inside the tile.</p>
    <script>addEventListener('load',()=>fetch('/layout',{method:'POST',body:JSON.stringify({prompt:document.querySelector('#website-prompt').getBoundingClientRect().toJSON(),fullscreen:document.querySelector('#website-fullscreen').getBoundingClientRect().toJSON()})}))</script>`);
});
const submissions = [];
source.listen(0, '127.0.0.1'); await once(source, 'listening');
const sourceUrl = `http://127.0.0.1:${source.address().port}`;
const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
const daemonPort = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const fixture = fork('scripts/file-workspace-fixture.ts', [], { execArgv: ['--import', 'tsx'], silent: true, windowsHide: true,
  env: { ...process.env, FILE_WORKSPACE_TEST_PORT: String(daemonPort) } });
fixture.stderr.on('data', data => process.stderr.write(data));
let browser, page;
const token = '0123456789abcdef0123456789abcdef';
const tileId = 'browser-verification';
const base = `http://127.0.0.1:${daemonPort}`;
const output = '.browser-verification'; mkdirSync(output, { recursive: true });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture failed to start')), 20000);
    createInterface({ input: fixture.stdout }).on('line', line => { try { if (JSON.parse(line).ready) { clearTimeout(timer); resolve(); } } catch {} });
    fixture.once('error', reject);
    fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}`)); });
  });
  const response = await fetch(`${base}/api/canvas/tiles`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-token': token },
    body: JSON.stringify({ id: tileId, kind: 'browser', project: 'all', name: 'Web research', url: sourceUrl }) });
  assert.equal(response.status, 200);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1480, height: 1100 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('waystation-mode', 'consoles'); localStorage.setItem('waystation-console-layout', 'canvas');
    localStorage.setItem('waystation-console-canvas', JSON.stringify({ version: 2,
      rects: { 'tile:browser-verification': { x: 40, y: 40, width: 1000, height: 700 } },
      order: ['tile:browser-verification'], viewports: { all: { panX: 30, panY: 30, zoom: 1 } } }));
  });
  await page.goto(`${base}/#token=${token}&autostart=1`);
  const tile = page.locator('.browser-tile'); await tile.waitFor();
  await page.waitForFunction(() => document.querySelector('.browser-status')?.textContent.includes('Browser tile verification'));
  console.log('PASS: real browser page loaded in the tile UI');
  const surface = tile.locator('canvas');
  const keys = tile.locator('textarea.browser-keys');
  const clickPage = async (x, y) => {
    const bounds = await surface.boundingBox();
    const size = await surface.evaluate(element => ({ width: element.width, height: element.height }));
    await page.mouse.click(bounds.x + x * bounds.width / size.width, bounds.y + y * bounds.height / size.height);
  };
  await clickPage(80, 110); await keys.pressSequentially('Real browser typing'); await keys.press('Enter');
  await page.waitForFunction(() => document.querySelector('input[aria-label="Page address"]')?.value.includes('/submit'));
  assert.deepEqual(submissions, ['Real browser typing']);
  console.log('PASS: typing and form submission through the tile UI');
  await tile.getByRole('button', { name: 'Back', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('input[aria-label="Page address"]')?.value.includes('/submit'));
  await tile.getByRole('button', { name: 'Forward', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Page address"]')?.value.includes('/submit'));
  await tile.getByRole('button', { name: 'Reload page', exact: true }).click();
  const address = tile.getByRole('textbox', { name: 'Page address' });
  await address.fill(`${sourceUrl}/second`); await address.press('Enter');
  await page.waitForFunction(() => document.querySelector('.browser-status')?.textContent.includes('Second browser page'));
  await keys.focus(); await keys.press('Control+l');
  assert.equal(await address.evaluate(element => element === document.activeElement), true);
  // Invalid schemes stay in the tile as an actionable error, without changing the current website.
  await address.fill('javascript:alert(1)'); await address.press('Enter');
  await tile.getByRole('alert').waitFor(); assert.equal(await surface.count(), 1);
  await address.fill(sourceUrl); await address.press('Enter');
  await page.waitForFunction(() => document.querySelector('.browser-status')?.textContent.includes('Browser tile verification'));
  assert.ok(positions?.prompt, 'Fixture reported browser layout');
  await clickPage(positions.prompt.x + positions.prompt.width / 2, positions.prompt.y + positions.prompt.height / 2);
  // Website dialog stays inside the tile and can be answered without freezing the input queue.
  const dialog = tile.getByRole('dialog', { name: 'Website message' });
  await dialog.waitFor(); await dialog.getByRole('textbox', { name: 'Reply to website' }).fill('Answered inside the tile');
  await dialog.getByRole('button', { name: 'OK', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
  console.log('PASS: website prompt answered in the tile UI');
  // A page's own full-screen request (a video player's button) fills only the tile, never the screen; Esc leaves it.
  const tileWidth = await surface.evaluate(element => element.clientWidth);
  await clickPage(positions.fullscreen.x + positions.fullscreen.width / 2, positions.fullscreen.y + positions.fullscreen.height / 2);
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(() => document.fullscreenElement), null);
  assert.equal(await surface.evaluate(element => element.clientWidth), tileWidth);
  await page.screenshot({ path: `${output}/fullscreen.png` });
  await keys.press('Escape');
  console.log('PASS: website full screen stays inside the tile');
  const priorWidth = await surface.evaluate(element => element.width);
  const grip = await page.getByRole('button', { name: 'Resize Web research', exact: true }).boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
  await page.mouse.move(grip.x + 90, grip.y + 45, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(width => document.querySelector('.browser-page')?.width > width, priorWidth);
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await clickPage(80, 110); await keys.pressSequentially('Scaled tile typing'); await keys.press('Enter');
  await page.waitForFunction(() => document.querySelector('input[aria-label="Page address"]')?.value.includes('Scaled'));
  assert.equal(submissions.at(-1), 'Scaled tile typing');
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.screenshot({ path: `${output}/compact.png`, fullPage: true });
  assert.deepEqual(errors, []);
  if (process.argv.includes('--external')) {
    await address.fill('https://example.com'); await address.press('Enter');
    await page.waitForFunction(() => document.querySelector('.browser-status')?.textContent.includes('Example Domain'));
    await tile.getByRole('button', { name: 'Back', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="Page address"]')?.value.includes('Scaled'));
    console.log('PASS: public HTTPS website (example.com) inside the browser tile');
  }
  await page.reload(); await page.getByRole('button', { name: 'Enter Waystation', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Page address"]')?.value.includes('Scaled'));
  await page.getByRole('button', { name: 'Close Web research', exact: true }).click();
  await tile.waitFor({ state: 'detached' });
  console.log('PASS: real in-tile browser; frame-blocking site; mouse and keyboard; form submission; history; reload; address validation; website dialogs; scaled input; reload persistence; close. Screenshots: .browser-verification/desktop.png and compact.png');
} catch (error) {
  console.error(error);
  await page?.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => undefined);
  throw error;
} finally {
  await browser?.close();
  if (fixture.connected) fixture.send({ shutdown: true });
  source.close();
}
