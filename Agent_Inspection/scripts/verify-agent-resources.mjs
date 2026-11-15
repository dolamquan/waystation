import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const out = process.env.ARCHITECTURE_VERIFY_OUTPUT ?? '.impeccable/agent-resources'; mkdirSync(out, { recursive: true });
const fixture = spawn(process.execPath, ['--import', 'tsx', 'scripts/architecture-fixture.ts'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ARCHITECTURE_VERIFY_PORT: '47364' } });
const lines = createInterface({ input: fixture.stdout }); const errors = []; const checks = [];
let browser; let page;
try {
  const ready = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Fixture startup timed out')), 30000); lines.on('line', line => { try { const value = JSON.parse(line); if (value.ready) { clearTimeout(timer); resolve(value); } } catch {} }); fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}`)); }); });
  const call = async (method, path, body) => { const res = await fetch(ready.url + path, { method, headers: { 'content-type': 'application/json', 'x-tower-token': ready.token }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data; };
  const { document: initial } = await call('POST', '/api/architectures', { project: ready.project, graph: { title: 'Support operations', description: 'A multipurpose agent with executable resources.', nodes: [
    { id: 'input', kind: 'input', name: 'Request', description: '', x: 40, y: 180, config: { type: 'input', format: 'text' } },
    { id: 'agent', kind: 'agent', name: 'Research agent', description: 'Use the increment tool. Return its JSON result.', x: 300, y: 180 },
    { id: 'tool', kind: 'tool', name: 'Calculator', description: 'Add one to a number.', x: 300, y: 360 },
    { id: 'memory', kind: 'memory', name: 'Conversation memory', description: '', x: 40, y: 360 },
    { id: 'output', kind: 'output', name: 'Saved result', description: '', x: 560, y: 180 },
    { id: 'postgres', kind: 'memory', name: 'Postgres knowledge', description: 'An external database connection.', x: 820, y: 360 },
  ], edges: [{ id: 'i', source: 'input', target: 'agent', label: 'Task' }, { id: 't', source: 'agent', target: 'tool', label: 'Calculate' }, { id: 'm', source: 'memory', target: 'agent', label: 'Context' }, { id: 'o', source: 'agent', target: 'output', label: 'Result' }] } });
  const connection = (await call('POST', `/api/architectures/${initial.id}/connections`, { label: 'Fixture brain', provider: 'compatible', model: 'fixture-model', baseUrl: ready.modelUrl, apiKey: 'private-brain-fixture-key' })).connection;
  await call('POST', `/api/architectures/${initial.id}`, { expectedRevision: 1, operations: [{ type: 'put_node', node: { ...initial.nodes.find(n => n.id === 'agent'), runtime: { kind: 'api', policy: 'configured-tools', maxOutputTokens: 512, connectionId: connection.id } } }] });
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  const capture = async name => { if (process.env.ARCHITECTURE_VERIFY_NO_CAPTURE) return; await page.evaluate(() => { let node = document.querySelector(".architecture"); while (node) { node.scrollTop = 0; node = node.parentElement; } window.scrollTo(0, 0); }); await page.waitForFunction(() => scrollY === 0); await page.screenshot({ path: `${out}/${name}.png`, fullPage: true }); };
  const saved = async () => { await page.waitForFunction(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save resource'); const status = document.querySelector('.arch-save')?.textContent; return button?.disabled && status?.startsWith('Saved'); }); };
  await page.goto(`${ready.url}/#token=${ready.token}&autostart=1`); await page.getByRole('button', { name: 'Architecture', exact: true }).click();
  await page.getByRole('button', { name: 'Calculator, Tool', exact: true }).click();
  await page.getByLabel('Function name', { exact: true }).fill('increment');
  await page.getByLabel('JavaScript function body', { exact: true }).fill('return { answer: input.n + 1 };');
  await page.getByLabel('Resource JSON schema', { exact: true }).fill(JSON.stringify({ type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false }, null, 2));
  await page.getByRole('button', { name: 'Save resource', exact: true }).click(); await saved();
  await page.getByLabel('Resource test input', { exact: true }).fill('{"n":2}'); await page.getByRole('button', { name: 'Run tool test', exact: true }).click();
  await page.locator('.arch-resource-test pre').filter({ hasText: '"answer": 3' }).waitFor(); checks.push('Build and execute a JavaScript tool through the editor');
  await capture('tool-desktop');
  await page.getByRole('button', { name: 'Conversation memory, Memory', exact: true }).click();
  await page.getByLabel('Namespace', { exact: true }).fill('support'); await page.getByLabel('Share memory', { exact: true }).selectOption('shared');
  await page.getByLabel('Retention days', { exact: true }).fill('7'); await page.getByRole('button', { name: 'Save resource', exact: true }).click(); await saved();
  await page.getByRole('button', { name: 'Test memory', exact: true }).click(); await page.getByText('Connected. An isolated test value', { exact: false }).waitFor(); checks.push('Configure and verify persistent SQLite memory');
  await page.getByRole('button', { name: 'Postgres knowledge, Memory', exact: true }).click(); await page.getByLabel('Storage backend', { exact: true }).selectOption('postgres');
  await page.getByLabel('Database name', { exact: true }).fill('agent_memory'); await page.getByLabel('Database user', { exact: true }).fill('agent_user');
  await page.getByLabel('Resource secret', { exact: true }).fill('private-database-fixture-password'); await page.getByRole('button', { name: 'Save resource', exact: true }).click(); await saved();
  assert.equal(await page.getByLabel('Resource secret', { exact: true }).inputValue(), '');
  assert(!(await call('GET', `/api/architectures/${initial.id}`)).document.nodes.some(n => JSON.stringify(n).includes('private-database-fixture-password'))); checks.push('Configure PostgreSQL fields and keep the database password out of graph data');
  await page.getByRole('button', { name: 'Fit workflow', exact: true }).click(); await capture('postgres-desktop');
  await page.setViewportSize({ width: 390, height: 844 }); await capture('postgres-mobile'); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({ width: 1600, height: 1100 }); await page.getByRole('button', { name: 'Fit workflow', exact: true }).click();
  await page.getByRole('button', { name: 'Saved result, Output', exact: true }).click();
  await page.getByLabel('Destination', { exact: true }).selectOption('file'); await page.getByLabel('Output format', { exact: true }).selectOption('json');
  await page.getByLabel('Project-relative file path', { exact: false }).fill('agent-results/{runId}.json');
  await page.getByLabel('Resource JSON schema', { exact: true }).fill('{"type":"object","properties":{"answer":{"type":"number"}},"required":["answer"]}');
  await page.getByRole('button', { name: 'Save resource', exact: true }).click(); await saved(); checks.push('Configure a file output with JSON validation');
  await page.getByRole('button', { name: 'Research agent, Agent', exact: true }).click(); await page.getByLabel('Agent task', { exact: true }).fill('Calculate 2 + 1'); await page.getByRole('button', { name: 'Run agent', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /^Completed$/ }).waitFor();
  let runs = (await call('GET', '/api/agent-runs')).runs; const completed = runs.find(r => r.status === 'succeeded'); assert(completed); assert.equal(JSON.parse(readFileSync(join(ready.project, `agent-results/${completed.id}.json`), 'utf8')).answer, 3);
  checks.push('Run an API agent through a real tool loop, memory, and file delivery');
  await page.getByRole('button', { name: 'View in Agent activity', exact: true }).click(); await page.getByRole('heading', { name: 'Agent activity', exact: true }).waitFor();
  await page.getByText('Saved conversation to Conversation memory', { exact: true }).waitFor(); assert(await page.getByText('Calling Calculator', { exact: true }).count()); checks.push('Inspect persistent model/tool/memory/output activity in the dashboard');
  const writer = { id: 'writer', kind: 'agent', name: 'General assistant', description: 'Answer the task.', x: 50, y: 50, runtime: { kind: 'api', policy: 'chat-only', connectionId: connection.id, maxOutputTokens: 256 } };
  const second = (await call('POST', '/api/architectures', { project: ready.project, graph: { title: 'General support', description: '', nodes: [writer], edges: [] } })).document;
  await page.getByRole('button', { name: 'Architecture design', exact: true }).click(); await page.getByRole('button', { name: 'Agent activity', exact: true }).click();
  const row = page.getByRole('row').filter({ has: page.getByText('General assistant', { exact: true }) }).first(); await row.getByRole('button', { name: 'Run agent', exact: true }).click();
  await page.getByLabel('Agent task', { exact: true }).fill('slow'); await page.getByRole('button', { name: 'Start run', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click(); await page.getByRole('status').filter({ hasText: /^Cancelled$/ }).waitFor(); checks.push('Manage agents across architectures and cancel an active run');
  await page.getByRole('button', { name: 'Retry saved revision', exact: true }).click(); await page.getByRole('status').filter({ hasText: /^Completed$/ }).waitFor(); checks.push('Retry an immutable saved run');
  const latest = (await call('GET', `/api/architectures/${initial.id}`)).document;
  await call('POST', `/api/architectures/${initial.id}`, { expectedRevision: latest.revision, operations: [
    { type: 'remove_edge', id: 'o' }, { type: 'put_node', node: { id: 'approval', kind: 'approval', name: 'Review delivery', description: '', x: 560, y: 360, config: { type: 'approval', message: 'Approve this result for delivery.', timeoutMinutes: 5 } } },
    { type: 'put_edge', edge: { id: 'approval-in', source: 'agent', target: 'approval', label: '' } }, { type: 'put_edge', edge: { id: 'approval-out', source: 'approval', target: 'output', label: '' } },
  ] });
  await page.getByRole('button', { name: 'Architecture design', exact: true }).click(); const refreshedList = page.waitForResponse(r => new URL(r.url()).pathname === '/api/architectures' && r.request().method() === 'GET'); await page.getByRole('button', { name: 'Agent activity', exact: true }).click(); await refreshedList;
  const researchRow = page.getByRole('row').filter({ has: page.getByText('Research agent', { exact: true }) }).first(); await researchRow.getByRole('button', { name: 'Run agent', exact: true }).click();
  await page.getByLabel('Agent task', { exact: true }).fill('Calculate again');
  if (process.env.ARCHITECTURE_VERIFY_POLISH) {
    const path = `**/api/architectures/${initial.id}/nodes/agent/run`; await page.route(path, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Verification: submission failed. Retry this task.' }) }));
    await page.getByRole('button', { name: 'Start run', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Verification: submission failed.' }).waitFor(); const refreshedRuns = page.waitForResponse(r => new URL(r.url()).pathname === '/api/agent-runs'); await page.getByRole('button', { name: 'Refresh activity', exact: true }).click(); await refreshedRuns;
    assert(await page.getByRole('alert').filter({ hasText: 'Verification: submission failed.' }).isVisible()); assert.equal(await page.getByLabel('Agent task', { exact: true }).inputValue(), 'Calculate again'); await page.unroute(path); checks.push('Preserve submission errors and authored tasks across background refreshes');
  }
  await page.getByRole('button', { name: 'Start run', exact: true }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor(); checks.push('Pause output delivery at a configured human approval');
  await capture('activity-approval-desktop'); await page.setViewportSize({ width: 390, height: 844 }); await capture('activity-approval-mobile'); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1 && !el.closest('.agent-table-scroll')).map(el => ({ tag: el.tagName, cls: el.className, right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width, overflow: getComputedStyle(el).overflowX })).slice(0, 30))));
  await page.getByRole('button', { name: 'Approve', exact: true }).click(); await page.getByRole('status').filter({ hasText: /^Completed$/ }).waitFor(); checks.push('Approve and complete output delivery from the dashboard');
  await page.setViewportSize({ width: 1600, height: 1100 }); await capture('activity-desktop'); await page.setViewportSize({ width: 390, height: 844 }); await capture('activity-mobile');
  await page.goto(`${ready.url}/?verify=reload#autostart=1`); await page.getByRole('button', { name: 'Architecture', exact: true }).click(); await page.getByRole('button', { name: 'Agent activity', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'View activity').length >= 4);
  assert(await page.getByRole('button', { name: 'View activity', exact: true }).count() >= 4); checks.push('Retain run history after a browser reload');
  assert.deepEqual(errors, []); writeFileSync(`${out}/results.json`, JSON.stringify({ checks, errors, livePostgres: false, provider: 'local simulated compatible LLM; real JavaScript, SQLite, and file adapters' }, null, 2)); console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (e) { if (page) await page.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {}); throw e; }
finally { lines.close(); if (browser) await browser.close(); fixture.kill(); }
