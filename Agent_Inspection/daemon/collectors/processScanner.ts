import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BUILTIN_DISCOVERY, type DiscoveryRule } from '../../shared/agentProviders.ts';

const execFileAsync = promisify(execFile);

export interface ProcInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly commandLine: string;
  /** UTC creation timestamp, used to detect PID reuse. */
  readonly created: string;
}

export interface ObservedProcess {
  readonly pid: number;
  readonly vendor: 'codex' | 'other';
  readonly label: string;
  readonly providerId?: string;
  readonly host?: 'cli' | 'editor';
}

const PS_SCRIPT = [
  // Scan once for all providers, including custom rules. Command lines stay in memory.
  `$p = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID }`,
  `@($p | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = [string]$_.CommandLine; created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' } } }) | ConvertTo-Json -Compress -Depth 2`,
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

/** Shells whose command line merely mentions an agent name (e.g. grep/scan commands) are not agents. */
const SHELL_NAMES = /^(powershell|pwsh|cmd|bash|sh|wsl|conhost)(\.exe)?$/i;
const SHARED_RUNTIME = /^(node|python[\d.]*|py)(\.exe)?$/i;
export const EDITOR_PROCESS = /^(code|code - insiders|cursor|windsurf|electron)(\.exe)?$/i;

/** Inspect only the executable/entry script (or Python module), not user prompts or arbitrary arguments. */
function entryPath(proc: ProcInfo): string {
  const tokens = [...proc.commandLine.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
  if (!SHARED_RUNTIME.test(proc.name)) return tokens[0] ?? '';
  if (/^(python[\d.]*|py)(\.exe)?$/i.test(proc.name) && tokens[1] === '-m') return tokens[2] ?? '';
  // Runtime flags can take arbitrary arguments; refuse to guess which argument is the script.
  return tokens[1]?.startsWith('-') ? '' : tokens[1] ?? '';
}

export function matchesDiscoveryRule(proc: ProcInfo, rule: DiscoveryRule): boolean {
  if (SHELL_NAMES.test(proc.name) || EDITOR_PROCESS.test(proc.name)) return false;
  if (rule.executables.includes(proc.name.toLowerCase().replace(/\.exe$/, ''))) return true;
  if (!SHARED_RUNTIME.test(proc.name)) return false;
  const entry = entryPath(proc).replaceAll('\\', '/').toLowerCase();
  return rule.packages.some(pkg => {
    const marker = pkg.toLowerCase();
    return entry === marker || entry.startsWith(`${marker}/`) || entry.endsWith(`/${marker}`) || entry.includes(`/${marker}/`);
  });
}

const isExtensionHosted =(proc: ProcInfo): boolean => /[\\/]\.vscode[\\/]extensions[\\/]/i.test(proc.commandLine);
const isCodexBackend = (proc: ProcInfo): boolean =>
  /app-server|code-mode-host/i.test(`${proc.name} ${proc.commandLine}`) || isExtensionHosted(proc);

/** Standalone agent processes not covered by a richer collector. Children of matched parents are folded in. */
export function classifyObserved(procs: readonly ProcInfo[], rules: readonly DiscoveryRule[] = BUILTIN_DISCOVERY): ObservedProcess[] {
  const byPid = new Map(procs.map(proc => [proc.pid, proc]));
  const matched = procs.flatMap((proc): ObservedProcess[] => {
    if (/^codex/i.test(proc.name)) {
      return isCodexBackend(proc) ? [] : [{ pid: proc.pid, vendor: 'codex', label: 'Codex CLI' }];
    }
    if (/^claude/i.test(proc.name) || SHELL_NAMES.test(proc.name)) return [];
    const other = rules.find(rule => matchesDiscoveryRule(proc, rule));
    if (!other) return [];
    const parent = byPid.get(proc.ppid);
    const editor = /^copilot-runtime(?:\.exe)?$/i.test(proc.name) || isExtensionHosted(proc)
      || /[\\/]globalStorage[\\/]/i.test(entryPath(proc)) || (parent && EDITOR_PROCESS.test(parent.name));
    return [{ pid: proc.pid, vendor: 'other', label: other.label, providerId: other.id, host: editor ? 'editor' : 'cli' }];
  });
  const matchedPids = new Set(matched.map((m) => m.pid));
  const parentOf = new Map(procs.map((proc) => [proc.pid, proc.ppid] as const));
  // Fold only descendants of the same provider, including intermediary shells/runtimes.
  const providerOf = new Map(matched.map(m => [m.pid, m.providerId ?? m.vendor]));
  return matched.filter(m => {
    const seen = new Set([m.pid]);
    let parent = parentOf.get(m.pid);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (matchedPids.has(parent) && providerOf.get(parent) === (m.providerId ?? m.vendor)) return false;
      parent = parentOf.get(parent);
    }
    return true;
  });
}

export function hasCodexBackend(procs: readonly ProcInfo[]): boolean {
  return procs.some((proc) => /^codex/i.test(proc.name));
}

/** `codex exec` is one-shot: its rollout is live only while such a process exists. */
export function hasCodexExecProcess(procs: readonly ProcInfo[]): boolean {
  return procs.some((proc) => /^codex/i.test(proc.name) && /\sexec(\s|$)/i.test(proc.commandLine));
}
