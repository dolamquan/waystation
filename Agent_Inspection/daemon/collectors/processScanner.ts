import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProcInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly commandLine: string;
  /** Raw WMI creation date string, used to detect PID reuse. */
  readonly created: string;
}

export interface ObservedProcess {
  readonly pid: number;
  readonly vendor: 'codex' | 'other';
  readonly label: string;
}

const AGENT_FILTER = String.raw`$_.Name -match '^(codex|claude|aider|gemini|cursor-agent|opencode|goose)' -or $_.CommandLine -match 'aider|gemini-cli|@google[\\/]gemini|opencode|goose|cursor-agent|@openai[\\/]codex'`;

const PS_SCRIPT = [
  `$p = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and (${AGENT_FILTER}) }`,
  `@($p | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = [string]$_.CommandLine; created = [string]$_.CreationDate } }) | ConvertTo-Json -Compress -Depth 2`,
].join('; ');

export async function scanProcesses(): Promise<ProcInfo[]> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
    { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return parseProcessJson(stdout);
}

export function parseProcessJson(stdout: string): ProcInfo[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    const r = row as Record<string, unknown>;
    if (typeof r.pid !== 'number') return [];
    return [{
      pid: r.pid,
      ppid: typeof r.ppid === 'number' ? r.ppid : 0,
      name: String(r.name ?? ''),
      commandLine: String(r.cmd ?? ''),
      created: String(r.created ?? ''),
    }];
  });
}

const OTHER_AGENTS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /aider/i, label: 'Aider' },
  { pattern: /gemini/i, label: 'Gemini CLI' },
  { pattern: /cursor-agent/i, label: 'Cursor Agent' },
  { pattern: /opencode/i, label: 'OpenCode' },
  { pattern: /goose/i, label: 'Goose' },
];

/** Shells whose command line merely mentions an agent name (e.g. grep/scan commands) are not agents. */
const SHELL_NAMES = /^(powershell|pwsh|cmd|bash|sh|wsl|conhost)(\.exe)?$/i;

const isExtensionHosted =(proc: ProcInfo): boolean => /[\\/]\.vscode[\\/]extensions[\\/]/i.test(proc.commandLine);
const isCodexBackend = (proc: ProcInfo): boolean =>
  /app-server|code-mode-host/i.test(`${proc.name} ${proc.commandLine}`) || isExtensionHosted(proc);

/** Standalone agent processes not covered by a richer collector. Children of matched parents are folded in. */
export function classifyObserved(procs: readonly ProcInfo[]): ObservedProcess[] {
  const matched = procs.flatMap((proc): ObservedProcess[] => {
    if (/^codex/i.test(proc.name)) {
      return isCodexBackend(proc) ? [] : [{ pid: proc.pid, vendor: 'codex', label: 'Codex CLI' }];
    }
    if (/^claude/i.test(proc.name) || SHELL_NAMES.test(proc.name)) return [];
    const other = OTHER_AGENTS.find(({ pattern }) => pattern.test(`${proc.name} ${proc.commandLine}`));
    return other ? [{ pid: proc.pid, vendor: 'other', label: other.label }] : [];
  });
  const matchedPids = new Set(matched.map((m) => m.pid));
  const parentOf = new Map(procs.map((proc) => [proc.pid, proc.ppid] as const));
  return matched.filter((m) => !matchedPids.has(parentOf.get(m.pid) ?? -1));
}

export function hasCodexBackend(procs: readonly ProcInfo[]): boolean {
  return procs.some((proc) => /^codex/i.test(proc.name));
}

/** `codex exec` is one-shot: its rollout is live only while such a process exists. */
export function hasCodexExecProcess(procs: readonly ProcInfo[]): boolean {
  return procs.some((proc) => /^codex/i.test(proc.name) && /\sexec(\s|$)/i.test(proc.commandLine));
}
