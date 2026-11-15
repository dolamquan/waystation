import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import type { Agent } from '../daemon/domain/types.ts';
import type { ConsoleInfo } from '../daemon/pty/types.ts';

const home = mkdtempSync(join(tmpdir(), 'waystation-startup-'));
process.env.AGENT_TOWER_HOME = home;
process.env.CLAUDE_HOME = join(home, 'claude');
const { Tower } = await import('../daemon/tower.ts');
const { startServer } = await import('../daemon/api/server.ts');
const tower = new Tower(':memory:');
const port = 47_452;
const token = '0123456789abcdef0123456789abcdef';
const server = await startServer({ tower, port, host: '127.0.0.1', token,
  webDist: resolve(process.env.CONSOLE_VERIFY_DIST ?? '.mcp-verification/console-startup-build') });
let browser;

try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let feed: Parameters<Parameters<typeof page.routeWebSocket>[1]>[0] | undefined;
  await page.routeWebSocket('**/ws', socket => {
    feed = socket;
    socket.send(JSON.stringify({ type: 'snapshot', agents: [], pending: [], teams: [], hooks: { installed: true } }));
  });
  await page.routeWebSocket('**/pty/**', socket => socket.send(JSON.stringify({ type: 'replay', data: 'Codex session ready\r\n' })));
  let snapshot: { consoles: ConsoleInfo[]; agents: Agent[] } = { consoles: [], agents: [] };
  let reads = 0;
  let release: (() => void) | undefined;
  let hold = false;
  await page.route('**/api/consoles', async route => {
    reads++;
    if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve; }); }
    await route.fulfill({ json: snapshot });
  });
  await page.addInitScript(() => {
    localStorage.setItem('waystation-mode', 'consoles');
    localStorage.setItem('waystation-console-layout', 'canvas');
  });
  await page.goto(`http://127.0.0.1:${port}/#token=${token}&autostart=1`);
  await page.getByRole('region', { name: 'Console board', exact: true }).waitFor();
  await page.locator('.standby').waitFor({ state: 'detached' });
  assert.ok(reads > 0);
  // Watch every added subtree, including nodes inserted and removed within one animation frame.
  await page.evaluate(() => {
    const observed: string[] = [];
    (window as any).startupObservedCards = observed;
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const activity of [node, ...node.querySelectorAll('[aria-label^="Activity:"]')]) {
          const label = activity.getAttribute('aria-label');
          if (label?.startsWith('Activity:')) observed.push(label);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  const agent: Agent = { id: 'codex:inside', vendor: 'codex', tier: 'C', name: 'Startup duplicate',
    project: 'test', cwd: home, source: 'Codex CLI', status: 'idle', startedAt: Date.now(),
    hooked: false, intercepting: false, canInstruct: false };
  const sessionConsole: ConsoleInfo = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', kind: 'codex',
    cwd: home, name: 'My Codex console', state: 'running', createdAt: Date.now(), lastOutputAt: Date.now(), agentId: agent.id };
  // Agents arrive live before the HTTP response includes their ownership. No provisional card should render.
  hold = true;
  feed!.send(JSON.stringify({ type: 'agents', agents: [agent], hooks: { installed: true } }));
  const deadline = Date.now() + 10_000;
  while (!release && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(release, 'the agent update should request a matching board snapshot');
  await page.waitForTimeout(500);
  assert.equal(await page.getByRole('log', { name: 'Activity: Startup duplicate' }).count(), 0);
  snapshot = { consoles: [sessionConsole], agents: [agent] };
  release();
  await page.getByRole('group', { name: 'Terminal: My Codex console', exact: true }).waitFor();
  assert.equal(await page.locator('.agent-feed').count(), 0);
  assert.deepEqual(await page.evaluate(() => (window as any).startupObservedCards), []);
  // An external session in the very same folder must still get its observed-session card.
  const outside = { ...agent, id: 'codex:outside', name: 'Real external session' };
  snapshot = { consoles: [sessionConsole], agents: [agent, outside] };
  feed!.send(JSON.stringify({ type: 'agents', agents: snapshot.agents, hooks: { installed: true } }));
  await page.getByRole('log', { name: 'Activity: Real external session', exact: true }).waitFor();
  await page.getByRole('group', { name: 'Terminal: My Codex console', exact: true }).waitFor();
  assert.ok(!(await page.evaluate(() => (window as any).startupObservedCards as string[])).includes('Activity: Startup duplicate'));
  assert.deepEqual(errors, []);
  mkdirSync('.mcp-verification', { recursive: true });
  await page.screenshot({ path: '.mcp-verification/console-startup.png', fullPage: true });
  console.log('Console startup verified: no transient observed card, the console stays visible, and external sessions remain visible.');
} finally {
  await browser?.close();
  server.close();
  await tower.shutdown();
}
