import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { FactoryCheck, FactoryEvidence } from '../../shared/factory.ts';
import { redact } from '../domain/text.ts';

/** Commands are authored by the operator and snapshotted before a run; never taken from agent output. */
export function runFactoryCheck(check: FactoryCheck, cwd: string, revision: string, timeoutMs: number, signal: AbortSignal): Promise<FactoryEvidence> {
  const startedAt = Date.now();
  return new Promise(resolve => {
    let output = ''; let timedOut = false; let settled = false;
    const windows = process.platform === 'win32';
    const child = spawn(windows ? 'powershell.exe' : '/bin/sh', windows
      ? ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${check.command}; if (-not $?) { exit 1 }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`]
      : ['-c', check.command], { cwd, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-32_000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const kill = () => {
      if (windows && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const finish = (code: number | null, error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', kill);
      resolve({ id: randomUUID(), name: check.name, command: check.command, revision,
        outcome: timedOut ? 'timed_out' : code === 0 && !signal.aborted && !error ? 'passed' : 'failed',
        output: redact(error ? `${output}\n${error.message}` : output), startedAt, finishedAt: Date.now() });
    };
    signal.addEventListener('abort', kill, { once: true });
    child.on('error', error => finish(null, error)); child.on('close', code => finish(code));
    if (signal.aborted) kill();
  });
}
