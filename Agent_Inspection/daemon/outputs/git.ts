import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact } from '../domain/text.ts';
import type { CommitInfo, StatusEntry } from './types.ts';

/**
 * Read-only git for the Outputs tab. Like daemon/teams/workspace.ts: execFile with an argument array (no shell),
 * fsmonitor and hooks disabled so a repo's own config cannot make the daemon run programs, external diff and
 * textconv drivers off, literal pathspecs after `--`. GIT_OPTIONAL_LOCKS=0 keeps `git status` from writing the
 * index of a repo other agents are working in.
 */

const SAFE_GIT_CONFIG = [
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${join(tmpdir(), 'agent-tower-no-git-hooks')}`,
  '-c', 'core.quotePath=false',
  '--no-pager',
];
/** Paths after `--` are matched literally (no globs or magic). check-ignore takes plain paths and rejects this flag. */
const LITERAL = '--literal-pathspecs';
const SAFE_DIFF = ['--no-ext-diff', '--no-textconv', '--no-color'];
const GIT_TIMEOUT_MS = 15_000;
const MAX_GIT_BUFFER = 4 * 1024 * 1024;
export const MAX_DIFF_CHARS = 200_000;
export const MAX_PREVIEW_BYTES = 64 * 1024;
const MAX_STAT_CHARS = 20_000;
const MAX_STATUS_ENTRIES = 300;
const MAX_COMMITS = 50;
const BINARY_SNIFF_BYTES = 8000;
const FIELD = '\x1f';

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Output hit the buffer cap; stdout holds what arrived first. */
  readonly overflow: boolean;
  /** git itself could not be started. */
  readonly missing: boolean;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_EXTERNAL_DIFF']) delete env[key];
  return env;
}

export function runGit(cwd: string, args: readonly string[], literal = true): Promise<GitResult> {
  return new Promise((done) => {
    execFile('git', [...SAFE_GIT_CONFIG, ...(literal ? [LITERAL] : []), ...args], {
      cwd, windowsHide: true, maxBuffer: MAX_GIT_BUFFER, timeout: GIT_TIMEOUT_MS, env: gitEnv(), encoding: 'utf8',
    }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      done({
        code: error ? (typeof code === 'number' ? code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr || error?.message || ''),
        overflow: code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        missing: code === 'ENOENT',
      });
    });
  });
}

export interface RepoInfo {
  /** The folder relative to the repository top, with a trailing slash ("" at the top). */
  readonly prefix: string;
  readonly branch?: string;
  readonly hasHead: boolean;
}

export type RepoProbe = { readonly ok: true; readonly repo: RepoInfo } | { readonly ok: false; readonly reason: string };

export async function probeRepo(cwd: string): Promise<RepoProbe> {
  const prefix = await runGit(cwd, ['rev-parse', '--show-prefix']);
  if (prefix.missing) return { ok: false, reason: 'git is not installed or not on PATH, so changes can’t be compared.' };
  if (prefix.code !== 0) return { ok: false, reason: 'This folder is not a git repository, so changes can’t be compared.' };
  const [branch, head] = await Promise.all([
    runGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']),
    runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']),
  ]);
  return {
    ok: true,
    repo: { prefix: prefix.stdout.trim(), branch: branch.code === 0 ? branch.stdout.trim() || undefined : undefined, hasHead: head.code === 0 },
  };
}

const stripPrefix = (path: string, prefix: string) => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path);

/** Parses `git status --porcelain=v1 -z`; paths come back relative to the repository top. */
export function parsePorcelainZ(output: string, prefix: string): StatusEntry[] {
  const tokens = output.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4) continue;
    const code = token.slice(0, 2);
    const path = stripPrefix(token.slice(3), prefix);
    const renamed = code[0] === 'R' || code[0] === 'C';
    const from = renamed ? stripPrefix(tokens[++i] ?? '', prefix) : undefined;
    entries.push(from ? { code, path, from } : { code, path });
  }
  return entries;
}

export async function workingTreeStatus(cwd: string, repo: RepoInfo): Promise<{ status: StatusEntry[]; truncated: boolean }> {
  const result = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  if (result.code !== 0 && !result.overflow) return { status: [], truncated: false };
  const entries = parsePorcelainZ(result.stdout, repo.prefix);
  return { status: entries.slice(0, MAX_STATUS_ENTRIES), truncated: result.overflow || entries.length > MAX_STATUS_ENTRIES };
}

export async function diffStat(cwd: string, repo: RepoInfo): Promise<string> {
  const result = await runGit(cwd, ['diff', ...(repo.hasHead ? ['HEAD'] : []), ...SAFE_DIFF, '--relative', '--stat=120', '--', '.']);
  return result.code === 0 || result.overflow ? redact(result.stdout.trimEnd()).slice(0, MAX_STAT_CHARS) : '';
}

export async function commitsSince(cwd: string, repo: RepoInfo, since: number): Promise<CommitInfo[]> {
  if (!repo.hasHead) return [];
  const format = ['%H', '%h', '%an', '%at', '%s'].join('%x1f');
  const result = await runGit(cwd, ['log', `--since=${new Date(since).toISOString()}`, '-n', String(MAX_COMMITS), `--format=${format}`, '--', '.']);
  if (result.code !== 0) return [];
  return result.stdout.split('\n').filter(Boolean).map((line) => {
    const [hash = '', shortHash = '', author = '', at = '0', subject = ''] = line.split(FIELD);
    return { hash, shortHash, author: redact(author), ts: Number(at) * 1000, subject: redact(subject) };
  });
}

export interface CappedText {
  readonly text: string;
  readonly truncated: boolean;
}

export async function fileDiff(cwd: string, repo: RepoInfo, rel: string): Promise<CappedText> {
  const result = await runGit(cwd, ['diff', ...(repo.hasHead ? ['HEAD'] : []), ...SAFE_DIFF, '--', rel]);
  if (result.code !== 0 && !result.overflow) return { text: '', truncated: false };
  const truncated = result.overflow || result.stdout.length > MAX_DIFF_CHARS;
  return { text: redact(result.stdout.slice(0, MAX_DIFF_CHARS)), truncated };
}

export async function isTracked(cwd: string, rel: string): Promise<boolean> {
  return (await runGit(cwd, ['ls-files', '--error-unmatch', '--', rel])).code === 0;
}

export async function isIgnored(cwd: string, rel: string): Promise<boolean> {
  return (await runGit(cwd, ['check-ignore', '-q', '--', rel], false)).code === 0;
}

export interface Preview extends CappedText {
  readonly binary: boolean;
}

/** First MAX_PREVIEW_BYTES of a file, redacted; binary files come back empty. */
export async function readPreview(abs: string): Promise<Preview> {
  const handle = await open(abs, 'r');
  try {
    const buffer = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, Math.min(bytesRead, MAX_PREVIEW_BYTES));
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { text: '', truncated: false, binary: true };
    return { text: redact(bytes.toString('utf8')), truncated: bytesRead > MAX_PREVIEW_BYTES, binary: false };
  } finally {
    await handle.close();
  }
}
