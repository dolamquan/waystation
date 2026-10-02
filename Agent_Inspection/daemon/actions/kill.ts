import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Agent } from '../domain/types.ts';
import type { ProcInfo } from '../collectors/processScanner.ts';
import { isPidAlive } from '../collectors/claudeSessions.ts';

const execFileAsync = promisify(execFile);

const AGENT_PROCESS_NAME = /^(claude|codex|aider|gemini|cursor-agent|opencode|goose|node|python|py)(\.exe)?$/i;
const NEVER_KILL = /^(code|code - insiders|cursor|windsurf|explorer|powershell|pwsh|cmd|conhost|windowsterminal)(\.exe)?$/i;
const PROC_START_TOLERANCE_MS = 3000;

/** Windows FILETIME (100ns ticks since 1601) -> epoch ms. */
export function filetimeToMs(filetime: string): number | undefined {
  if (!/^\d+$/.test(filetime)) return undefined;
  return Number(BigInt(filetime) / 10_000n) - 11_644_473_600_000;
}

/** WMI CIM_DATETIME (yyyymmddHHMMSS.ffffff±UUU) -> epoch ms. */
export function wmiDateToMs(value: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})\d*([+-]\d{3})$/.exec(value.trim());
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s, ms, offset] = match;
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms);
  return utc - Number(offset) * 60_000;
}

export interface KillCheck {
  readonly agent: Agent;
  readonly proc: ProcInfo | undefined;
  /** For Claude sessions: the procStart recorded in the session file. */
  readonly expectedProcStart?: string;
}

/** Returns a reason the stop must be refused, or undefined if it is safe. */
export function killRefusal({ agent, proc, expectedProcStart }: KillCheck): string | undefined {
  if (agent.stopBlockedReason) return agent.stopBlockedReason;
  if (!agent.pid || !Number.isInteger(agent.pid) || agent.pid <= 4) return 'This agent has no stoppable process.';
  if (!proc) return 'Process is no longer running.';
  if (proc.pid !== agent.pid) return 'Process id mismatch.';
  if (NEVER_KILL.test(proc.name)) return `Refusing to stop ${proc.name}: it is a host application, not an agent.`;
  if (!AGENT_PROCESS_NAME.test(proc.name)) return `Refusing to stop unexpected process ${proc.name}.`;
  if (expectedProcStart) {
    const expected = filetimeToMs(expectedProcStart);
    const actual = wmiDateToMs(proc.created);
    if (expected !== undefined && actual !== undefined && Math.abs(expected - actual) > PROC_START_TOLERANCE_MS) {
      return 'PID was reused by a different process; refusing to stop it.';
    }
  }
  return undefined;
}

export async function lookupProcess(pid: number): Promise<ProcInfo | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [pscustomobject]@{ pid = $p.ProcessId; ppid = $p.ParentProcessId; name = $p.Name; cmd = [string]$p.CommandLine; created = [string]$p.CreationDate } | ConvertTo-Json -Compress }`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 15_000,
  });
  if (!stdout.trim()) return undefined;
  const r = JSON.parse(stdout) as Record<string, unknown>;
  return {
    pid: Number(r.pid),
    ppid: Number(r.ppid ?? 0),
    name: String(r.name ?? ''),
    commandLine: String(r.cmd ?? ''),
    created: String(r.created ?? ''),
  };
}

/** taskkill the process and its children. */
export async function stopProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 4) throw new Error('invalid pid');
  try {
    await execFileAsync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 15_000 });
  } catch (error) {
    // Already gone (or a child exited mid-kill) is the outcome we wanted.
    if (isPidAlive(pid)) throw error;
  }
}
