// Runs a real Claude Code or Codex session handed over from Waystation, in this terminal tab.
// Started by the tower as `launchCli.ts <ticket id> --home <tower folder>`. The ticket (a one-time file
// in the tower's private folder) says what to run, where, and with which secret environment.
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { styleText } from 'node:util';
import { TOWER_HOME, MANAGED_ENV_FLAG } from '../config.ts';
import { takeTicket, type CliTicket } from '../actions/cliHandoffs.ts';
import { flagValue, readDaemonInfo } from './daemonInfo.ts';

const REPORT_TIMEOUT_MS = 5000;
const CONFIRM_ATTEMPTS = 4;
const CONFIRM_RETRY_MS = 1500;

function fail(message: string): never {
  process.stderr.write(`${styleText('red', message)}\n`);
  process.exit(1);
}

/** Tell the tower about this session. Re-reads daemon.json each time: the tower may have restarted. */
async function report(home: string, path: string, body: unknown): Promise<boolean> {
  const info = readDaemonInfo(home);
  if (!info) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tower-token': info.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The CLI must not start unless the tower knows about it: otherwise the tower could later hand the same
 * session back to the team while it is still open here, and two copies would run.
 */
async function confirmStart(home: string, path: string): Promise<boolean> {
  for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt += 1) {
    if (await report(home, `${path}/started`, { pid: process.pid })) return true;
    if (attempt < CONFIRM_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, CONFIRM_RETRY_MS));
  }
  return false;
}

function run(ticket: CliTicket, onSpawn: (pid: number) => void): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...ticket.env };
  // This is the operator's own session: the tower's hooks should see it like any other.
  delete env[MANAGED_ENV_FLAG];
  return new Promise((resolve) => {
    const child = spawn(ticket.command, [...ticket.args], { cwd: ticket.cwd, env, stdio: 'inherit' });
    child.once('spawn', () => { if (child.pid) onSpawn(child.pid); });
    child.once('error', (error) => {
      process.stderr.write(`${styleText('red', `Could not start ${basename(ticket.command)}: ${error.message}`)}\n`);
      resolve(1);
    });
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const home = flagValue(argv, '--home') ?? TOWER_HOME;
  const ticketId = argv[0] ?? '';
  let ticket: CliTicket;
  try {
    ticket = takeTicket(join(home, 'cli-tickets'), ticketId);
  } catch (error) {
    fail((error as Error).message);
  }
  const path = `/api/cli/${ticketId}`;
  if (!(await confirmStart(home, path))) {
    await report(home, `${path}/ended`, {});
    fail('Waystation did not confirm this session, so it was not started. Check that the tower is running, then open it again from Waystation.');
  }
  process.stdout.write(`${styleText('dim', `Waystation: ${basename(ticket.command)} in ${ticket.cwd}. Exit it to hand control back to Waystation.`)}\n`);
  // Ctrl+C belongs to the CLI running in this tab, not to the launcher waiting for it.
  process.on('SIGINT', () => undefined);
  // The CLI's own pid is watched too, so the session stays open even if this launcher is killed.
  const code = await run(ticket, (pid) => { void report(home, `${path}/started`, { pid }); });
  if (!(await report(home, `${path}/ended`, {}))) {
    process.stderr.write(`${styleText('yellow', 'Could not tell Waystation this session ended; it will notice within a few seconds.')}\n`);
  }
  process.exit(code);
}

void main();
