import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { stopProcessTree } from '../actions/kill.ts';
import { UserError } from '../userError.ts';
import { detectPreview } from './detect.ts';
import { serveStaticSite, type StaticSite } from './staticServer.ts';
import type { PreviewPlan, PreviewStatus, PreviewView, ScriptRunner } from './types.ts';

/** More than this many apps running at once slows the machine down for little benefit. */
export const MAX_RUNNING_PREVIEWS = 4;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const START_TIMEOUT_MS = 2 * 60_000;
const PORT_PROBE_MS = 1000;
const LOG_LINES = 80;
const LOG_LINE_CHARS = 300;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const LOOPBACK_URL = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})(\/[\w\-./%~]*)?/i;

export const stripAnsi = (text: string): string => text.replace(ANSI, '');

/** The first loopback address a dev server prints ("Local: http://localhost:5173/"), made browsable. */
export function findLoopbackUrl(line: string): string | undefined {
  const match = LOOPBACK_URL.exec(stripAnsi(line));
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return undefined;
  const host = match[1].toLowerCase() === '127.0.0.1' ? '127.0.0.1' : 'localhost';
  return `http://${host}:${port}${match[3] ?? '/'}`;
}

export type RunnerSpawn = (runner: ScriptRunner, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;

/** Runner and arguments come only from detectPreview's fixed set, so the cmd line has no outside input. */
const defaultSpawn: RunnerSpawn = (runner, args, cwd, env) => process.platform === 'win32'
  ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [runner, ...args].join(' ')], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(runner, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

export interface PreviewManagerOptions {
  readonly spawnRunner?: RunnerSpawn;
  readonly startTimeoutMs?: number;
  readonly now?: () => number;
}

interface Entry {
  readonly folder: string;
  run: number;
  status: PreviewStatus;
  plan: PreviewPlan;
  url?: string;
  error?: string;
  log: string[];
  startedAt?: number;
  child?: ChildProcess;
  site?: StaticSite;
  timers: NodeJS.Timeout[];
}

const ACTIVE: ReadonlySet<PreviewStatus> = new Set(['installing', 'starting', 'running']);

function freePort(): Promise<number> {
  return new Promise((done, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
}

function portAnswers(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => done(false));
    socket.once('timeout', () => { socket.destroy(); done(false); });
  });
}

async function endProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') await stopProcessTree(child.pid).catch(() => undefined);
  else child.kill();
}

/** One live preview per project folder, shared by every agent working in it. */
export class PreviewManager {
  private readonly entries = new Map<string, Entry>();
  private readonly spawnRunner: RunnerSpawn;
  private readonly startTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: PreviewManagerOptions = {}) {
    this.spawnRunner = options.spawnRunner ?? defaultSpawn;
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  view(cwd: string | undefined): PreviewView {
    const entry = cwd ? this.entries.get(this.key(cwd)) : undefined;
    if (!entry || !ACTIVE.has(entry.status)) {
      return { folder: cwd ?? '', status: entry?.status ?? 'idle', plan: detectPreview(cwd), error: entry?.error, log: entry?.log ?? [] };
    }
    return { folder: entry.folder, status: entry.status, plan: entry.plan, url: entry.url, error: entry.error, log: entry.log, startedAt: entry.startedAt };
  }

  async start(cwd: string | undefined): Promise<PreviewView> {
    const plan = detectPreview(cwd);
    if (!cwd || plan.kind === 'none') throw new UserError(plan.kind === 'none' ? plan.reason : 'No project folder was recorded for this session.');
    const existing = this.entries.get(this.key(cwd));
    if (existing && ACTIVE.has(existing.status)) return this.view(cwd);
    if ([...this.entries.values()].filter((entry) => ACTIVE.has(entry.status)).length >= MAX_RUNNING_PREVIEWS) {
      throw new UserError(`${MAX_RUNNING_PREVIEWS} previews are already running. Stop one before starting another.`);
    }
    const entry: Entry = { folder: cwd, run: (existing?.run ?? 0) + 1, status: 'starting', plan, log: [], startedAt: this.now(), timers: [] };
    this.entries.set(this.key(cwd), entry);
    if (plan.kind === 'static') await this.startStatic(entry, plan.root);
    else void this.startScript(entry, plan);
    return this.view(cwd);
  }

  async stop(cwd: string | undefined): Promise<PreviewView> {
    const entry = cwd ? this.entries.get(this.key(cwd)) : undefined;
    if (entry) await this.halt(entry, 'idle');
    return this.view(cwd);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.halt(entry, 'idle')));
  }

  private key(cwd: string): string {
    const full = resolve(cwd);
    return process.platform === 'win32' ? full.toLowerCase() : full;
  }

  private async halt(entry: Entry, status: PreviewStatus, error?: string): Promise<void> {
    entry.run += 1;
    entry.timers.forEach(clearTimeout);
    entry.timers = [];
    const { child, site } = entry;
    entry.child = undefined;
    entry.site = undefined;
    entry.status = status;
    entry.error = error;
    entry.url = undefined;
    await Promise.all([endProcess(child), site?.close()]);
  }

  private async startStatic(entry: Entry, root: string): Promise<void> {
    try {
      entry.site = await serveStaticSite(root);
      entry.url = entry.site.url;
      entry.status = 'running';
    } catch (error) {
      entry.status = 'failed';
      entry.error = `Couldn’t open the website: ${(error as Error).message}`;
    }
  }

  private async startScript(entry: Entry, plan: Extract<PreviewPlan, { kind: 'script' }>): Promise<void> {
    const run = entry.run;
    if (plan.needsInstall) {
      entry.status = 'installing';
      const installed = await this.install(entry, plan.runner);
      if (entry.run !== run) return;
      if (!installed) {
        await this.halt(entry, 'failed', 'Installing the app’s packages didn’t finish. The details below show what went wrong.');
        return;
      }
      entry.status = 'starting';
    }
    const port = await freePort();
    if (entry.run !== run) return;
    const env = { ...process.env, PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0' };
    const child = this.spawnRunner(plan.runner, ['run', plan.script], entry.folder, env);
    entry.child = child;
    this.follow(entry, child, run, (line) => {
      const url = entry.status === 'starting' ? findLoopbackUrl(line) : undefined;
      if (url) this.markRunning(entry, url);
    });
    child.once('exit', (code) => {
      if (entry.run !== run) return;
      const wasRunning = entry.status === 'running';
      void this.halt(entry, 'failed', wasRunning ? 'Your app stopped on its own.' : `Your app couldn’t start${code ? ` (exit code ${code})` : ''}. The details below show what went wrong.`);
    });
    this.watchPort(entry, run, port);
    entry.timers.push(setTimeout(() => {
      if (entry.run === run && entry.status === 'starting') {
        void this.halt(entry, 'failed', 'The app started but never opened a web page, so there’s nothing to show. It may not be a website.');
      }
    }, this.startTimeoutMs));
  }

  /** Some servers never print their address: notice once the port we offered them answers. */
  private watchPort(entry: Entry, run: number, port: number): void {
    const check = async () => {
      if (entry.run !== run || entry.status !== 'starting') return;
      if (await portAnswers(port)) {
        if (entry.run === run && entry.status === 'starting') this.markRunning(entry, `http://localhost:${port}/`);
        return;
      }
      entry.timers.push(setTimeout(() => void check(), PORT_PROBE_MS));
    };
    entry.timers.push(setTimeout(() => void check(), PORT_PROBE_MS));
  }

  private markRunning(entry: Entry, url: string): void {
    entry.url = url;
    entry.status = 'running';
    entry.error = undefined;
  }

  private install(entry: Entry, runner: ScriptRunner): Promise<boolean> {
    const run = entry.run;
    const child = this.spawnRunner(runner, ['install'], entry.folder, { ...process.env, FORCE_COLOR: '0' });
    entry.child = child;
    this.follow(entry, child, run);
    return new Promise((done) => {
      const timer = setTimeout(() => { void endProcess(child); done(false); }, INSTALL_TIMEOUT_MS);
      child.once('error', () => { clearTimeout(timer); done(false); });
      child.once('exit', (code) => { clearTimeout(timer); done(code === 0); });
    });
  }

  private follow(entry: Entry, child: ChildProcess, run: number, onLine?: (line: string) => void): void {
    const take = (chunk: Buffer) => {
      if (entry.run !== run) return;
      for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
        const line = stripAnsi(raw).trimEnd();
        if (!line.trim()) continue;
        entry.log = [...entry.log, line.slice(0, LOG_LINE_CHARS)].slice(-LOG_LINES);
        onLine?.(line);
      }
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.once('error', (error) => {
      if (entry.run === run) void this.halt(entry, 'failed', `Couldn’t run ${entry.plan.kind === 'script' ? entry.plan.runner : 'the app'}: ${error.message}`);
    });
  }
}
