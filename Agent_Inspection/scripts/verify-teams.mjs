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
    status: 'plan_review', createdAt: now - 600000, repoRoot: 'C:/Projects/Auth', baseBranch: 'main', members, requirePlanApproval: true,
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
  const baseline = process.argv.includes('--baseline');
  for (const [name, width] of [['desktop', 1440], ['mobile', 390]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({ path: resolve(captures, `${baseline ? 'before' : 'after'}-${name}.png`), fullPage: true });
    if (!baseline) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} overflow`);
  }
  if (!baseline) {
    const posted = suffix => requests.filter(r => r.path.endsWith(suffix));

    // Plan review: drafted tasks with assignees, inline edit, approve.
    const plan = page.getByRole('region', { name: 'Plan ready for review' });
    await plan.getByText('Review keyboard navigation', { exact: true }).waitFor();
    await plan.getByRole('button', { name: 'Edit Build sign-in endpoint' }).click();
    await plan.getByRole('form', { name: 'Edit Build sign-in endpoint' }).getByLabel('Title').fill('Build sign-in endpoint with rate limits');
    await plan.getByRole('button', { name: 'Save task' }).click();
    await plan.getByText('Build sign-in endpoint with rate limits', { exact: true }).waitFor();
    assert.deepEqual(posted('/tasks/t1').at(-1)?.body, { title: 'Build sign-in endpoint with rate limits' });
    await plan.getByRole('button', { name: 'Send feedback to lead' }).click();
    assert.equal(await page.getByLabel('Recipient', { exact: true }).inputValue(), 'lead');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Message', null, { timeout: 2000 });
    await plan.getByRole('button', { name: 'Approve plan' }).click();
    await plan.waitFor({ state: 'detached' });
    assert.equal(posted('/plan/approve').length, 1);

    // Conversation: sender → recipient, queued badge, reply labels, activity hidden.
    await page.getByText('builder → lead', { exact: true }).waitFor();
    await page.getByText('Queued', { exact: true }).waitFor();
    await page.getByText('Reply to you', { exact: true }).first().waitFor();
    await page.getByText('Reply · not sent to teammates', { exact: true }).waitFor();
    assert.equal(await page.getByText('⚙ Read auth.ts').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Show tool activity' }).getAttribute('aria-pressed'), 'false');

    // Chat opens at the bottom, appends chronologically, and preserves deliberate history reading.
    const atBottom = () => page.waitForFunction(() => {
      const node = document.querySelector('.team-log');
      return node.scrollHeight - node.scrollTop - node.clientHeight < 5;
    });
    const publish = (summary, offset) => {
      const entry = { teamId: 'auth', ts: now + offset, actor: 'lead', kind: 'reply', to: 'operator', summary };
      log.push(entry);
      socket.send(JSON.stringify({ type: 'team_log', entry }));
    };
    await atBottom();
    assert.match(await page.locator('.team-log > li').first().innerText(), /Earlier update 1:/);
    publish('Newest reply at the bottom', 1);
    await page.getByText('Newest reply at the bottom', { exact: true }).waitFor();
    assert.match(await page.locator('.team-log > li').last().innerText(), /Newest reply at the bottom/);
    await atBottom();
    await page.locator('.team-log').evaluate(node => { node.scrollTop = 100; });
    await page.getByRole('button', { name: 'Latest messages' }).waitFor();
    publish('Another reply while reading history', 2);
    await page.getByText('Another reply while reading history', { exact: true }).waitFor();
    assert.equal(await page.locator('.team-log').evaluate(node => node.scrollTop), 100);
    await page.getByRole('button', { name: 'Latest messages' }).click();
    await atBottom();
    await page.getByRole('tab', { name: /Task board/ }).click();
    publish('Reply received on the task tab', 3);
    await page.getByRole('tab', { name: /Conversation/ }).click();
    await atBottom();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await atBottom();
      await page.screenshot({ path: resolve(captures, `chat-${width}.png`), fullPage: true });
    }

    // Task board: attention shortcut, merge guard, operator-added task.
    await page.getByRole('tab', { name: /Task board/ }).click();
    await page.getByRole('region', { name: 'Team needs attention' }).getByRole('button', { name: 'Help unblock' }).click();
    assert.equal(await page.getByLabel('Recipient', { exact: true }).inputValue(), 'builder');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Message', null, { timeout: 2000 });
    assert.ok(await page.locator('.team-member').filter({ hasText: 'builder' }).getByRole('button', { name: 'Merge work' }).isDisabled());
    await page.getByRole('tab', { name: /Task board/ }).click();
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    const newTask = page.getByRole('form', { name: 'New task' });
    await newTask.getByLabel('Title').fill('Document the reset flow');
    await newTask.getByLabel('Assignee').selectOption('reviewer');
    await newTask.getByRole('button', { name: 'Add task' }).click();
    await page.getByRole('heading', { name: 'Document the reset flow' }).waitFor();
    assert.deepEqual(posted('/auth/tasks').at(-1)?.body, { title: 'Document the reset flow', assignee: 'reviewer' });

    // Send queues while paused; Send & resume also resumes and says what it adds.
    await page.getByRole('button', { name: 'Pause team', exact: true }).click();
    await page.getByRole('tab', { name: /Conversation/ }).click();
    await page.getByLabel('Recipient', { exact: true }).selectOption('all');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Use support@example.test as the sender');
    await page.getByText('Resuming adds +20 turns, +30 min.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByText('Queued. The team will receive this on resume.', { exact: true }).first().waitFor();
    assert.equal(posted('/resume').length, 0);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Everyone say hi');
    await page.getByRole('button', { name: 'Send & resume', exact: true }).click();
    await page.getByRole('button', { name: 'Pause team', exact: true }).waitFor();
    assert.ok(posted('/message').some(r => r.body.text === 'Everyone say hi' && r.body.to === 'all'));
    assert.equal(posted('/resume').length, 1);

    // Diff, merge-all explanation.
    await page.getByRole('button', { name: 'View changes', exact: true }).first().click();
    await page.getByText('auth.ts | 2 +-', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Merge all', exact: true }).click();
    await page.getByText(/workers first.*then the lead.*stops there/).waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Archived teams: listed separately, read-only, removable.
    await page.getByText('Archived', { exact: true }).click();
    await page.getByRole('button', { name: /Old spike/ }).click();
    await page.getByRole('heading', { name: /Old spike/ }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Add task', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Remove from list', exact: true }).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('heading', { name: /Authentication update/ }).waitFor();
    assert.equal(posted('/old/remove').length, 1);
  }
  assert.deepEqual(errors, []);
  console.log(`Team ${baseline ? 'baseline captured' : 'UI workflows passed'}: desktop and mobile.`);
} finally { await browser.close(); }
