#!/usr/bin/env node
// One-command start for Waystation: build the UI if needed, start the daemon,
// wait until it is ready, then open the browser straight into the workspace.
// Usage: waystation [--no-open]   (or `npm start`, `npm start -- --no-open`)
import { spawn, execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_WEB_PORT = 5173;
const READY_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
const PROBE_TIMEOUT_MS = 1_500;
const FORCE_STOP_MS = 10_000;
/** Daemon clocks and ours are the same machine; allow a little slack for rounding. */
const CLOCK_SLACK_MS = 2_000;

// ---------------------------------------------------------------------------
// Pure helpers (unit tested in tests/launcher.test.ts)
// ---------------------------------------------------------------------------

/** @param {readonly string[]} argv */
export function parseLauncherArgs(argv) {
  return { open: !argv.includes('--no-open') };
}

/**
 * The UI needs a build when there is no dist yet, or a source file is newer than it.
 * @param {number | undefined} distMtime newest mtime under web/dist (undefined when missing)
 * @param {number | undefined} srcMtime newest mtime under web/src
 */
export function needsBuild(distMtime, srcMtime) {
  if (distMtime === undefined) return true;
  if (srcMtime === undefined) return false;
  return srcMtime > distMtime;
}

/**
 * Validates the shape of daemon.json. Returns undefined for anything unusable.
 * @param {unknown} raw
 * @returns {{ port: number, token: string, pid: number, startedAt: number, dev: boolean } | undefined}
 */
export function parseDaemonInfo(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const info = /** @type {Record<string, unknown>} */ (raw);
  const { port, token, pid, startedAt } = info;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  if (typeof token !== 'string' || !/^[A-Fa-f0-9]+$/.test(token)) return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined;
  return { port, token, pid, startedAt, dev: info.dev === true };
}

/**
 * True when daemon.json was written by the daemon we just launched, not left over from an old run.
 * @param {ReturnType<typeof parseDaemonInfo>} info
 * @param {{ launchedAt: number, pid?: number }} launch
 */
export function isFreshDaemonInfo(info, launch) {
  if (!info) return false;
  if (info.startedAt < launch.launchedAt - CLOCK_SLACK_MS) return false;
  return launch.pid === undefined || info.pid === launch.pid;
}

/**
 * The link the browser opens. `autostart=1` tells the UI to skip the welcome screen.
 * @param {{ port: number, token: string, dev: boolean }} info
 */
export function buildUiUrl(info) {
  const port = info.dev ? DEV_WEB_PORT : info.port;
  return `http://127.0.0.1:${port}/#token=${info.token}&autostart=1`;
}

/** Hides any access token in text before it reaches the console. @param {string} text */
export function redactToken(text) {
  return text.replace(/token=[A-Fa-f0-9]+/g, 'token=<hidden>');
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

export function towerHome() {
  return process.env.AGENT_TOWER_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'agent-tower');
}

function readDaemonInfo() {
  try {
    return parseDaemonInfo(JSON.parse(readFileSync(join(towerHome(), 'daemon.json'), 'utf8')));
  } catch {
    return undefined;
  }
}

/** Newest mtime of any file under dir, or undefined when dir is missing or empty. @param {string} dir */
function newestMtime(dir) {
  if (!existsSync(dir)) return undefined;
  let newest;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const mtime = statSync(join(entry.parentPath, entry.name)).mtimeMs;
    if (newest === undefined || mtime > newest) newest = mtime;
  }
  return newest;
}

/** Newest mtime of a build input, whether it is a folder or a single file. @param {string} path */
function newestInputMtime(path) {
  if (!existsSync(path)) return undefined;
  return statSync(path).isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
}

/** @param {number} pid */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/** Any HTTP answer on the port counts: we only need to know the daemon is listening. @param {number} port */
async function portAnswers(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

/** @param {string} url */
function openBrowser(url) {
  const [command, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  console.log('Opening Waystation in your browser…');
  execFile(command, args, (error) => {
    if (error) console.error('Could not open a browser automatically. Run `npm run open` to try again.');
  });
}

/** @param {string} script @param {string[]} args */
function runNode(script, args, nodePath = process.execPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [script, ...args], { cwd: PROJECT_ROOT, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`exited with code ${code}`))));
  });
}

export async function buildUiIfNeeded(nodePath = process.execPath) {
  const distMtime = newestMtime(join(PROJECT_ROOT, 'web', 'dist'));
  // The UI bundle also pulls in shared/ and is shaped by its page and build config.
  const inputs = [join(PROJECT_ROOT, 'web', 'src'), join(PROJECT_ROOT, 'shared'), join(PROJECT_ROOT, 'web', 'index.html'), join(PROJECT_ROOT, 'vite.config.ts'), join(PROJECT_ROOT, 'package.json')];
  const srcMtimes = inputs.map(newestInputMtime).filter((mtime) => mtime !== undefined);
  const srcMtime = srcMtimes.length ? Math.max(...srcMtimes) : undefined;
  if (!needsBuild(distMtime, srcMtime)) return;
  console.log('Building the Waystation UI…');
  await runNode(join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), ['build'], nodePath);
}

/** Pipes a child stream to ours line by line, hiding the access token. @param {NodeJS.ReadableStream} input @param {NodeJS.WritableStream} output */
export function forwardRedacted(input, output) {
  createInterface({ input }).on('line', (line) => output.write(`${redactToken(line)}\n`));
}

function startDaemon() {
  // `node --import tsx` keeps the daemon in this exact process, so its pid matches daemon.json
  // and Ctrl+C reaches it directly. No shell is involved, which avoids .cmd shims on Windows.
  const child = spawn(process.execPath, ['--import', 'tsx', join('daemon', 'index.ts')], {
    cwd: PROJECT_ROOT,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  forwardRedacted(child.stdout, process.stdout);
  forwardRedacted(child.stderr, process.stderr);
  return child;
}

/** @param {import('node:child_process').ChildProcess} child @param {number} launchedAt */
async function waitForDaemon(child, launchedAt) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return undefined;
    const info = readDaemonInfo();
    if (isFreshDaemonInfo(info, { launchedAt, pid: child.pid })) return info;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return undefined;
}

/** Ctrl+C stops the daemon cleanly: it removes daemon.json and releases every Intercept. @param {import('node:child_process').ChildProcess} child */
function forwardStopSignals(child) {
  let stopping = false;
  /** @param {NodeJS.Signals} signal */
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log('Stopping Waystation…');
    // On Windows the console already delivers Ctrl+C to the daemon (same console), and
    // child.kill() would terminate it without cleanup. Elsewhere, forward the signal.
    if (process.platform !== 'win32' || signal !== 'SIGINT') child.kill(signal);
    setTimeout(() => child.kill('SIGKILL'), FORCE_STOP_MS).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

async function main() {
  const { open } = parseLauncherArgs(process.argv.slice(2));

  const existing = readDaemonInfo();
  if (existing && isPidAlive(existing.pid) && (await portAnswers(existing.port))) {
    console.log(`Waystation is already running on http://127.0.0.1:${existing.port}`);
    if (open) openBrowser(buildUiUrl(existing));
    return;
  }

  await buildUiIfNeeded();

  const launchedAt = Date.now();
  const child = startDaemon();
  forwardStopSignals(child);
  // 'close' (not 'exit') so the daemon's last log lines are flushed before we leave.
  child.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

  const info = await waitForDaemon(child, launchedAt);
  if (!info) {
    if (child.exitCode === null) {
      console.error('Waystation did not report ready in time. Check the messages above.');
      child.kill();
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Waystation is ready on http://127.0.0.1:${info.port} (Ctrl+C to stop)`);
  if (open) openBrowser(buildUiUrl(info));
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    console.error('Failed to start Waystation:', redactToken(String(error?.message ?? error)));
    process.exit(1);
  });
}
