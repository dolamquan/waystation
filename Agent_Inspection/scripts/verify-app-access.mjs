import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const out = '.impeccable/app-access'; mkdirSync(out, { recursive: true });
const fixture = spawn(process.execPath, ['--import', 'tsx', 'scripts/app-access-fixture.ts'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
const lines = createInterface({ input: fixture.stdout }); const checks = []; const errors = []; let browser; let page;
fixture.stderr.on('data', bytes => { const message = bytes.toString(); if (!message.includes('ExperimentalWarning') && !message.includes('trace-warnings')) errors.push(message); });
try {
  const ready = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Fixture startup timed out.')), 30000); lines.on('line', line => { try { const v = JSON.parse(line); if (v.ready) { clearTimeout(timer); resolve(v); } } catch {} }); fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}`)); }); });
  const call = async (method, path, body, authorization) => {
    const response = await fetch(ready.url + path, { method, headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : { 'x-tower-token': ready.token }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert(response.ok, `Request failed: ${response.status}`); return data;
  };
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${ready.url}/#token=${ready.token}&autostart=1`);
  await page.getByRole('button', { name: 'Architecture', exact: true }).click();
  await page.getByRole('button', { name: 'App access', exact: true }).click(); await page.getByRole('heading', { name: 'App access', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Connect Discord', exact: true }).click();
  await page.getByLabel('Account label', { exact: true }).fill('Support server'); await page.getByLabel('Service token', { exact: true }).fill('simulated-token-no-real-provider-access');
  await page.getByRole('checkbox', { name: /Send a bot message/ }).check(); await page.getByRole('button', { name: 'Save service token', exact: true }).click();
  await page.getByRole('button', { name: 'Grant to an agent', exact: true }).waitFor(); checks.push('Connect Discord bot with explicit read and write tools');
  await page.getByRole('button', { name: 'Grant to an agent', exact: true }).click(); await page.getByRole('checkbox', { name: /Send a bot message/ }).check();
  assert(await page.getByRole('checkbox', { name: 'Require my approval for every write', exact: true }).isChecked());
  const saved = page.waitForResponse(r => r.url().endsWith('/api/connectors/grants') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Grant selected tools', exact: true }).click(); const granted = await (await saved).json(); assert(granted.grant.requireApproval); checks.push('Grant selected tools and attach exact capability versions to the intended agent');
  await page.getByRole('button', { name: 'Show connection settings', exact: true }).click(); const config = JSON.parse(await page.getByLabel('MCP configuration', { exact: true }).inputValue()); assert(config.mcpServers.app_access.url.endsWith('/agent/connectors/mcp')); await page.getByRole('button', { name: 'Dismiss', exact: true }).click(); checks.push('Reveal and dismiss a copyable per-grant MCP configuration');
  const auth = granted.mcpConfig.headers.Authorization;
  const listed = await call('POST', '/agent/connectors/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, auth); assert.equal(listed.result.tools.length, 3);
  const pending = await call('POST', '/agent/connectors/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'discord_send', arguments: { channel: '123456789', text: 'A simulated action awaiting your review.' } } }, auth); assert.equal(pending.result.structuredContent.result.status, 'approval_required');
  await page.getByRole('button', { name: 'Approve and run', exact: true }).waitFor();
  await page.screenshot({ path: `${out}/desktop-review.png`, fullPage: true });
  await page.getByRole('button', { name: 'Approve and run', exact: true }).click(); await page.getByRole('status').filter({ hasText: 'Action completed.' }).waitFor(); checks.push('Queue a write over MCP, show exact arguments, and execute only after operator approval');
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: `${out}/mobile.png`, fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page overflow'); checks.push('Mobile layout fits a 390px viewport');
  await page.setViewportSize({ width: 1500, height: 1100 }); await page.getByRole('button', { name: 'Revoke access', exact: true }).click(); await page.getByRole('status').filter({ hasText: 'Access revoked.' }).waitFor(); checks.push('Revoke access through the interface');
  const blocked = await fetch(ready.url + '/agent/connectors/mcp', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) }); assert.equal(blocked.status, 401);
  await page.getByRole('button', { name: 'Connect Gmail', exact: true }).click(); await page.getByLabel('OAuth client ID', { exact: true }).fill('simulated-oauth-client');
  await page.getByRole('button', { name: 'Prepare sign-in', exact: true }).click(); const link = await page.getByRole('link', { name: 'Continue to Gmail', exact: true }).getAttribute('href'); const url = new URL(link); assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(new URL(url.searchParams.get('redirect_uri')).port, '47379'); assert(!url.searchParams.get('scope').includes('gmail.send')); checks.push('Prepare PKCE OAuth with the real daemon callback port and read-only default scopes');
  await page.screenshot({ path: `${out}/desktop-oauth.png`, fullPage: true });
  assert.deepEqual(errors, []); writeFileSync(`${out}/verification.json`, JSON.stringify({ checks, errors }, null, 2)); console.log(JSON.stringify({ passed: checks.length, checks, errors }));
} catch (e) { if (page) { await page.screenshot({ path: `${out}/failure.png`, fullPage: true }); writeFileSync(`${out}/failure.txt`, await page.locator('.app-access').innerText().catch(() => 'No app-access surface.')); } throw e; }
finally { await browser?.close(); lines.close(); fixture.kill(); }
