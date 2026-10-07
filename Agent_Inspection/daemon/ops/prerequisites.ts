import { spawnSync } from 'node:child_process';

export interface Prerequisite {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  /** Version found, or what is missing. */
  readonly detail: string;
  /** What the tower uses it for, and how to fix it when missing. */
  readonly purpose: string;
}

export interface PrerequisiteProbes {
  readonly nodeVersion: string;
  readonly claudeExe: () => string | undefined;
  readonly codexEntry: () => string | undefined;
  readonly hooksInstalled: () => boolean;
  /** Runs `<command> <args>` and returns its first output line, or undefined when it is not installed. */
  readonly run?: (command: string, args: readonly string[]) => string | undefined;
}

const MIN_NODE_MAJOR = 22;
const PROBE_TIMEOUT_MS = 5000;

function runFirstLine(command: string, args: readonly string[]): string | undefined {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true });
  if (result.error || result.status !== 0) return undefined;
  return `${result.stdout}`.split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
}

/** One read-only pass over the tools the tower relies on. Nothing is installed or changed. */
export function checkPrerequisites(probes: PrerequisiteProbes): Prerequisite[] {
  const run = probes.run ?? runFirstLine;
  const nodeMajor = Number(/^v?(\d+)/.exec(probes.nodeVersion)?.[1] ?? 0);
  const git = run('git', ['--version']);
  const claude = probes.claudeExe();
  const codex = probes.codexEntry();
  const terminal = run('where', ['wt.exe']);
  const hooks = probes.hooksInstalled();
  return [
    {
      id: 'node', label: 'Node.js', ok: nodeMajor >= MIN_NODE_MAJOR, detail: probes.nodeVersion,
      purpose: `Runs the tower (needs ${MIN_NODE_MAJOR} or newer for built-in SQLite).`,
    },
    {
      id: 'git', label: 'Git', ok: git !== undefined, detail: git ?? 'not found on PATH',
      purpose: 'Teams give each member its own worktree and branch. Install Git for Windows.',
    },
    {
      id: 'claude', label: 'Claude Code', ok: claude !== undefined, detail: claude ?? 'claude.exe not found',
      purpose: 'Opening agents in the real CLI (managed Claude agents use the bundled Agent SDK). Set AGENT_TOWER_CLAUDE_EXE if it lives elsewhere.',
    },
    {
      id: 'codex', label: 'Codex CLI', ok: codex !== undefined, detail: codex ?? 'not installed',
      purpose: 'Codex agents and team members. Install with: npm install -g @openai/codex',
    },
    {
      id: 'terminal', label: 'Windows Terminal', ok: terminal !== undefined, detail: terminal ?? 'wt.exe not found',
      purpose: 'Terminal consoles and Open in Claude Code / Codex.',
    },
    {
      id: 'hooks', label: 'Tower hooks', ok: hooks, detail: hooks ? 'installed' : 'not installed',
      purpose: 'Intercepting and instructing the Claude Code sessions you start yourself. Use Install hooks in the top bar.',
    },
  ];
}
