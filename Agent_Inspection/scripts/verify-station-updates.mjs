import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const html = resolve(root, 'web/.station-update-verification.html');
const fixture = resolve(root, 'web/.station-update-verification.tsx');
const captures = resolve(root, '.impeccable/review');
mkdirSync(captures, { recursive: true });
writeFileSync(html, '<html><head><meta name="viewport" content="width=device-width,initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/.station-update-verification.tsx"></script></body></html>');
writeFileSync(fixture, `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StationScene } from './src/components/StationScene.tsx';
import { layoutDecks } from './src/stationLayout.ts';
import './src/styles.css'; import './src/world.css'; import './src/reading.css';
import './src/teams.css'; import './src/ops.css'; import './src/library.css';
import './src/workbench.css'; import './src/workspace.css'; import './src/team-session.css'; import './src/usage.css';
const agent = (id, activity, status = 'busy') => ({ id, name: id, currentActivity: activity, status, project: 'Waystation', vendor: 'codex', tier: 'A', source: 'managed', hooked: false, intercepting: false, canInstruct: true });
const initial = [agent('Builder', 'Editing AgentDrawer.tsx'), agent('Reviewer', 'Reading notes.md'), agent('Researcher', 'Searching files for notification settings and launch configuration'), agent('Idle agent', 'Editing old-file.ts', 'idle'), agent('Needs approval', 'Running npm test'), agent('Team lead', 'Planning the next changes'), agent('Team worker', 'Running npm test')];
const helper = { ...agent('Helper', 'Reading stationLayout.ts'), parentId: 'Builder' };
const team = { id: 'team', name: 'UI crew', status: 'running', createdAt: 1, members: [5,6].map((i, index) => ({ id: initial[i].id, name: initial[i].name, role: index ? 'worker' : 'lead', vendor: 'codex', agentId: initial[i].id })), tasks: [], budget: {} };
const pending = [{ id: 'held', agentId: 'Needs approval', sessionId: 'test', toolName: 'Bash', input: { command: 'npm test' }, createdAt: 1, origin: 'managed' }];
function Fixture() {
  const [agents, setAgents] = useState(initial);
  const [selected, setSelected] = useState('');
  useEffect(() => { const update = e => setAgents(a => a.map(item => item.id === e.detail.id ? { ...item, ...e.detail } : item)); window.addEventListener('fixture-update', update); return () => window.removeEventListener('fixture-update', update); }, []);
  return <div className="workbench-content" style={{ height: '100vh', overflow: 'auto' }}><output id="selection" style={{position:'absolute', clipPath:'inset(50%)'}}>{selected}</output><StationScene allAgents={[...agents, helper]} deck={layoutDecks([team], agents.slice(0, 5), agents)[0]} theme="moonbase" paused={true} scale={0.95} subagents={new Map([['Builder', [helper]]])} pending={pending} onSelect={setSelected} /></div>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`);
let browser;
try {
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5173/.station-update-verification.html');
  await page.locator('.station-work-update').first().waitFor();
  assert.equal(await page.locator('.station-work-update').count(), 6);
  assert.equal(await page.locator('.station-work-update[aria-label^="Idle agent:"]').count(), 0);
  assert.equal(await page.locator('.station-work-update[aria-label^="Needs approval:"]').count(), 0);
  assert.equal(await page.locator('.station-approval').count(), 1);
  assert.equal(await page.locator('.station-work-update[aria-label^="Helper:"]').count(), 1);
  assert.equal(await page.locator('.station-work-update[aria-label^="Team worker:"]').count(), 1);
  await page.getByRole('button', { name: 'Builder: Editing AgentDrawer.tsx. Open conversation', exact: true }).click();
  assert.equal(await page.locator('#selection').textContent(), 'Builder');
  await page.getByRole('button', { name: 'Helper: Reading stationLayout.ts. Open conversation', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#selection').textContent(), 'Helper');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-update', { detail: { id: 'Builder', currentActivity: 'Running npm run build' } })));
  await page.getByRole('button', { name: 'Builder: Running npm run build. Open conversation', exact: true }).waitFor();
  const boxes = await page.locator('.station-work-paper').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }; }));
  for (let i = 0; i < boxes.length; i++) for (const b of boxes.slice(i + 1)) {
    const a = boxes[i];
    assert.ok(!(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top), 'Activity bubbles do not overlap');
  }
  const figures = await page.locator('.station-bot .crew-avatar, .team-seat .crew-avatar, .subagent-mini .crew-avatar, .station-nameplate rect, .team-plate > rect:first-child').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }; }));
  for (const a of boxes) for (const b of figures) assert.ok(!(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top), 'Updates leave crew and nameplates visible');
  await page.screenshot({ path: resolve(captures, 'station-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.workbench-content').evaluate(node => { node.scrollLeft = 220; node.scrollTop = 80; });
  assert.ok((await page.locator('.station-work-paper').first().boundingBox()).width > 160, 'Bubbles stay readable in the pannable mobile scene');
  await page.screenshot({ path: resolve(captures, 'station-mobile.png'), fullPage: true });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-update', { detail: { id: 'Builder', status: 'idle' } })));
  await page.locator('.station-work-update[aria-label^="Builder:"]').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('PASS station updates: real activity, live changes, idle suppression, approval priority, subagents, teams, bubble separation, click and keyboard navigation, mobile readability');
} finally {
  if (browser) await browser.close();
  rmSync(html, { force: true });
  rmSync(fixture, { force: true });
}
