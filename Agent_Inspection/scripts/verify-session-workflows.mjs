import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Uses the actual application shell with mocked agent transport; backend persistence has integration tests.
const captures = resolve(import.meta.dirname, '../.impeccable/session-workflows');
mkdirSync(captures, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const now = Date.now() - 30000;
  const agent = { id: 'managed:alpha', name: 'Greeting builder', vendor: 'codex', tier: 'A', status: 'busy', sessionId: 'alpha-thread', cwd: 'C:/Projects/Alpha', project: 'Alpha', source: 'managed', hooked: false, intercepting: false, canInstruct: true, startedAt: now, lastEventAt: now };
  const gamma = { ...agent, id: 'managed:gamma', name: 'Database migration', sessionId: 'gamma-thread', project: 'Gamma', cwd: 'C:/Projects/Gamma', status: 'stopped', canInstruct: false };
  const sessions = [
    { id: agent.id, agent, state: 'active', live: true, canResume: false, updatedAt: now, originalRequest: 'Add a greeting', latestResult: 'Implemented the greeting.' },
    { id: gamma.id, agent: gamma, state: 'interrupted', live: false, canResume: true, updatedAt: now - 1000, originalRequest: 'Migrate the database', latestResult: 'Migration stopped before completion.' },
    { id: 'claude:beta', agent: { ...gamma, id: 'claude:beta', name: 'Accessibility review', vendor: 'claude', project: 'Beta', cwd: 'C:/Projects/Beta' }, state: 'finished', live: false, canResume: true, updatedAt: now - 2000, originalRequest: 'Check keyboard navigation', latestResult: 'Keyboard navigation checked.' },
  ];
  let sockets = [];
  let resumed = false;
  let version = 'v1';
  let saved;
  const messages = [
    { id: 'queued-1', agentId: agent.id, text: 'Run the full test suite after the greeting', state: 'queued', createdAt: now, updatedAt: now },
    { id: 'queued-2', agentId: agent.id, text: 'Cancel this extra task', state: 'queued', createdAt: now + 1, updatedAt: now },
    { id: 'review-1', agentId: gamma.id, text: 'Finish the database migration', state: 'review', createdAt: now, updatedAt: now, reason: 'Waystation restarted. Check the conversation before sending again.' },
  ];
  await page.routeWebSocket('**/ws', socket => {
    sockets.push(socket);
    socket.send(JSON.stringify({ type: 'snapshot', agents: resumed ? [agent, { ...gamma, status: 'idle', canInstruct: true }] : [agent], pending: [], teams: [], hooks: { installed: true } }));
  });
  await page.route('**/api/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.method() === 'POST' ? req.postDataJSON() ?? {} : {};
    const sessionId = decodeURIComponent(path.split('/')[3] ?? '');
    const review = () => ({ agentId: agent.id, originalRequest: 'Add a greeting', result: 'Implemented the greeting and verified its behavior.', agentFinished: true,
      checks: [{ command: 'npm test', ts: now, outcome: 'passed', output: '24 tests passed' }], errors: [], fingerprint: version, limitations: [], saved,
      stale: !!saved && saved.fingerprint !== version, status: saved?.fingerprint === version ? saved.decision : 'needs-review' });
    let json = { ok: true };
    if (path === '/api/sessions') json = { sessions };
    else if (path.endsWith('/resume')) {
      resumed = true; const restored = { ...gamma, status: 'idle', canInstruct: true };
      Object.assign(sessions[1], { state: 'active', live: true, canResume: false, agent: restored });
      for (const socket of sockets) socket.send(JSON.stringify({ type: 'agents', agents: [agent, restored], hooks: { installed: true } }));
      json = { ok: true, agent: restored };
    } else if (path.includes('/queue/')) {
      const id = path.split('/')[5]; const action = path.split('/')[6]; const message = messages.find(message => message.id === id);
      assert.ok(message);
      if (action === 'edit') message.text = body.text;
      if (action === 'cancel') message.state = 'cancelled';
      if (action === 'send') { assert.equal(body.confirm, true); message.state = 'delivered'; }
    } else if (path.endsWith('/queue')) json = { messages: messages.filter(message => message.agentId === sessionId) };
    else if (path.endsWith('/events')) json = { events: [{ agentId: sessionId, ts: now, kind: 'prompt', summary: 'Add a greeting' }, { agentId: sessionId, ts: now + 1, kind: 'assistant', summary: 'Implemented the greeting.' }, { agentId: sessionId, ts: now + 2, kind: 'status', summary: 'turn complete' }] };
    else if (path.endsWith('/review')) {
      if (req.method() === 'POST') { assert.equal(body.fingerprint, version); saved = { id: sessionId, ...body, reviewedAt: Date.now() }; }
      json = { review: review() };
    } else if (path.endsWith('/outputs/diff')) json = { diff: { path: 'src/greeting.ts', kind: 'diff', text: '@@ -1 +1 @@\n-old greeting\n+new greeting', truncated: false } };
    else if (path.endsWith('/outputs')) json = { outputs: { agentId: sessionId, cwd: agent.cwd, generatedAt: now, turns: [], files: [{ path: 'src/greeting.ts', insideCwd: true, touches: 1, firstTouchedAt: now, lastTouchedAt: now, tools: ['Edit'], gitStatus: ' M' }], eventsScanned: 3, eventsCapped: false, git: { available: false, reason: 'Fixture folder' } } };
    else if (path.endsWith('/prerequisites')) json = { prerequisites: [] };
    else if (path.includes('/library/notifications')) json = { updates: [], notifications: [], unread: 0 };
    else if (path.includes('/library/skills')) json = { skills: [] };
    await route.fulfill({ json });
  });
  const url = 'http://127.0.0.1:5173/#token=0123456789abcdef0123456789abcdef&autostart=1';
  await page.goto(url);
  await page.getByText('Daemon connected', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Session history', exact: true }).click();
  await page.getByRole('heading', { name: 'Database migration', exact: true }).waitFor();
  const search = page.getByRole('textbox', { name: 'Search session history' });
  await search.fill('keyboard');
  assert.equal(await page.locator('.history-row').count(), 1);
  await search.fill('');
  await page.getByLabel('Project', { exact: true }).selectOption('C:/Projects/Gamma');
  assert.equal(await page.locator('.history-row').count(), 1);
  await page.getByLabel('Project', { exact: true }).selectOption('');
  await page.screenshot({ path: resolve(captures, 'history-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator('.history-toolbar').evaluate(node => node.scrollWidth <= node.clientWidth));
  await page.screenshot({ path: resolve(captures, 'history-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Show interrupted', exact: true }).click();
  assert.equal(await page.locator('.history-row').count(), 1);
  await page.getByRole('button', { name: 'Resume conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Review delivery', exact: true }).waitFor();
  assert.equal(messages.find(message => message.id === 'review-1').state, 'review');
  await page.getByRole('button', { name: 'Review delivery', exact: true }).click();
  await page.getByRole('button', { name: 'I checked — send this message', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.message-queue summary')?.textContent?.includes('Recent delivery'));
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByLabel('Status', { exact: true }).selectOption('');
  await page.locator('.history-row').filter({ has: page.getByRole('heading', { name: 'Greeting builder', exact: true }) }).getByRole('button', { name: 'Open conversation', exact: true }).click();
  const queue = page.locator('.message-queue');
  await queue.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await queue.getByRole('textbox', { name: 'Edit queued message', exact: true }).fill('Edited follow-up task');
  await queue.getByRole('button', { name: 'Save message', exact: true }).click();
  await queue.getByText('Edited follow-up task', { exact: true }).waitFor();
  await queue.locator('.message-queue-row').filter({ hasText: 'Cancel this extra task' }).getByRole('button', { name: 'Cancel message', exact: true }).click();
  assert.equal(messages.find(message => message.id === 'queued-2').state, 'cancelled');
  await page.getByRole('combobox', { name: 'Message Greeting builder' }).fill('Draft while Codex works');
  await page.locator('.toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: resolve(captures, 'queue-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(captures, 'queue-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  agent.status = 'idle';
  for (const socket of sockets) socket.send(JSON.stringify({ type: 'agents', agents: [agent, { ...gamma, status: 'idle', canInstruct: true }], hooks: { installed: true } }));
  await page.getByRole('tab', { name: 'Review', exact: true }).click();
  await page.getByRole('heading', { name: 'Completion review', exact: true }).waitFor();
  await page.getByText('Passed', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Mark work verified', exact: true }).isEnabled(), false);
  await page.getByRole('textbox', { name: 'How did you check the request?', exact: true }).fill('Checked the greeting behavior and inspected the changed file.');
  await page.getByRole('checkbox', { name: /I reviewed the applicable tests/ }).check();
  await page.getByRole('button', { name: 'Mark work verified', exact: true }).click();
  await page.getByText('Work verified by you', { exact: true }).waitFor();
  await page.getByRole('button', { name: /greeting.ts/ }).click();
  await page.getByLabel('Changes to src/greeting.ts', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(captures, 'review-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.detail-scroll').evaluate(node => { node.scrollTop = 0; });
  assert.ok(await page.locator('.completion-review').evaluate(node => node.scrollWidth <= node.clientWidth));
  await page.screenshot({ path: resolve(captures, 'review-mobile.png'), fullPage: true });
  version = 'v2';
  await page.getByRole('button', { name: 'Refresh completion review', exact: true }).click();
  await page.getByText('The conversation or files changed since your last review.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: /I reviewed the applicable tests/ }).isChecked(), false);
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'Message Greeting builder' }).inputValue(), 'Draft while Codex works');
  await page.goto(url.replace('/#', '/?verification=reload#'));
  await page.getByRole('button', { name: 'Session history', exact: true }).click();
  await page.locator('.history-row').filter({ has: page.getByRole('heading', { name: 'Greeting builder', exact: true }) }).getByRole('button', { name: 'Open conversation', exact: true }).click();
  await page.getByText('Edited follow-up task', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS workflows: actual app navigation, project/request/reply history search, interrupted recovery, explicit resend review, queue edits and cancellation, reload persistence, completion evidence, human verification, stale review, file diff, draft retention, desktop/mobile layouts');
} finally { if (browser) await browser.close(); }
