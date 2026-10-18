import { spawn } from 'node:child_process';
import { stopProcessTree } from '../actions/kill.ts';
import { MANAGED_ENV_FLAG } from '../config.ts';
import { LibraryInputError } from './types.ts';

/** Output shown to the operator is cut to this many trailing characters. */
export const MAX_OUTPUT = 4000;
const DEFAULT_TIMEOUT_MS = 120_000;
/** Stdout kept for commands whose JSON output is parsed (Codex lists thousands of marketplace plugins). */
const DEFAULT_MAX_STDOUT = 16 * 1024 * 1024;

export interface CliResult {
  readonly code: number | null;
  /** Combined stdout and stderr, trimmed to the last MAX_OUTPUT characters. */
  readonly output: string;
  /** Full stdout (up to the cap), for commands that print JSON. */
  readonly stdout?: string;
}

export interface CliSpec {
  /** What the operator reads in errors, e.g. "claude plugin". */
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly maxStdout?: number;
}

export const trimOutput = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > MAX_OUTPUT ? `…${trimmed.slice(-MAX_OUTPUT)}` : trimmed;
};

/** Spawns a CLI without a shell (args are never re-parsed), outside the managed-agent environment, killed on timeout. */
export function runCli(spec: CliSpec): Promise<CliResult> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdout = spec.maxStdout ?? DEFAULT_MAX_STDOUT;
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env[MANAGED_ENV_FLAG];
    const child = spawn(spec.command, [...spec.args], { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stdout = '';
    let stdoutOverflow = false;
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-MAX_OUTPUT * 2); };
    child.stdout?.on('data', (chunk: Buffer) => {
      collect(chunk);
      if (stdout.length + chunk.length > maxStdout) stdoutOverflow = true;
      else stdout += chunk.toString();
    });
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      if (child.pid) stopProcessTree(child.pid).catch(() => child.kill());
      reject(new LibraryInputError(`${spec.label} did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`));
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(new LibraryInputError(`Could not run ${spec.label}: ${error.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stdoutOverflow) {
        reject(new LibraryInputError(`${spec.label} printed more output than expected.`));
        return;
      }
      resolve({ code, output: trimOutput(output), stdout });
    });
  });
}
