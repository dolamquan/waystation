import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { folder } from '../web/src/stationOffices.ts';

// An isolated real daemon and database: this check never changes the operator's running station.
const home = mkdtempSync(join(tmpdir(), 'waystation-mcp-ui-'));
const root = join(home, 'project'); mkdirSync(root);
writeFileSync(join(root, 'result.md'), '# Project result\nDisplayed through MCP.');
process.env.AGENT_TOWER_HOME = home;
process.env.CLAUDE_HOME = join(home, 'claude'); mkdirSync(process.env.CLAUDE_HOME);
const { Tower } = await import('../daemon/tower.ts');
const { startServer } = await import('../daemon/api/server.ts');
const tower = new Tower(':memory:');
const port = 47_338;
const token = '0123456789abcdef0123456789abcdef0123456789abcdef';
const base = `http://127.0.0.1:${port}`;
const server = await startServer({ tower, port, host: '127.0.0.1', token, webDist: resolve('web/dist') });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let seq = 0;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tower.library.automation.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: { project: root, ...args } } }) });
  const result = (await response.json()).result;
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent;
};

try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ project }) => {
    if (!localStorage.getItem('mcp-legacy-seeded')) {
      localStorage.setItem('waystation-mode', 'station');
      localStorage.setItem('waystation-console-layout', 'canvas');
      localStorage.setItem('waystation-canvas-tiles', JSON.stringify([{ id: 'legacy-tile', kind: 'blank', project, name: 'Legacy tile', createdAt: 1 }]));
      localStorage.setItem('mcp-legacy-seeded', 'true');
    }
  }, { project: folder(root)!.key });
  await page.goto(`${base}/#token=${token}&autostart=1`);
  await page.getByRole('button', { name: 'New agent', exact: true }).waitFor();
  // The global websocket must be attached before a live navigation request is meaningful.
  await page.locator('.sidebar-status .connection-dot.live').waitFor();
  const created = await call('create_note', { name: 'MCP verification results', content: '# A displayed result\n- Created by the MCP endpoint\n- Saved in Waystation' });
  const note = page.getByRole('region', { name: 'Canvas note' });
  await note.getByRole('heading', { name: 'A displayed result' }).waitFor();
  await page.getByRole('button', { name: 'Legacy tile. Click to rename', exact: true }).waitFor();
  const migrated = await call('list_tiles');
  assert.ok(migrated.tiles.some((tile: any) => tile.id === 'legacy-tile'));
  await note.getByRole('button', { name: 'Edit note' }).click();
  await note.getByRole('textbox', { name: 'Note Markdown' }).fill('# Edited in the app\nAgent-created notes remain editable.');
  await note.getByRole('button', { name: 'Save note' }).click();
  await note.getByRole('heading', { name: 'Edited in the app' }).waitFor();
  assert.match((await call('get_tile', { id: created.tile.id })).tile.content, /Edited in the app/);
  await call('update_tile', { id: created.tile.id, content: '# Updated by the agent\nThe app and MCP share the same note.' });
  await note.getByRole('heading', { name: 'Updated by the agent' }).waitFor();
  await call('close_tile', { id: 'legacy-tile', confirm: true });
  await page.getByRole('button', { name: 'Legacy tile. Click to rename', exact: true }).waitFor({ state: 'detached' });
  await page.reload();
  await page.getByRole('button', { name: 'Enter Waystation', exact: true }).click();
  await note.getByRole('heading', { name: 'Updated by the agent' }).waitFor();
  assert.ok(!(await call('list_tiles')).tiles.some((tile: any) => tile.id === 'legacy-tile'), 'closed legacy tile must not resurrect on reload');
  // Two open windows receive updates without replacing each other's board.
  const second = await context.newPage();
  await second.goto(`${base}/#token=${token}&autostart=1`);
  await second.getByRole('button', { name: 'Console board', exact: true }).click();
  await second.getByRole('region', { name: 'Canvas note' }).waitFor();
  const file = await call('open_file', { path: 'result.md', name: 'MCP result file' });
  await page.getByRole('button', { name: 'MCP result file. Click to rename', exact: true }).waitFor();
  await second.getByRole('button', { name: 'MCP result file. Click to rename', exact: true }).waitFor();
  assert.equal(file.tile.kind, 'file');
  await call('show_tile', { id: created.tile.id });
  await note.getByRole('heading', { name: 'Updated by the agent' }).waitFor();
  await page.waitForTimeout(250);
  const box = await note.boundingBox();
  assert.ok(box && box.x >= 0 && box.x < 1440 && box.y >= 0 && box.y < 1000, 'revealed note must be on screen');
  mkdirSync('.mcp-verification', { recursive: true });
  await page.screenshot({ path: '.mcp-verification/canvas.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Waystation MCP browser verification passed: live reveal, note editing, agent updates, file tiles, migration, reload and two-window synchronization.');
} finally {
  await browser?.close(); server.close(); await tower.shutdown();
}
