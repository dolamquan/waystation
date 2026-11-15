import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.WORKTREE_VERIFY_URL ?? 'http://127.0.0.1:5186';
const root = 'C:/Work/Waystation';
const main = { path: root, branch: 'main', head: 'a1b2c3d4e5f6', main: true, bare: false, detached: false };
const feature = { path: 'C:/Work/Waystation--feature-search', branch: 'feature/search', head: 'b2c3d4e5f6a1', main: false, bare: false, detached: false };
const trees = [main, feature];
let tiles = [{ id: 'worktree-chooser', kind: 'blank', project: 'all', createdAt: Date.now() }];
const consoles = [];
const created = [];
const opened = [];
let failLaunch = false;
const errors = [];
mkdirSync('.impeccable/review', { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**/ws', socket => socket.send(JSON.stringify({ type: 'snapshot', agents: [], pending: [], teams: [], hooks: { installed: true } })));
  await page.routeWebSocket('**/pty/**', socket => socket.send(JSON.stringify({ type: 'replay', data: 'Worktree terminal fixture\r\n' })));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.method() === 'POST' ? request.postDataJSON() ?? {} : {};
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (url.pathname === '/api/worktrees') {
      if (request.method() === 'GET') {
        if (url.searchParams.get('root') === 'C:/Not-a-repo') return reply({ error: 'Choose a folder inside a Git repository.' }, 400);
        return reply({ root, worktrees: trees, branches: trees.map(tree => tree.branch).concat('available-branch'), dirty: true, hasCommits: true, suggestedParent: 'C:/Work' });
      }
      const worktree = { ...feature, path: `C:/Work/Waystation--${body.branch.replaceAll('/', '-')}`, branch: body.branch };
      if (trees.some(tree => tree.branch === body.branch)) return reply({ error: 'That branch already exists.' }, 400);
      created.push(body); trees.push(worktree); return reply({ ok: true, root, worktree });
    }
    if (url.pathname === '/api/consoles') {
      if (request.method() === 'GET') return reply({ consoles });
      opened.push(body);
      if (failLaunch) { failLaunch = false; return reply({ error: 'Fixture: agent CLI unavailable.' }, 400); }
      const console = { ...body, id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(consoles.length + 1).padStart(12, '0')}`, name: body.name ?? body.kind, state: 'running', createdAt: Date.now(), lastOutputAt: Date.now(), attention: 'ready' };
      consoles.push(console); return reply({ ok: true, console });
    }
    if (url.pathname === '/api/canvas/tiles') {
      if (request.method() === 'POST') tiles.push(body);
      return reply(request.method() === 'POST' ? { tile: body } : { tiles });
    }
    const tileMatch = /^\/api\/canvas\/tiles\/([^/]+)(\/close)?$/.exec(url.pathname);
    if (tileMatch) {
      if (tileMatch[2]) { tiles = tiles.filter(tile => tile.id !== tileMatch[1]); return reply({ ok: true }); }
      const tile = tiles.find(tile => tile.id === tileMatch[1]); Object.assign(tile, body); return reply({ tile });
    }
    if (url.pathname === '/api/canvas/import') return reply({ tiles, rejected: [] });
    return reply({ ok: true, items: [], projects: [], consoles: [], saved: [], providers: [], sessions: [], prerequisites: [], events: [], messages: [], channels: [], updates: [], notifications: [], unread: 0 });
  });
  await page.addInitScript(root => {
    localStorage.setItem('waystation-mode', 'consoles');
    localStorage.setItem('waystation-console-layout', 'canvas');
    localStorage.setItem('waystation-console-cwd', root);
  }, root);
  await page.goto(`${base}/#token=0123456789abcdef0123456789abcdef&autostart=1`);
  console.log('Loaded worktree fixture; checking the tile chooser.');
  await page.getByRole('heading', { name: 'What should this tile be?' }).waitFor();
  await page.getByRole('radio', { name: /^Worktree/ }).click();
  await page.getByRole('combobox', { name: /^Worktree/ }).selectOption(feature.path);
  await page.getByRole('button', { name: 'Open worktree tile', exact: true }).click();
  await page.getByRole('heading', { name: 'Git worktrees', exact: true }).waitFor();
  assert.equal(tiles[0].kind, 'worktree'); assert.equal(tiles[0].path, feature.path);
  const map = page.getByRole('region', { name: 'Worktree visualization', exact: true });
  await map.waitFor();
  const node = branch => map.getByRole('button', { name: new RegExp(`^Select worktree ${branch} at `) });
  assert.equal(await node('feature/search').getAttribute('aria-pressed'), 'true');
  await node('main').click();
  assert.equal(await node('main').getAttribute('aria-pressed'), 'true');
  await node('feature/search').focus(); await page.keyboard.press('Enter');
  assert.equal(await node('feature/search').getAttribute('aria-pressed'), 'true');

  // Create by pressing Enter: it must not accidentally submit the outer tile form or launch a terminal.
  await page.getByText('Create a worktree', { exact: true }).click();
  await page.getByLabel('New branch name', { exact: true }).fill('feature/new-ui');
  await page.getByLabel('New branch name', { exact: true }).press('Enter');
  await page.getByRole('status').filter({ hasText: 'Created feature/new-ui' }).waitFor();
  assert.equal(created.length, 1); assert.equal(opened.length, 0);
  const newPath = trees.at(-1).path;
  assert.equal(await node('feature/new-ui').getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: /^Worktree/ }).inputValue(), newPath);
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await page.screenshot({ path: '.impeccable/review/worktrees-desktop.png', fullPage: true });

  failLaunch = true;
  await page.getByRole('button', { name: 'Open Codex', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'worktree is still available' }).waitFor();
  assert.equal(tiles[0].kind, 'worktree');
  await page.getByRole('button', { name: 'Open Codex', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.terminal-pane').length === 1);
  assert.equal(opened.at(-1).cwd, newPath); assert.equal(opened.at(-1).kind, 'codex');
  assert.equal(tiles.length, 1, 'Launching leaves the manager tile intact');
  // The selected worktree is restored from daemon state, not only component state.
  await page.reload();
  const enter = page.getByRole('button', { name: 'Enter Waystation', exact: true });
  if (await enter.isVisible()) await enter.click();
  await page.getByRole('heading', { name: 'Git worktrees', exact: true }).waitFor();
  await node('feature/new-ui').waitFor();
  assert.equal(await node('feature/new-ui').getAttribute('aria-pressed'), 'true');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  // The canvas preserves world geometry across devices. Resize this tile to exercise its narrow layout at 100%.
  const managerTitle = page.getByRole('group', { name: /^Worktrees title bar/ });
  await managerTitle.focus();
  for (let i = 0; i < 24; i++) await managerTitle.press('Shift+ArrowLeft');
  for (let i = 0; i < 8; i++) await managerTitle.press('Shift+ArrowUp');
  await map.evaluate(element => {
    const tile = element.closest('.worktree-tile');
    tile.scrollTop += element.getBoundingClientRect().top - tile.getBoundingClientRect().top - 12;
  });
  await page.screenshot({ path: '.impeccable/review/worktrees-mobile.png', fullPage: true });
  assert.ok(await page.locator('.worktree-tile').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Worktree controls must not overflow their tile');
  for (let i = 0; i < 24; i++) await managerTitle.press('Shift+ArrowRight');
  for (let i = 0; i < 8; i++) await managerTitle.press('Shift+ArrowDown');
  await page.setViewportSize({ width: 1440, height: 1100 });

  // Regular agent creation can select/create a worktree and converts the blank tile only after success.
  await page.getByRole('button', { name: 'New tile', exact: true }).first().click();
  const chooser = page.locator('form.tile-chooser');
  await chooser.getByRole('radio', { name: /^Codex/ }).click();
  await chooser.getByLabel('Use a Git worktree', { exact: true }).check();
  await chooser.getByRole('combobox', { name: /^Worktree/ }).selectOption(feature.path);
  failLaunch = true;
  await chooser.getByRole('button', { name: 'Open Codex', exact: true }).click();
  await chooser.getByRole('alert').filter({ hasText: 'Could not open the console' }).waitFor();
  await chooser.getByRole('button', { name: 'Open Codex', exact: true }).click();
  await chooser.waitFor({ state: 'detached' });
  assert.equal(opened.at(-1).cwd, feature.path); assert.equal(tiles.length, 1);

  // A failed repository lookup disables launch; a corrected path can be retried.
  await page.getByRole('button', { name: 'Fit entire canvas', exact: true }).click();
  await managerTitle.dblclick();
  await page.getByText('Change repository', { exact: true }).click();
  await page.getByLabel('Repository folder', { exact: true }).fill('C:/Not-a-repo');
  await page.getByRole('alert').filter({ hasText: 'inside a Git repository' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open console', exact: true }).isDisabled(), true);
  await page.getByLabel('Repository folder', { exact: true }).fill(root);
  await page.getByRole('button', { name: 'Open console', exact: true }).waitFor();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Open console')?.disabled);
  // Git's special checkout states stay visible without becoming invalid launch targets.
  trees.push({ ...feature, path: 'C:/Work/detached', branch: undefined, detached: true, locked: 'Kept for review' },
    { ...feature, path: 'C:/Work/missing', branch: 'missing', prunable: 'Folder was deleted outside Git' },
    { ...feature, path: 'C:/Work/bare', branch: undefined, bare: true });
  await page.getByRole('button', { name: 'Refresh', exact: true }).focus();
  await page.keyboard.press('Enter');
  await node('Detached HEAD').waitFor();
  assert.equal(await node('missing').isDisabled(), true);
  assert.equal(await node('Bare repository').isDisabled(), true);
  await node('Detached HEAD').click();
  assert.equal(await node('Detached HEAD').getAttribute('aria-pressed'), 'true');
  assert.equal(await node('Detached HEAD').getByText('Locked', { exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  console.log('Worktree UI verified: interactive map and list, keyboard selection, new nodes, persistence, detached/locked/missing/bare states, launch failure/retry, invalid repository recovery, desktop and mobile.');
} catch (error) {
  if (page) {
    await page.screenshot({ path: '.impeccable/review/worktrees-failure.png', fullPage: true });
    console.error('Page text:', (await page.locator('body').innerText()).slice(0, 5000));
  }
  console.error('Page errors:', errors);
  throw error;
} finally { await browser.close(); }
