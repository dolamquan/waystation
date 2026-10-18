import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { parseDaemonInfo, isFreshDaemonInfo, forwardRedacted } from '../scripts/waystation.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @typedef {{port: number, token: string, pid: number, startedAt: number, dev: boolean}} DaemonInfo */

export function supportsNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return Boolean(match && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 20)));
}

export function verifyNode(nodePath) {
  if (!nodePath || !isAbsolute(nodePath)) throw new Error('Launch with npm run desktop so Waystation can locate Node.js.');
  let raw;
  try {
    raw = execFileSync(nodePath, ['-p', 'JSON.stringify({version:process.version,electron:!!process.versions.electron})'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  } catch { throw new Error('Node.js could not start. Install Node 22.20+ and run npm run desktop again.'); }
  const result = JSON.parse(raw);
  if (result.electron || !supportsNode(result.version)) throw new Error('Waystation needs regular Node.js 22.20 or newer for its daemon and agent tools.');
  return result.version;
}

export function readDaemon(home) {
  try { return parseDaemonInfo(JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'))); }
  catch { return undefined; }
}

export function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export async function requestDaemon(info, route, timeout = 8000) {
  const response = await fetch(`http://127.0.0.1:${info.port}${route}`, { headers: { 'x-tower-token': info.token }, signal: AbortSignal.timeout(timeout), redirect: 'error' });
  if (!response.ok) throw new Error(`Waystation's daemon returned HTTP ${response.status}.`);
  return response.json();
}

export async function probeDaemon(info) {
  try {
    const health = await requestDaemon(info, '/api/health', 1500);
    return health.app === 'waystation' && health.pid === info.pid && health.startedAt === info.startedAt;
  } catch { return false; }
}

export class DesktopRuntime {
  /** @type {import('node:child_process').ChildProcess | undefined} */
  child = undefined;
  /** @type {DaemonInfo | undefined} */
  info = undefined;
  stopping = false;
  /** @type {(code: number | null) => void} */
  onExit = () => {};

  constructor({ projectRoot, nodePath, home, env }) {
    this.projectRoot = projectRoot;
    this.nodePath = nodePath;
    this.home = home;
    this.env = env;
  }

  get owned() { return Boolean(this.child && Number.isInteger(this.child.pid) && this.child.exitCode === null && this.child.signalCode === null); }

  /** @returns {Promise<DaemonInfo>} */
  async start() {
    const existing = readDaemon(this.home);
    if (existing && pidIsAlive(existing.pid)) {
      if (!await probeDaemon(existing)) throw new Error('A Waystation daemon is running but could not be authenticated. Stop it in its terminal and try again. Older versions need a restart.');
      this.info = existing;
      return existing;
    }
    this.stopping = false;
    const launchedAt = Date.now();
    const child = spawn(this.nodePath, ['--import', 'tsx', join(this.projectRoot, 'daemon', 'index.ts')], {
      cwd: this.projectRoot, env: { ...this.env, AGENT_TOWER_HOME: this.home },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    this.child = child;
    let spawnError;
    child.on('error', (error) => { spawnError = error; if (!child.pid && this.child === child) this.child = undefined; });
    forwardRedacted(child.stdout, process.stdout);
    forwardRedacted(child.stderr, process.stderr);
    child.once('exit', (code) => {
      const unexpected = !this.stopping && Boolean(this.info);
      if (this.child === child) { this.child = undefined; this.info = undefined; }
      if (unexpected) this.onExit(code);
    });
    for (const deadline = Date.now() + 60000; Date.now() < deadline;) {
      if (spawnError) throw new Error(`Could not start the daemon: ${spawnError.message}`);
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('The Waystation daemon exited during startup. Check the terminal output or docs/desktop.md.');
      const info = readDaemon(this.home);
      if (isFreshDaemonInfo(info, { launchedAt, pid: child.pid }) && await probeDaemon(info)) {
        this.info = info;
        return info;
      }
      await pause(150);
    }
    await this.stop();
    throw new Error('The daemon did not become ready within 60 seconds. Check the port and Node version, then try again.');
  }

  async stop(timeout = 20000) {
    const child = this.child;
    // A terminal-started daemon belongs to its terminal, not this window.
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.stopping = true;
    await new Promise((resolve, reject) => {
      const send = () => { if (child.connected) child.send({ type: 'waystation:shutdown' }, (error) => { if (error && child.connected) child.disconnect(); }); };
      const retry = setInterval(send, 200);
      const done = () => { clearTimeout(timer); clearInterval(retry); resolve(); };
      const timer = setTimeout(() => { clearInterval(retry); child.off('exit', done); reject(new Error('The daemon is still shutting down. Wait and try Quit again.')); }, timeout);
      child.once('exit', done);
      send();
    });
  }

  forceStop() {
    if (!this.owned) return;
    this.stopping = true;
    // Only the process we created, including its children. Never a reused/adopted PID.
    execFileSync('taskkill.exe', ['/T', '/F', '/PID', String(this.child.pid)], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
  }
}
