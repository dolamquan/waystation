import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

/** The Vite dev server for this repo; override when 5173 is taken, e.g. TEAMS_VERIFY_URL=http://127.0.0.1:5174 */
const base = process.env.TEAMS_VERIFY_URL ?? 'http://127.0.0.1:5173';
const captures = resolve(import.meta.dirname, '../.impeccable/teams');
mkdirSync(captures, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const now = Date.now();
  const focus = { lead: 'Plan, coordinate and review every branch.', builder: 'Backend endpoints and their tests.', reviewer: 'Accessibility and regression review.' };
  const members = ['lead', 'builder', 'reviewer'].map((name, i) => ({ id: name, name, role: i ? 'worker' : 'lead', vendor: i === 1 ? 'codex' : 'claude', branch: `team/auth/${name}`, worktree: `C:/Worktrees/auth/${name}`, merged: false, agentId: `managed:${name}`, focus: focus[name], spend: { costUsd: 0.42 * (i + 1), turns: 3 + i } }));
  const agents = members.map(member => ({ id: member.agentId, name: member.name, vendor: member.vendor, tier: 'A', status: member.name === 'builder' ? 'waiting' : 'idle', cwd: member.worktree, project: 'Auth', source: 'managed', hooked: false, intercepting: false, canInstruct: true, startedAt: now, lastEventAt: now }));
  const task = (id, title, assignee, status = 'open', note) => ({ id, title, details: '', status, assignee, createdBy: 'lead', updatedAt: now, ...(note ? { note } : {}) });
  const team = {
    id: 'auth', name: 'Authentication update', goal: 'Add secure sign-in and password reset, with accessible forms and regression coverage.',
    status: 'done', summary: 'Compared six approaches and identified two promising options.', outputs: [
      { id: 'report', title: 'Research report', description: 'Findings, alternatives and recommended next steps.', filename: 'report.md', memberId: 'lead', bytes: 90, createdAt: now },
      { id: 'table', title: 'Comparison table', description: 'Approach comparison.', filename: 'comparison.csv', memberId: 'lead', bytes: 50, createdAt: now },
      { id: 'image', title: 'Architecture sketch', description: 'The proposed flow.', filename: 'flow.png', memberId: 'builder', bytes: 100, createdAt: now },
      { id: 'missing', title: 'Unavailable report', description: 'Used to verify error recovery.', filename: 'missing.txt', memberId: 'lead', bytes: 10, createdAt: now },
    ], createdAt: now - 600000, repoRoot: 'C:/Projects/Auth', baseBranch: 'main', members, requirePlanApproval: true,
    tasks: [task('t1', 'Build sign-in endpoint', 'builder'), task('t2', 'Password reset email', 'builder'), task('t3', 'Review keyboard navigation', 'reviewer')],
    budget: { wakesUsed: 12, maxWakes: 40, deadline: now + 3000000 },
    pending: { lead: 1 }, pendingIds: { lead: ['m1'] }, resumeGrant: { wakes: 20, minutes: 30 }, spend: { costUsd: 2.52, turns: 12 },
  };
  const archived = { ...team, id: 'old', name: 'Old spike', status: 'disbanded', archivedAt: now - 60000, tasks: [], pending: {}, pendingIds: {} };
  let teams = [team, archived];
  const log = [
    ...Array.from({ length: 25 }, (_, i) => ({ teamId: 'auth', ts: now - 30000 + i * 1000, actor: 'lead', kind: 'reply', to: 'operator', summary: `Earlier update ${i + 1}: reviewing the implementation and checking progress.` })),
    { teamId: 'auth', ts: now - 4000, actor: 'builder', kind: 'message', to: 'lead', messageId: 'm1', summary: 'The sign-in endpoint is ready. I need the sender address for password resets.' },
    { teamId: 'auth', ts: now - 3000, actor: 'lead', kind: 'reply', to: 'operator', summary: 'The plan has three tasks. Ready for your review.' },
    { teamId: 'auth', ts: now - 2000, actor: 'reviewer', kind: 'reply', to: 'lead', summary: 'Noted, I will start after approval.' },
    { teamId: 'auth', ts: now - 1000, actor: 'builder', kind: 'activity', summary: '⚙ Read auth.ts' },
  ];
  let socket;
  const requests = [];
  const broadcast = () => socket.send(JSON.stringify({ type: 'teams', teams }));
  await page.routeWebSocket('**/ws', ws => { socket = ws; ws.send(JSON.stringify({ type: 'snapshot', agents, pending: [], teams, hooks: { installed: true } })); });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.method() === 'POST' ? request.postDataJSON() ?? {} : undefined;
    if (body) requests.push({ path, body });
    let json = { ok: true };
    if (path.endsWith('/outputs/report')) json = { kind: 'text', mime: 'text/plain;charset=utf-8', data: Buffer.from('# Research findings\n\n**Two approaches** are promising.\n\n<script>window.__outputExecuted = true</script>').toString('base64') };
    if (path.endsWith('/outputs/table')) json = { kind: 'text', mime: 'text/plain;charset=utf-8', data: Buffer.from('Approach,Rating\r\nA,Strong\r\nB,Promising').toString('base64') };
    if (path.endsWith('/outputs/image')) json = { kind: 'image', mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=' };
    if (path.endsWith('/outputs/missing')) { await route.fulfill({ status: 400, json: { error: 'This saved output is unavailable.' } }); return; }
    if (path.endsWith('/log')) json = { entries: path.includes('/auth/') ? log : [] };
    if (path.endsWith('/message')) json = { ok: true, message: 'Queued. The team will receive this on resume.' };
    if (path.endsWith('/diff')) json = { diff: { stat: 'auth.ts | 2 +-', patch: '-old\n+new', truncated: false } };
    if (path.endsWith('/plan/approve')) {
      team.status = 'running';
      team.tasks = [task('t1', team.tasks[0].title, 'builder', 'done'), task('t2', 'Password reset email', 'builder', 'blocked', 'Need the sender address before testing delivery.'), task('t3', 'Review keyboard navigation', 'reviewer', 'in_progress')];
      broadcast();
      json = { ok: true, message: 'Plan approved.' };
    }
    if (/\/tasks\/t\d+$/.test(path)) {
      const id = path.split('/').at(-1);
      team.tasks = team.tasks.map(t => (t.id === id ? { ...t, ...body } : t));
      broadcast();
      json = { ok: true, task: team.tasks.find(t => t.id === id) };
    }
    if (path.endsWith('/auth/tasks')) {
      const created = { ...task(`t${team.tasks.length + 1}`, body.title, body.assignee, body.assignee ? 'in_progress' : 'open'), createdBy: 'operator' };
      team.tasks = [...team.tasks, created];
      broadcast();
      json = { ok: true, task: created };
    }
    if (path.endsWith('/pause')) { team.status = 'paused'; team.statusReason = 'Paused by you.'; broadcast(); }
    if (path.endsWith('/resume')) { team.status = 'running'; team.statusReason = undefined; broadcast(); }
    if (path.endsWith('/old/remove')) { teams = teams.filter(t => t.id !== 'old'); broadcast(); }
    if (path.endsWith('/prerequisites')) json = { prerequisites: [] };
    if (path.endsWith('/sessions')) json = { sessions: [] };
    if (path.includes('/library/notifications')) json = { updates: [], notifications: [], unread: 0 };
    await route.fulfill({ json });
  });
  await page.goto(`${base}/#token=0123456789abcdef0123456789abcdef&autostart=1`);
  await page.getByRole('button', { name: /^Teams/ }).click();
  await page.getByRole('heading', { name: /Authentication update/ }).waitFor();
  await page.getByRole('tab', { name: /Outputs/ }).click();
  const outputs = page.getByRole('region', { name: 'Team outputs', exact: true });
  await outputs.getByRole('heading', { name: 'Team results', exact: true }).waitFor();
  const report = outputs.locator('.team-output-card').filter({ hasText: 'Research report' });
  await report.getByRole('button', { name: 'Preview', exact: true }).click();
  await report.getByRole('heading', { name: 'Research findings', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__outputExecuted), undefined);
  await report.getByRole('link', { name: /Open in new tab/ }).waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), report.getByRole('button', { name: 'Download', exact: true }).click()]);
  assert.equal(download.suggestedFilename(), 'report.md');
  await report.getByRole('button', { name: 'Open containing folder' }).click();
  assert.ok(requests.some(request => request.path.endsWith('/outputs/report/reveal')));
  const image = outputs.locator('.team-output-card').filter({ hasText: 'Architecture sketch' });
  await image.getByRole('button', { name: 'Preview', exact: true }).click();
  await image.getByRole('img').waitFor();
  await page.waitForFunction(() => document.querySelector('.team-output-preview img')?.naturalWidth > 0);
  const table = outputs.locator('.team-output-card').filter({ hasText: 'Comparison table' });
  await table.getByRole('button', { name: 'Preview', exact: true }).click();
  await table.getByRole('columnheader', { name: 'Approach' }).waitFor();
  await table.getByRole('cell', { name: 'Promising', exact: true }).waitFor();
  const missing = outputs.locator('.team-output-card').filter({ hasText: 'Unavailable report' });
  await missing.getByRole('button', { name: 'Preview', exact: true }).click();
  await missing.getByRole('alert').waitFor();
  assert.ok(await missing.getByRole('button', { name: 'Preview', exact: true }).isEnabled());
  const outputsTab = page.getByRole('tab', { name: /Outputs/ });
  await outputsTab.focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.getByRole('tab', { name: /Conversation/ }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowRight');
  assert.equal(await outputsTab.getAttribute('aria-selected'), 'true');
  await outputs.getByRole('button', { name: 'View diff for lead' }).click();
  await page.getByRole('dialog').getByText('auth.ts | 2 +-', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  for (const [name, width] of [['desktop', 1440], ['mobile', 390]]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.screenshot({ path: resolve(captures, `outputs-${name}.png`), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} overflow`);
  }
  assert.deepEqual(errors, []);
  console.log('Team output cards, Markdown/image previews, downloads, folder action, errors, diffs, keyboard tabs and responsive layout verified.');
} finally {
  await browser.close();
}
