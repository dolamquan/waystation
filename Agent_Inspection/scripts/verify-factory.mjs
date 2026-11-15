import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const output = resolve(process.env.FACTORY_VERIFY_OUTPUT ?? '.impeccable/factory'); mkdirSync(output, { recursive: true });
const captures = resolve(process.env.FACTORY_REVIEW_OUTPUT ?? '.impeccable/review'); mkdirSync(captures, { recursive: true });
const fixture = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/factory-fixture.ts'], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let diagnostics = ''; fixture.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-10000); });
const ready = await new Promise((resolveReady, reject) => {
  let buffer = ''; const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${diagnostics}`)), 20000);
  fixture.stdout.on('data', chunk => { buffer += chunk; for (const line of buffer.split('\n')) { try { const parsed = JSON.parse(line); if (parsed.ready) { clearTimeout(timer); resolveReady(parsed); } } catch {} } });
  fixture.on('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${diagnostics}`)); });
});
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = []; const check = (name, evidence) => { results.push({ name, passed: true, evidence }); console.log(`PASS ${name}`); };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${ready.port}`;
  const api = async (method, path, body) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-tower-token': ready.token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
  };
  const sections = () => page.getByRole('navigation', { name: 'Factory sections', exact: true });
  const section = name => sections().getByRole('button').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
  const details = () => page.getByRole('navigation', { name: 'Work item sections', exact: true });
  const snapshot = () => api('GET', '/api/factory');
  const waitStatus = async (id, status) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { const item = (await snapshot()).items.find(item => item.id === id); if (item.status === status) return item; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`Expected ${status}: ${JSON.stringify(await snapshot())}`);
  };
  await page.goto(`${base}/#token=${ready.token}&autostart=1`);
  await page.getByRole('button', { name: /^Software factory/ }).click();
  await page.getByRole('heading', { name: 'Give your agents a process.' }).waitFor();
  check('Factory empty state', 'No fabricated work or metrics');
  await page.getByRole('button', { name: 'Create your first factory' }).click();
  await page.getByLabel('Factory name', { exact: true }).fill('Portal factory'); await page.getByLabel('Repository path', { exact: true }).fill(ready.repository);
  await page.getByRole('button', { name: 'Create factory', exact: true }).click();
  await page.getByRole('heading', { name: 'How work moves' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'New work', exact: true }).isDisabled(), true);
  check('Create factory and missing-check guard', 'Repository persisted; work requires checks');
  await page.getByRole('button', { name: 'Add check', exact: true }).click();
  await page.getByLabel('Check name', { exact: true }).fill('Behavior regression'); await page.getByLabel('Command', { exact: true }).fill('node verify.cjs');
  await page.getByLabel('Automatic repair attempts').fill('1');
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await page.getByText('Saved. New work items will use this configuration.').waitFor();
  assert.equal((await snapshot()).factories[0].workflow.checks[0].command, 'node verify.cjs');
  check('Workflows: checks, approval settings and limits', 'Saved configuration verified through real API');
  await sections().getByRole('button', { name: /^Agents/ }).click();
  const planner = page.locator('fieldset').filter({ has: page.locator('legend', { hasText: 'Planner' }) });
  await planner.getByLabel('Model', { exact: true }).fill('claude-sonnet-5-5');
  await planner.getByLabel('Instructions', { exact: true }).fill('Investigate the request and propose a plan. Do not edit files.');
  await page.getByRole('button', { name: 'Save configuration' }).click(); await page.getByText('Saved. New work items will use this configuration.').waitFor();
  assert.equal((await snapshot()).factories[0].roles.planner.model, 'claude-sonnet-5-5');
  check('Agents: provider roles, model and instructions', 'Role edit persisted');
  await sections().getByRole('button', { name: /^Settings/ }).click();
  await page.getByLabel('Project context', { exact: true }).fill('Preserve existing behavior and keep changes scoped.');
  await page.getByRole('button', { name: 'Save configuration' }).click(); await page.getByText('Saved. New work items will use this configuration.').waitFor();
  assert.match((await snapshot()).factories[0].context, /Preserve/);
  check('Settings: repository, identity and context', 'Context persisted independently of existing work');
  await sections().getByRole('button', { name: /^Overview/ }).click(); await page.getByRole('heading', { name: 'Workflow & activity' }).waitFor();
  await page.getByRole('button', { name: 'New work', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Add portal behavior'); await page.getByLabel('Request', { exact: true }).fill('Write feature.txt containing implemented.');
  await page.getByLabel('Acceptance criteria', { exact: true }).fill('The behavior regression must pass; the new file contains implemented.');
  await page.getByRole('button', { name: 'Queue work' }).click(); await page.getByRole('heading', { name: 'Add portal behavior', exact: true }).waitFor();
  let item = (await snapshot()).items[0]; assert.equal(item.status, 'queued'); assert.equal(item.attempts.length, 0);
  check('Work: create scoped request and acceptance criteria', 'Queued without launching agents');
  await page.getByRole('button', { name: 'Start work', exact: true }).click(); await waitStatus(item.id, 'plan_review');
  await details().getByRole('button', { name: 'Plan', exact: true }).click(); await page.getByText(/Plan: implement feature.txt/).waitFor();
  await page.getByRole('button', { name: /^Needs attention/ }).click();
  await page.getByRole('region', { name: 'Factory decisions' }).getByRole('button', { name: /Add portal behavior/ }).click();
  await page.getByRole('button', { name: 'Approve plan & build' }).click();
  item = await waitStatus(item.id, 'acceptance'); assert.ok(item.evidence.every(check => check.outcome === 'passed' && check.revision === item.candidate));
  check('Plan approval and Needs attention', 'Plan approved explicitly before building');
  await details().getByRole('button', { name: 'Runs', exact: true }).click(); await page.getByText(/No blocking findings in this fixture/).waitFor();
  check('Runs: planning, building and reviewer results', 'Three completed deterministic agent attempts');
  await details().getByRole('button', { name: 'Changes', exact: true }).click(); await page.getByText(/\+implemented/, { exact: false }).waitFor();
  check('Changes: real branch diff', 'New implementation visible in Git diff');
  await details().getByRole('button', { name: /^Checks/ }).click(); await page.getByText('Behavior regression · passed').waitFor();
  await page.getByText('Behavior regression · passed').click(); await page.getByText(/Factory behavior verified/).waitFor();
  check('Checks: actual process evidence', 'Executed node verify.cjs in the isolated worktree');
  await details().getByRole('button', { name: 'Activity', exact: true }).click(); await page.getByText(/The plan is ready/).waitFor();
  check('Activity: persisted lifecycle history', 'Plan, build, validation and review transitions recorded');
  await details().getByRole('button', { name: 'Brief', exact: true }).click(); await page.getByRole('heading', { name: 'Acceptance criteria', exact: true }).waitFor();
  check('Brief: acceptance criteria and revision identity', item.candidate);
  await page.getByRole('button', { name: 'Accept candidate' }).click(); await waitStatus(item.id, 'accepted');
  await page.getByRole('button', { name: 'Merge accepted branch' }).click(); await page.getByRole('button', { name: 'Merge branch', exact: true }).click();
  await waitStatus(item.id, 'delivered'); assert.equal(readFileSync(join(ready.repository, 'feature.txt'), 'utf8').trim(), 'implemented');
  check('Acceptance and delivery', 'Approved candidate merged into the real temporary repository');
  await sections().getByRole('button', { name: /^Quality/ }).click(); await page.getByRole('heading', { name: 'Evidence, then confidence' }).waitFor(); await page.getByText('100%', { exact: true }).waitFor();
  check('Quality: actual evidence aggregation', 'One passing check and one accepted change');
  await section('Work').click();
  await page.getByLabel('Search work', { exact: true }).fill('does not exist'); await page.getByRole('heading', { name: 'No matching work' }).waitFor();
  await page.getByLabel('Search work', { exact: true }).fill('portal'); await page.getByLabel('Status', { exact: true }).selectOption('complete');
  await page.getByRole('button', { name: /Add portal behavior.*Delivered/ }).waitFor();
  check('Work: search and status filters', 'Delivered item matches both filters');
  await page.goto(`${base}/#token=${ready.token}&autostart=1`); await page.getByRole('button', { name: /^Software factory/ }).click(); await page.getByRole('heading', { name: 'Portal factory', exact: true }).waitFor();
  assert.equal((await snapshot()).items[0].status, 'delivered');
  check('Reopen persistence', 'Factory definition, evidence and delivered state preserved');
  await page.getByRole('button', { name: 'New work', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Pause and cancel example');
  await page.getByLabel('Request', { exact: true }).fill('Exercise operator controls.');
  await page.getByLabel('Acceptance criteria', { exact: true }).fill('Operator controls take effect.');
  await page.getByRole('button', { name: 'Queue work' }).click();
  await page.getByRole('heading', { name: 'Pause and cancel example', exact: true }).waitFor();
  const controlItem = (await snapshot()).items.find(item => item.title === 'Pause and cancel example');
  await page.getByRole('button', { name: 'Start work', exact: true }).click();
  await page.getByRole('button', { name: 'Pause work', exact: true }).click(); await waitStatus(controlItem.id, 'paused');
  await page.getByRole('button', { name: 'Resume work', exact: true }).click(); await waitStatus(controlItem.id, 'plan_review');
  await page.getByRole('button', { name: 'Cancel work', exact: true }).click(); await waitStatus(controlItem.id, 'cancelled');
  check('Operator controls: pause, resume and cancel', 'Cancellation preserves the work item and branch');
  await page.getByRole('button', { name: 'New factory', exact: true }).click();
  await page.getByLabel('Factory name', { exact: true }).fill('Second factory'); await page.getByLabel('Repository path', { exact: true }).fill(ready.repository);
  await page.getByRole('button', { name: 'Create factory', exact: true }).click(); await page.getByRole('heading', { name: 'How work moves' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'New work', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: /^Console board/ }).click();
  await page.getByRole('button', { name: /^Software factory/ }).click();
  await page.getByRole('heading', { name: 'Second factory', exact: true }).waitFor();
  check('Factory selection survives console navigation', 'Returning from the console restores the selected factory');
  await page.getByLabel('Select factory', { exact: true }).selectOption({ label: 'Portal factory' }); await section('Work').click();
  await page.getByRole('button', { name: /Add portal behavior.*Delivered/ }).waitFor();
  check('Multiple factories and project scoping', 'Configuration and work stay scoped to the selected factory');
  for (const [name, width] of [['desktop', 1440], ['mobile', 390]]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const tab of ['Overview', 'Work', 'Agents', 'Workflows', 'Quality', 'Settings']) {
      await section(tab).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} ${tab}: horizontal overflow`);
      if (tab === 'Agents') {
        const scrollable = await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); return document.documentElement.scrollHeight <= innerHeight || scrollY > 0; });
        assert.ok(scrollable, `${name}: long pages must scroll`); await page.evaluate(() => window.scrollTo(0, 0));
      }
      await page.screenshot({ path: resolve(output, `${name}-${tab.toLowerCase()}.png`), fullPage: true });
    }
    await section('Overview').click(); await page.screenshot({ path: resolve(captures, `${name}.png`), fullPage: true });
    await section('Work').click(); await page.getByRole('button', { name: /Add portal behavior.*Delivered/ }).click();
    await details().getByRole('button', { name: /^Checks/ }).click(); await page.getByText('Behavior regression · passed').click();
    await page.getByText(/Factory behavior verified/).waitFor();
    await page.screenshot({ path: resolve(output, `${name}-item-checks.png`), fullPage: true });
    check(`${name}: all six tabs and page scrolling`, 'No document overflow; full-page screenshots captured');
  }
  assert.deepEqual(errors, []); check('Browser runtime', 'No uncaught frontend errors');
  rmSync(resolve(output, 'failure.txt'), { force: true });
  writeFileSync(resolve(output, 'results.json'), JSON.stringify({ passed: results.length, results, fixture: { repository: ready.repository, root: ready.root }, agentExecution: 'deterministic fixture; no live provider calls' }, null, 2));
  console.log(`Verified ${results.length} factory browser checks.`);
} catch (error) {
  writeFileSync(resolve(output, 'failure.txt'), `${error.stack}\n${diagnostics}`); throw error;
} finally {
  await browser.close(); fixture.send({ shutdown: true });
  await new Promise(resolve => { const timer = setTimeout(() => { fixture.kill(); resolve(); }, 8000); fixture.once('exit', () => { clearTimeout(timer); resolve(); }); });
}
