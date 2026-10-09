// Real Electron verification. Uses isolated profiles and a fake Codex, never a paid agent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron } from 'playwright-core';
import { pidIsAlive, probeDaemon, readDaemon, requestDaemon } from '../desktop/runtime.mjs';
import { redactToken } from './waystation.mjs';

if (process.platform !== 'win32') throw new Error('Desktop verification requires Windows.');
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const runRoot = join(projectRoot, '.desktop-verification', `run-${randomUUID()}`);
mkdirSync(runRoot, { recursive: true });
let source = projectRoot;
const checks = [];
const apps = new Set();
const nativeProcesses = new WeakMap();
let launcher;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label, timeout = 60000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (await predicate()) return;
    await pause(150);
  }
  throw new Error(`Timed out: ${label}`);
}

async function port() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const number = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return String(number);
}

function command(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Verification subprocess exited with code ${code}.`)));
  });
}

function record(name) { checks.push(name); console.log(`PASS ${name}`); }

if (process.argv.includes('--fresh')) {
  source = join(runRoot, 'source clone with spaces');
  const copyOptions = { recursive: true, filter: (file) => {
    const path = relative(projectRoot, file).replaceAll('\\', '/');
    return !/^(node_modules|\.desktop-verification|\.impeccable|coverage)(\/|$)/.test(path) && !/^web\/dist(\/|$)/.test(path) && !/\.log$/.test(path);
  } };
  mkdirSync(source, { recursive: true });
  for (const entry of readdirSync(projectRoot)) {
    const origin = join(projectRoot, entry);
    if (copyOptions.filter(origin)) cpSync(origin, join(source, entry), copyOptions);
  }
  const npm = process.env.npm_execpath;
  if (!npm || !existsSync(npm)) throw new Error('Run fresh verification through npm run desktop:verify -- --fresh.');
  await command(process.execPath, [npm, 'ci', '--no-audit', '--no-fund'], { cwd: source, stdio: 'inherit' });
  record('npm ci in a clean source copy with spaces');
}

const home = join(runRoot, 'user profile with spaces');
const claudeHome = join(home, 'claude sessions');
const codexHome = join(home, 'codex sessions');
const project = join(runRoot, 'sample project');
for (const folder of [home, claudeHome, codexHome, project]) mkdirSync(folder, { recursive: true });
writeFileSync(join(home, 'desktop.json'), JSON.stringify({ setupComplete: false, notifications: false }));
const env = {
  ...process.env, WAYSTATION_NODE: process.execPath, WAYSTATION_DESKTOP_HIDDEN: '1',
  AGENT_TOWER_HOME: home, AGENT_TOWER_PORT: await port(), CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome,
  APPDATA: join(home, 'appdata'), USERPROFILE: join(home, 'user'),
  AGENT_TOWER_CLAUDE_EXE: join(home, 'missing-claude.exe'), AGENT_TOWER_CODEX_JS: join(home, 'missing-codex.js'),
};
delete env.ELECTRON_RUN_AS_NODE;
const electronPath = createRequire(join(source, 'package.json'))('electron');

async function launch(environment = env) {
  const application = await _electron.launch({ executablePath: electronPath, args: [source], cwd: source, env: environment, timeout: 60000 });
  apps.add(application);
  nativeProcesses.set(application, application.process());
  const page = await application.firstWindow();
  page.setDefaultTimeout(60000);
  return { application, page };
}

async function ready(page) {
  await page.getByRole('button', { name: 'Desktop setup', exact: true }).waitFor();
  await until(() => Boolean(readDaemon(home)), 'daemon readiness');
}

async function quit(application, allowActive = true) {
  const closed = new Promise((resolve) => application.once('close', resolve));
  await application.evaluate(({ app, dialog }, allow) => {
    dialog.showMessageBox = async () => ({ response: allow ? 1 : 0, checkboxChecked: false });
    // Let the debugger acknowledge this call before an adopted daemon's fast Quit.
    setTimeout(() => app.quit(), 50);
  }, allowActive);
  if (allowActive) {
    await closed;
    await until(() => !pidIsAlive(nativeProcesses.get(application).pid), 'Electron process exits after Quit');
    apps.delete(application);
  }
}

async function post(info, path, body) {
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-token': info.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200, `POST ${path} failed`);
  return response.json();
}

try {
  let { application, page } = await launch();
  await ready(page);
  await page.getByRole('heading', { name: 'Set up your station' }).waitFor();
  await page.getByRole('button', { name: 'Explore with current settings' }).waitFor();
  await until(() => page.locator('.desktop-checks > li').count().then((count) => count === 6), 'six prerequisite checks');
  const initialInfo = readDaemon(home);
  assert.ok(await probeDaemon(initialInfo));
  const preferences = await page.evaluate(() => window.waystationDesktop.getSettings());
  assert.equal(preferences.version, '0.1.0');
  assert.equal(preferences.ownsDaemon, true);
  const isolation = await page.evaluate(() => ({ node: typeof window.process, require: typeof window.require, bridge: Object.keys(window.waystationDesktop) }));
  assert.equal(isolation.node, 'undefined'); assert.equal(isolation.require, 'undefined');
  assert.deepEqual(isolation.bridge.sort(), ['choosePath', 'getSettings', 'onNavigate', 'saveSettings']);
  const webPreferences = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(webPreferences.nodeIntegration, false); assert.equal(webPreferences.contextIsolation, true); assert.equal(webPreferences.sandbox, true); assert.equal(webPreferences.webSecurity, true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.bringToFront();
  await page.screenshot({ path: join(runRoot, 'setup.png'), fullPage: true, timeout: 15000 });
  record('first-run setup, authenticated daemon, and isolated renderer');

  await page.getByRole('button', { name: 'Explore with current settings' }).click();
  await page.getByRole('heading', { name: 'Your workspace', exact: true }).waitFor();
  assert.equal(JSON.parse(readFileSync(join(home, 'desktop.json'), 'utf8')).setupComplete, true);
  await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await page.getByRole('button', { name: 'Browse', exact: true }).click();
  await until(async () => (await page.getByLabel('Project folder (absolute path)', { exact: true }).inputValue()) === project, 'native picker updates the project field');
  await until(() => page.getByRole('radio', { name: /^Codex/ }).isDisabled(), 'missing Codex disabled');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  record('native project folder bridge and missing optional Codex');

  const rejection = await page.evaluate(async () => {
    try { await window.waystationDesktop.choosePath('arbitrary'); return false; } catch { return true; }
  });
  assert.equal(rejection, true);
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.location.href = "file:///C:/Windows/win.ini"').catch(() => {}); });
  await pause(250);
  assert.equal(await page.getByRole('heading', { name: 'Your workspace', exact: true }).isVisible(), true);
  record('invalid native actions and filesystem navigation rejected');

  await page.getByRole('button', { name: 'Desktop setup', exact: true }).click();
  await page.getByText('Custom session and executable paths', { exact: true }).click();
  const fakeCodex = join(source, 'tests', 'fixtures', 'fake-codex.mjs');
  await page.getByLabel('Codex CLI entry', { exact: true }).fill(fakeCodex);
  await page.getByRole('button', { name: 'Save paths & restart', exact: true }).click();
  await until(() => Boolean(readDaemon(home)?.pid !== initialInfo.pid && readDaemon(home)?.pid), 'daemon restart after preferences');
  await page.getByRole('heading', { name: 'Your workspace', exact: true }).waitFor();
  await ready(page);
  let info = readDaemon(home);
  assert.ok(!pidIsAlive(initialInfo.pid));
  assert.equal((await page.evaluate(() => window.waystationDesktop.getSettings())).paths.codexJs, fakeCodex);
  record('custom CLI path applied through a graceful daemon restart');

  const template = await post(info, '/api/templates', { label: 'Desktop verification', vendor: 'codex', prompt: 'Fixture only', intercept: false });
  const managed = await post(info, '/api/managed', { vendor: 'codex', cwd: project, prompt: 'SLOW desktop verification', name: 'Verification agent' });
  await until(async () => (await requestDaemon(info, '/api/state')).agents.some((agent) => agent.id === managed.agent.id), 'fixture agent visible');
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(900, 700); BrowserWindow.getAllWindows()[0].close(); });
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert.ok(await probeDaemon(info));
  await command(electronPath, [source], { cwd: source, env, stdio: 'ignore' });
  assert.equal(readDaemon(home).pid, info.pid);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await page.screenshot({ path: join(runRoot, 'station-900.png'), fullPage: true, timeout: 15000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false);
  record('close to tray, live agent preservation, duplicate launch, and 900px layout');

  await application.evaluate(({ Notification }) => {
    globalThis.desktopVerificationNotifications = 0;
    Notification.isSupported = () => true;
    Notification.prototype.show = function () { globalThis.desktopVerificationNotifications += 1; };
  });
  await page.evaluate(async () => {
    const settings = await window.waystationDesktop.getSettings();
    await window.waystationDesktop.saveSettings({ ...settings, notifications: true });
  });
  const session = '11111111-2222-3333-4444-555555555555';
  mkdirSync(join(home, 'intercept'), { recursive: true }); writeFileSync(join(home, 'intercept', session), '1');
  const held = post(info, '/hook/pretooluse', { session_id: session, tool_name: 'Bash', tool_input: { command: 'echo verification' } });
  await until(async () => (await requestDaemon(info, '/api/state')).pending.length > 0, 'held approval');
  await until(async () => (await application.evaluate(() => globalThis.desktopVerificationNotifications)) > 0, 'native attention notification');
  record('attention notification generated from a real held tool decision');

  await quit(application, false); await pause(250);
  assert.ok(await probeDaemon(info));
  assert.equal((await requestDaemon(info, '/api/state')).pending.length, 1);
  record('canceling Quit keeps active work and approvals running');
  await quit(application);
  assert.equal((await held).behavior, 'ask');
  assert.ok(!existsSync(join(home, 'intercept', session)));
  assert.ok(!existsSync(join(home, 'daemon.lock')));
  assert.ok(!readDaemon(home));
  assert.ok(!pidIsAlive(info.pid));
  record('Quit releases held decisions, clears flags, and stops the owned daemon');

  ({ application, page } = await launch());
  await ready(page); await page.getByRole('heading', { name: 'Your workspace', exact: true }).waitFor();
  assert.ok(!await page.getByRole('heading', { name: 'Set up your station' }).count());
  assert.deepEqual(await application.evaluate(({ BrowserWindow }) => { const { width, height } = BrowserWindow.getAllWindows()[0].getNormalBounds(); return { width, height }; }), { width: 900, height: 700 });
  info = readDaemon(home);
  assert.ok((await requestDaemon(info, '/api/templates')).templates.some((entry) => entry.id === template.template.id));
  record('onboarding, window size, CLI preferences, and database persist across restarts');

  // Renderer failure should reload its window without shutting down the daemon.
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  const recoveredWindow = application.waitForEvent('window');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  page = await recoveredWindow;
  page.setDefaultTimeout(60000);
  await ready(page);
  await page.getByRole('heading', { name: 'Your workspace', exact: true }).waitFor();
  assert.equal(readDaemon(home).pid, info.pid);
  record('renderer crash recovery preserves the running daemon');
  await quit(application);

  // Attach to a daemon launched outside Electron, then quit without stopping it.
  const { DesktopRuntime } = await import('../desktop/runtime.mjs');
  const external = new DesktopRuntime({ projectRoot: source, nodePath: process.execPath, home, env: { ...env, AGENT_TOWER_CODEX_JS: fakeCodex } });
  try {
    const externalInfo = await external.start();
    ({ application, page } = await launch()); await ready(page);
    assert.equal((await page.evaluate(() => window.waystationDesktop.getSettings())).ownsDaemon, false);
    assert.equal(readDaemon(home).pid, externalInfo.pid);
    await quit(application);
    assert.ok(await probeDaemon(externalInfo));
    record('terminal-owned daemon reused and preserved when desktop quits');
  } finally { await external.stop(); }

  // A daemon failure offers recovery; restarting must produce a fresh authenticated instance.
  ({ application, page } = await launch()); await ready(page);
  const failedInfo = readDaemon(home);
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  process.kill(failedInfo.pid);
  await until(() => Boolean(readDaemon(home)?.pid && readDaemon(home).pid !== failedInfo.pid), 'daemon crash recovery');
  await page.getByRole('heading', { name: 'Your workspace', exact: true }).waitFor();
  assert.ok(await probeDaemon(readDaemon(home)));
  record('daemon crash recovery and stale lock recovery');
  await quit(application);

  // Exercise the exact Node launcher and the graceful handler used for Ctrl+C.
  launcher = spawn(process.execPath, [join(source, 'scripts', 'desktop.mjs')], {
    cwd: source, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let launcherOutput = '';
  for (const stream of [launcher.stdout, launcher.stderr]) stream.on('data', (chunk) => {
    launcherOutput = redactToken((launcherOutput + chunk.toString()).slice(-4000));
  });
  let launcherError;
  launcher.once('error', (error) => { launcherError = error; });
  await until(async () => {
    if (launcherError) throw launcherError;
    if (launcher.exitCode !== null) throw new Error(`Desktop launcher exited early (${launcher.exitCode}). ${launcherOutput}`);
    const launchedInfo = readDaemon(home);
    return Boolean(launchedInfo && await probeDaemon(launchedInfo));
  }, 'Node launcher starts an authenticated desktop daemon');
  const launchedInfo = readDaemon(home);
  launcher.send({ type: 'waystation:quit' });
  await until(() => !pidIsAlive(launchedInfo.pid) && !existsSync(join(home, 'daemon.lock')) && launcher.exitCode !== null, 'launcher Quit shuts down the desktop-owned daemon');
  launcher = undefined;
  record('npm desktop launcher starts successfully and its graceful quit handler cleans up');

  writeFileSync(join(runRoot, 'result.json'), JSON.stringify({ passed: checks, screenshots: ['setup.png', 'station-900.png'], isolatedUserProfile: true, freshInstall: process.argv.includes('--fresh') }, null, 2));
  console.log(`Desktop verification passed (${checks.length} checks). Artifacts: ${relative(projectRoot, runRoot)}`);
} catch (error) {
  for (const application of apps) {
    try {
      const page = await application.firstWindow();
      writeFileSync(join(runRoot, 'failure-accessibility.txt'), await page.locator('body').ariaSnapshot({ timeout: 5000 }));
    } catch { /* startup failure may not have a live window */ }
  }
  console.error(`Verification details: ${relative(projectRoot, runRoot)}`);
  throw new Error(redactToken(error instanceof Error ? error.message : String(error)));
} finally {
  if (launcher && launcher.exitCode === null) launcher.kill();
  for (const application of apps) {
    try { await quit(application); } catch { nativeProcesses.get(application)?.kill(); }
  }
}
