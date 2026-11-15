import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const output = resolve('.impeccable/factory-polish'); mkdirSync(output, { recursive: true });
const fixture = spawn(process.execPath, ['--import', 'tsx', 'scripts/factory-fixture.ts'], {
  cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, FACTORY_TEST_PORT: '47350', FACTORY_TEST_HOLD_AGENTS: '1', FACTORY_TEST_DIST: process.env.FACTORY_TEST_DIST ?? resolve(output, 'build') },
});
let diagnostics = '';
fixture.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-12000); });
let browser; let page;
const results = [];
const passed = (name, evidence) => { results.push({ name, passed: true, evidence }); console.log(`PASS ${name}`); };
try {
  const ready = await new Promise((resolveReady, reject) => {
    let buffer = ''; const timeout = setTimeout(() => reject(new Error(`Fixture startup timed out: ${diagnostics}`)), 25000);
    fixture.stdout.on('data', chunk => {
      buffer += chunk;
      for (const line of buffer.split('\n')) { try { const parsed = JSON.parse(line); if (parsed.ready) { clearTimeout(timeout); resolveReady(parsed); } } catch {} }
    });
    fixture.on('exit', code => { clearTimeout(timeout); reject(new Error(`Fixture exited ${code}: ${diagnostics}`)); });
  });
  const base = `http://127.0.0.1:${ready.port}`;
  const api = async (method, path, body, expectedStatus = 200) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-tower-token': ready.token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, expectedStatus, JSON.stringify(data)); return data;
  };
  const snapshot = () => api('GET', '/api/factory');
  const waitForItem = async (id, predicate) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const item = (await snapshot()).items.find(item => item.id === id);
      if (predicate(item)) return item;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Work item did not reach expected state: ${JSON.stringify(await snapshot())}`);
  };
  const action = (id, action) => api('POST', `/api/factory/items/${id}/action`, { action });
  const finish = async id => {
    const item = (await snapshot()).items.find(item => item.id === id);
    fixture.send({ type: 'finish', agentId: item.attempts.at(-1).agentId });
  };
  let factory = (await api('POST', '/api/factory/definitions', { name: 'Checkout workflow · test fixture', repository: ready.repository })).factory;
  factory = (await api('POST', `/api/factory/definitions/${factory.id}`, { ...factory, workflow: { ...factory.workflow, checks: [
    { name: 'Behavior regression', command: 'node verify.cjs' }, { name: 'Integration check', command: 'node verify-delay.cjs' },
  ] } })).factory;
  const create = async title => (await api('POST', '/api/factory/items', { factoryId: factory.id, title, request: 'Write feature.txt containing implemented.', criteria: 'The behavior regression and integration checks pass.' })).item;
  const work = await create('Correct checkout behavior');
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/#token=${ready.token}&autostart=1`);
  await page.getByRole('button', { name: /^Software factory/ }).click();
  const sections = () => page.getByRole('navigation', { name: 'Factory sections', exact: true });
  const section = name => sections().getByRole('button').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
  const map = () => page.getByRole('region', { name: 'Workflow architecture', exact: true });
  const roster = () => page.getByRole('region', { name: 'Assigned factory agents', exact: true });
  const detailNav = () => page.getByRole('navigation', { name: 'Work item sections', exact: true });
  await page.getByRole('heading', { name: 'Workflow & activity', exact: true }).waitFor();
  await map().getByRole('button', { name: 'Plan: Pending', exact: true }).waitFor();
  assert.equal(await map().getByRole('progressbar').getAttribute('aria-valuenow'), '0');
  passed('Queued workflow architecture', 'Seven configured stages, explicit approval gates and zero fabricated completion');

  factory = (await api('POST', `/api/factory/definitions/${factory.id}`, { ...factory, workflow: { ...factory.workflow, requirePlan: false, review: false } })).factory;
  await page.getByLabel('Workflow view', { exact: true }).selectOption('configuration');
  await map().getByText('Disabled in this workflow:', { exact: false }).waitFor();
  assert.equal(await map().getByRole('list', { name: 'Workflow stages' }).locator(':scope > li').count(), 4);
  passed('Configured architecture honors disabled stages', 'Disabled planning, plan approval and review are omitted');
  await page.getByLabel('Workflow view', { exact: true }).selectOption(work.id);
  await map().getByRole('button', { name: 'Plan: Pending', exact: true }).waitFor();
  assert.equal(await map().getByRole('list', { name: 'Workflow stages' }).locator(':scope > li').count(), 7);
  await page.getByText(/This work uses saved configuration v2/).waitFor();
  passed('Saved configuration stays distinct from current defaults', 'An existing work item retains its seven-stage workflow');

  await page.getByRole('button', { name: 'Open work item', exact: true }).click(); await page.getByRole('button', { name: 'Start work', exact: true }).click();
  let state = await waitForItem(work.id, item => item.status === 'planning');
  await map().getByRole('button', { name: 'Plan: Working', exact: true }).waitFor();
  await roster().getByText('Investigating the request and repository', { exact: true }).waitFor();
  await roster().getByText(/fixture-model/).waitFor();
  passed('Live planner identity, activity and elapsed time', 'Actual assigned session metadata is joined by agent ID');
  const plannerId = state.attempts.at(-1).agentId;
  fixture.send({ type: 'agent-state', agentId: plannerId, status: 'waiting', activity: 'Needs permission to inspect the repository' });
  await roster().getByText('Needs your input', { exact: true }).waitFor();
  passed('Agent permission wait', 'Waiting for input is distinct from actively working');
  await roster().getByRole('button', { name: 'Open agent details', exact: true }).click();
  await page.getByRole('button', { name: 'Close details', exact: true }).waitFor(); await page.getByRole('button', { name: 'Close details', exact: true }).click();
  passed('Agent details navigation', 'The real shared details drawer opens from the factory roster');
  fixture.send({ type: 'agent-state', agentId: plannerId, status: 'busy', activity: 'Investigating the request and repository' });
  fixture.send({ type: 'hide-agent', agentId: plannerId });
  await roster().getByText('Awaiting session update', { exact: true }).waitFor();
  passed('Missing session handling', 'An assignment without visible session data is not presented as working');
  fixture.send({ type: 'agent-state', agentId: plannerId, status: 'busy' }); await finish(work.id);
  await waitForItem(work.id, item => item.status === 'plan_review');
  await map().getByRole('button', { name: 'Approve plan: Waiting for you', exact: true }).waitFor();
  assert.equal(await map().getByRole('progressbar').getAttribute('aria-valuenow'), '1');
  passed('Human plan gate', 'Planner completion leaves approval waiting rather than advancing automatically');
  await page.getByRole('button', { name: 'Approve plan & build', exact: true }).click();
  await waitForItem(work.id, item => item.status === 'building');
  await detailNav().getByRole('button', { name: 'Workflow', exact: true }).click();
  await map().getByRole('button', { name: 'Build: Working', exact: true }).waitFor();
  await roster().getByText('Implementing the scoped change', { exact: true }).waitFor();
  assert.equal(await map().getByRole('progressbar').getAttribute('aria-valuenow'), '2');
  await map().getByRole('button', { name: 'Deliver: Pending', exact: true }).click(); await map().getByRole('button', { name: 'Follow current stage', exact: true }).click();
  assert.equal(await map().getByRole('button', { name: 'Build: Working', exact: true }).getAttribute('aria-pressed'), 'true');
  passed('Stage inspection and follow-current behavior', 'Selecting future nodes inspects them without executing stages');

  await section('Overview').click(); await page.getByLabel('Workflow view', { exact: true }).selectOption(work.id);
  await roster().getByText('Implementing the scoped change', { exact: true }).waitFor();
  for (const [name, width] of [['desktop', 1600], ['tablet', 1024], ['mobile', 390]]) {
    await page.setViewportSize({ width, height: 1100 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: workflow overflow`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: resolve(output, `${name}-overview.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1600, height: 1100 });
  passed('Active workflow overview across desktop, tablet and mobile', 'Real builder activity remains visible; the graph reflows without page overflow');

  await section('Agents').click(); await roster().getByText('Implementing the scoped change', { exact: true }).waitFor(); await page.getByRole('heading', { name: 'Your factory crew', exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'desktop-agents.png'), fullPage: true });
  passed('Agents separates running sessions from reusable role settings', 'The active builder and editable planner/builder/reviewer roles coexist');
  await section('Overview').click(); await finish(work.id);
  await waitForItem(work.id, item => item.status === 'validating' && item.validation?.currentCheck?.name === 'Integration check');
  await page.locator('.factory-checks-running').getByText(/Integration check.*1 of 2 checks recorded/).waitFor();
  passed('Current validation command and check progress', 'The engine persists the real check name and completed-check count');
  await waitForItem(work.id, item => item.status === 'reviewing'); await roster().getByText('Reviewing the candidate and acceptance criteria', { exact: true }).waitFor();
  await finish(work.id); await waitForItem(work.id, item => item.status === 'acceptance');
  await page.getByRole('button', { name: 'Open work item', exact: true }).click();
  await map().getByRole('button', { name: 'Accept: Waiting for you', exact: true }).waitFor();
  assert.equal(await map().getByRole('progressbar').getAttribute('aria-valuenow'), '5');
  await map().getByRole('button', { name: 'Validate: Complete', exact: true }).click(); await map().getByRole('button', { name: 'Inspect checks', exact: true }).click();
  await page.getByRole('heading', { name: 'Validation evidence', exact: true }).waitFor();
  passed('Map-to-evidence navigation', 'A completed validation node opens the recorded check results');
  await page.getByRole('button', { name: 'Accept candidate', exact: true }).click(); await waitForItem(work.id, item => item.status === 'accepted');
  await detailNav().getByRole('button', { name: 'Workflow', exact: true }).click();
  assert.equal(await map().getByRole('progressbar').getAttribute('aria-valuenow'), '6');
  await page.getByRole('button', { name: 'Merge accepted branch', exact: true }).click(); await page.getByRole('button', { name: 'Merge branch', exact: true }).click();
  await waitForItem(work.id, item => item.status === 'delivered');
  await map().getByRole('button', { name: 'Deliver: Complete', exact: true }).waitFor();
  assert.equal(await map().getByRole('progressbar').getAttribute('aria-valuenow'), '7');
  passed('Acceptance and delivery remain distinct', 'Only the confirmed merge produces seven completed stages');

  factory = (await api('POST', `/api/factory/definitions/${factory.id}`, { ...factory, workflow: { ...factory.workflow, requirePlan: false, review: false, maxRepairs: 1, checks: [{ name: 'Intentional regression', command: 'node verify-failure.cjs' }] } })).factory;
  const repair = await create('Repair a failing regression'); await action(repair.id, 'start'); await finish(repair.id);
  await waitForItem(repair.id, item => item.status === 'building' && item.repairs === 1);
  await section('Overview').click(); await page.getByLabel('Workflow view', { exact: true }).selectOption(repair.id);
  await map().getByText(/1 of 1 repairs used/).waitFor();
  assert.equal(await map().getByRole('list', { name: 'Workflow stages' }).locator(':scope > li').count(), 4);
  await finish(repair.id); await waitForItem(repair.id, item => item.status === 'blocked');
  await map().getByRole('button', { name: 'Validate: Blocked', exact: true }).waitFor();
  assert.notEqual(await map().getByRole('progressbar').getAttribute('aria-valuenow'), '4');
  await page.screenshot({ path: resolve(output, 'desktop-blocked.png'), fullPage: true });
  passed('Bounded repair loop and blocked validation', 'Failed checks return to Builder once, then remain blocked at Validate');

  const paused = await create('Pause and resume a build'); await action(paused.id, 'start');
  await page.getByLabel('Workflow view', { exact: true }).selectOption(paused.id);
  await page.getByRole('button', { name: 'Open work item', exact: true }).click();
  await page.getByRole('button', { name: 'Pause work', exact: true }).click(); await waitForItem(paused.id, item => item.status === 'paused');
  await map().getByRole('button', { name: 'Build: Paused', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Resume work', exact: true }).click(); await waitForItem(paused.id, item => item.status === 'building');
  await map().getByRole('button', { name: 'Build: Working', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel work', exact: true }).click(); await waitForItem(paused.id, item => item.status === 'cancelled');
  await map().getByRole('button', { name: 'Build: Cancelled', exact: true }).waitFor();
  passed('Paused, resumed and cancelled stage identity', 'The graph retains the actual interrupted stage');

  factory = (await api('POST', `/api/factory/definitions/${factory.id}`, { ...factory, workflow: { ...factory.workflow, review: true, maxRepairs: 0, checks: [{ name: 'Behavior regression', command: 'node verify.cjs' }] } })).factory;
  const stale = await create('Recheck a changed candidate'); await action(stale.id, 'start'); await finish(stale.id);
  await waitForItem(stale.id, item => item.status === 'reviewing'); await finish(stale.id);
  const candidate = await waitForItem(stale.id, item => item.status === 'acceptance');
  writeFileSync(resolve(candidate.workspace, 'feature.txt'), 'unvalidated follow-up');
  await api('POST', `/api/factory/items/${stale.id}/action`, { action: 'accept' }, 400);
  await waitForItem(stale.id, item => item.validation?.outcome === 'invalidated');
  await section('Overview').click(); await page.getByLabel('Workflow view', { exact: true }).selectOption(stale.id);
  await page.getByRole('button', { name: 'Open work item', exact: true }).click();
  await map().getByRole('button', { name: 'Validate: Pending', exact: true }).waitFor();
  await map().getByRole('button', { name: 'Review: Pending', exact: true }).waitFor();
  await detailNav().getByRole('button', { name: /^Checks/ }).click();
  await page.getByRole('heading', { name: 'Evidence needs revalidation', exact: true }).waitFor();
  await page.getByText('Behavior regression · passed (previous candidate)', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'desktop-invalidated-checks.png'), fullPage: true });
  await section('Quality').click(); await page.getByText('1 candidate needs revalidation', { exact: true }).waitFor();
  await page.getByText('Needs revalidation · retained results', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'desktop-invalidated-quality.png'), fullPage: true });
  passed('Invalidated evidence across workflow, Checks and Quality', 'Changed candidates lose validation/review completion and retained passes are excluded from current quality totals');
  await section('Work').click(); await page.getByRole('button', { name: /Recheck a changed candidate.*Needs attention/ }).click();

  await page.route('**/api/factory', route => route.fulfill({ status: 503, json: { error: 'Test connection interruption' } }));
  await page.getByText(/Connection interrupted: Test connection interruption/).waitFor();
  await roster().getByText('Last received session state', { exact: true }).waitFor();
  await page.unroute('**/api/factory'); await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await page.getByText(/Connection interrupted: Test connection interruption/).waitFor({ state: 'detached' });
  passed('Connection recovery and stale-state labeling', 'An interrupted feed cannot keep claiming live session updates');

  for (const [name, width] of [['desktop', 1600], ['tablet', 1024], ['mobile', 390]]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const tab of ['Overview', 'Work', 'Agents', 'Workflows', 'Quality', 'Settings']) {
      await section(tab).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} ${tab} overflow`);
    }
    await section('Work').click(); await page.getByRole('button', { name: /Correct checkout behavior.*Delivered/ }).click();
    for (const tab of ['Workflow', 'Brief', 'Plan', 'Runs', 'Changes', 'Checks', 'Activity']) {
      await detailNav().getByRole('button', { name: new RegExp(`^${tab}(?: \\(|$)`) }).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} item ${tab} overflow`);
    }
    await detailNav().getByRole('button', { name: 'Workflow', exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: resolve(output, `${name}-item-workflow.png`), fullPage: true });
    passed(`${name}: all six factory sections and seven work-item views`, 'No horizontal overflow; long pages remain scrollable');
  }
  assert.deepEqual(errors, []); passed('Browser runtime', 'No uncaught frontend errors');
  writeFileSync(resolve(output, 'results.json'), JSON.stringify({ passed: results.length, results, agents: 'deterministic test fixture; real API, SQLite, Git and check processes' }, null, 2));
  console.log(`Verified ${results.length} factory visibility browser checks.`);
} catch (error) {
  writeFileSync(resolve(output, 'failure.txt'), `${error.stack}\n${diagnostics}`); throw error;
} finally {
  await browser?.close(); if (fixture.connected) fixture.send({ shutdown: true });
  await new Promise(resolveDone => { const timer = setTimeout(() => { fixture.kill(); resolveDone(); }, 8000); fixture.once('exit', () => { clearTimeout(timer); resolveDone(); }); });
}
