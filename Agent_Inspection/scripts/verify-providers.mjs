import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Full App fixture: prove a provider unknown at build time appears on every managed surface.
const captures = resolve(import.meta.dirname, '../.impeccable/review'); mkdirSync(captures, { recursive: true });
const native = [
  { id: 'claude', label: 'Claude', launchLabel: 'Claude (Agent SDK)', intercept: true, cli: true, plugins: true },
  { id: 'codex', label: 'Codex', launchLabel: 'Codex (codex exec)', intercept: false, cli: true, plugins: false },
  { id: 'copilot', label: 'GitHub Copilot', launchLabel: 'Copilot (Agent SDK)', intercept: true, cli: false, plugins: false },
];
const dynamic = { id: 'gemini', label: 'Gemini CLI', launchLabel: 'Gemini CLI', adapter: 'acp', available: true, intercept: true, cli: false, plugins: false, detail: 'ACP · uses the agent’s existing sign-in' };
let providers = [...native], launches = [], additions = [], socket;
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**/ws', ws => { socket = ws; ws.send(JSON.stringify({ type: 'snapshot', agents: [], pending: [], teams: [], hooks: { installed: true } })); });
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname; let json = {};
    if (path === '/api/providers') json = { providers, configFile: 'C:/Waystation/providers.json', warnings: [] };
    else if (path === '/api/providers/acp') {
      const body = req.postDataJSON(); additions.push(body); providers = [...providers, { ...body, launchLabel: body.label, adapter: 'acp', available: true, intercept: true, cli: false, plugins: false }]; json = { providers };
    } else if (path === '/api/managed') {
      const body = req.postDataJSON(); launches.push(body);
      const agent = { id: 'managed:gemini-fixture', sessionId: 'gemini-session', vendor: body.vendor, providerId: body.vendor, providerLabel: 'Gemini CLI', tier: 'A', name: 'Gemini builder', project: 'App', cwd: body.cwd, status: 'idle', source: 'ACP · launched here', hooked: false, intercepting: true, canInstruct: true, capabilities: { resume: true } };
      socket.send(JSON.stringify({ type: 'agents', agents: [agent], hooks: { installed: true } })); json = { agent };
    } else if (path === '/api/providers/copilot') json = { authenticated: false, models: [], limits: [] };
    else if (path.endsWith('/events')) json = { events: [] };
    else if (path.endsWith('/queue')) json = { messages: [] };
    else if (path === '/api/templates') json = { templates: [] };
    else if (path === '/api/schedules') json = { schedules: [] };
    else if (path === '/api/library/notify') json = { channels: [] };
    else if (path === '/api/library/mcp') json = { servers: [], presets: [] };
    else if (path === '/api/library/plugins') json = { plugins: [] };
    else if (path === '/api/discovery') json = { rules: [], agents: [] };
    else if (path === '/api/prerequisites') json = { prerequisites: [{ id: 'codex', ok: true }, { id: 'git', ok: true }, { id: 'terminal', ok: true }] };
    else if (path === '/api/usage') json = { usage: { today: { tokens: 0, costUsd: 0 }, byDay: [], byAgent: [] } };
    else if (path === '/api/usage/windows') json = { windows: { generatedAt: Date.now(), vendors: [{ vendor: 'gemini', limits: [], message: 'ACP does not supply account quotas.', week: { start: Date.now() - 604800000, end: Date.now(), tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, totalTokens: 120, unpricedTokens: 120, requests: 1 } }] } };
    else if (path.includes('notifications')) json = { unread: 0, notifications: [] };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(json) });
  });
  await page.goto('http://127.0.0.1:5173/#token=abcdef1234567890&autostart=1', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Launch a new agent' });
  await dialog.getByRole('radio', { name: 'Claude (Agent SDK)', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('radio', { name: 'Gemini CLI', exact: true }).count(), 0);
  providers = [...native, dynamic];
  // Use the actual ten-second poll rather than forcing an application reload.
  await dialog.getByRole('radio', { name: 'Gemini CLI', exact: true }).waitFor({ timeout: 15000 });
  await dialog.getByRole('radio', { name: 'Gemini CLI', exact: true }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Gemini builder');
  await dialog.getByLabel('Project folder (absolute path)').fill('C:/Projects/App');
  await dialog.getByLabel('Task', { exact: true }).fill('Build with Gemini');
  await dialog.getByRole('checkbox', { name: /Intercept mode/ }).check();
  await page.screenshot({ path: resolve(captures, 'providers-launch-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(captures, 'providers-launch-mobile.png'), fullPage: true });
  assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await dialog.getByRole('button', { name: 'Launch', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(launches[0].vendor, 'gemini'); assert.equal(launches[0].intercept, true);
  const drawer = page.getByRole('complementary', { name: 'Details for Gemini builder' });
  await drawer.getByRole('tab', { name: 'Controls', exact: true }).click();
  await drawer.getByRole('switch', { name: 'Review tool calls' }).waitFor();
  await drawer.getByRole('button', { name: 'Restart & continue', exact: true }).waitFor();
  await drawer.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: /Teams/ }).first().click();
  await page.getByRole('button', { name: 'New team', exact: true }).first().click();
  const team = page.getByRole('dialog', { name: 'Create an agent team' });
  await team.getByLabel('Member 1 agent').selectOption('gemini'); await team.getByLabel('Member 2 agent').selectOption('gemini');
  await team.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Usage & schedules', exact: true }).click();
  await page.getByRole('article', { name: 'Gemini CLI', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Schedules', exact: false }).click();
  await page.getByRole('button', { name: 'New schedule', exact: true }).first().click();
  await page.locator('form.schedule-form select').first().selectOption('gemini');
  await page.getByRole('tab', { name: 'Setup checks', exact: true }).click();
  await page.getByRole('heading', { name: 'Connected agent providers', exact: true }).waitFor();
  await page.getByText('Connect another ACP agent', { exact: true }).click();
  const form = page.getByRole('button', { name: 'Connect agent', exact: true }).locator('..');
  await form.getByLabel('Agent name', { exact: true }).fill('Another Agent');
  await form.getByLabel('Executable or absolute path', { exact: true }).fill('another-agent');
  await form.getByLabel('Arguments (JSON array)', { exact: true }).fill('["--acp"]');
  await form.getByRole('button', { name: 'Connect agent', exact: true }).click();
  await page.getByText('Another Agent is registered.', { exact: false }).waitFor();
  assert.equal(additions[0].command, 'another-agent'); assert.deepEqual(additions[0].args, ['--acp']);
  await page.screenshot({ path: resolve(captures, 'providers-setup-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: resolve(captures, 'providers-setup-desktop.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Dynamic providers verified: live discovery without reload, launch, controls, team and schedule selectors, usage, registration and desktop/mobile layout.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { for (const context of browser.contexts()) await context.close(); await browser.close(); }
