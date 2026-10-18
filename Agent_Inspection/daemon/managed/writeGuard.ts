import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

/** Claude tools that write files, and the input key holding the target path. */
const WRITE_TOOLS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Claude tools that read files, and the input keys that can name a target path (or an absolute glob). */
const READ_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Read: ['file_path'],
  Grep: ['path', 'glob'],
  Glob: ['path', 'pattern'],
  NotebookRead: ['notebook_path'],
};

export const WRITE_TOOL_MATCHER = Object.keys(WRITE_TOOLS).join('|');
export const READ_TOOL_MATCHER = Object.keys(READ_TOOLS).join('|');

/** Inside a worktree, these configure agents or git for whoever opens the repo next. */
const PROTECTED_IN_ROOT = /^(\.claude|\.codex|\.git|\.githooks|\.husky)([\\/]|$)|^\.mcp\.json$/i;

export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(root, target));
  return rel === '' || (!rel.startsWith(`..`) && !isAbsolute(rel));
}

/**
 * Returns a denial reason when a file-writing tool targets a path outside `root`, or agent/git
 * configuration inside it; else undefined. Shell commands are not covered: this keeps agents in their
 * own worktree, it is not a security boundary.
 */
export function writeViolation(toolName: string, input: Record<string, unknown>, root: string): string | undefined {
  const key = WRITE_TOOLS[toolName];
  if (!key) return undefined;
  const target = input[key];
  if (typeof target !== 'string' || !target) return undefined;
  if (!isInside(root, target)) {
    return `This team member may only write inside its own worktree (${root}). ${target} is outside it; ask the teammate who owns that code, or the lead, instead.`;
  }
  if (PROTECTED_IN_ROOT.test(relative(resolve(root), resolve(root, target)))) {
    return `${target} is agent or git configuration. Team members may not change it; ask the operator if it is really needed.`;
  }
  return undefined;
}

export interface ReadGuard {
  /** Folder the agent's file tools may not read (the tower's state, which holds its access token)… */
  readonly deny: string;
  /** …except this subfolder (the team's worktrees). */
  readonly allow: string;
}

/** `\\?\C:\x` and `\\host\C$\x` are other spellings of `C:\x`; the lexical check would not see through them. */
function plainWindowsPath(target: string): string {
  return target
    .replace(/^\\\\[?.]\\(?=[a-z]:)/i, '')
    .replace(/^\\\\(?:localhost|127\.0\.0\.1|\[::1\]|[^\\/]+)\\([a-z])\$(?=[\\/]|$)/i, '$1:');
}

/** Real path of `path`, or of its nearest existing ancestor plus the rest, so junctions and 8.3 names resolve. */
function canonicalPath(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.unshift(basename(existing));
    existing = parent;
  }
  try {
    return resolve(realpathSync.native(existing), ...rest);
  } catch {
    return path;
  }
}

/** Where `deny` and `allow` really live, so the comparison is between canonical paths. */
const canonicalGuard = (guard: ReadGuard): ReadGuard => ({ deny: canonicalPath(resolve(guard.deny)), allow: canonicalPath(resolve(guard.allow)) });

/**
 * Denial reason when a file-reading tool targets the tower's private state. The path is checked as written
 * and as it really resolves (junctions, 8.3 names, `\\?\` and admin-share spellings). Only file tools are
 * covered: a Bash or PowerShell command can still read these files, so this is a speed bump, not a boundary.
 */
export function readViolation(toolName: string, input: Record<string, unknown>, cwd: string, guard: ReadGuard): string | undefined {
  const keys = READ_TOOLS[toolName];
  if (!keys) return undefined;
  const real = canonicalGuard(guard);
  for (const key of keys) {
    const target = input[key];
    if (typeof target !== 'string' || !target) continue;
    const lexical = resolve(cwd, plainWindowsPath(target));
    const candidates = [lexical, canonicalPath(lexical)];
    const denied = candidates.some((path) => (isInside(guard.deny, path) && !isInside(guard.allow, path))
      || (isInside(real.deny, path) && !isInside(real.allow, path)));
    if (denied) return 'That path holds Agent Tower\'s private state. Team members may not read it.';
  }
  return undefined;
}
