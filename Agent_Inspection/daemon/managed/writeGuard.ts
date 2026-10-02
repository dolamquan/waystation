import { isAbsolute, relative, resolve } from 'node:path';

/** Claude tools that write files, and the input key holding the target path. */
const WRITE_TOOLS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Claude tools that read files, and the input key holding the target path. */
const READ_TOOLS: Readonly<Record<string, string>> = {
  Read: 'file_path',
  Grep: 'path',
  Glob: 'path',
  NotebookRead: 'notebook_path',
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

/** Denial reason when a file-reading tool targets the tower's private state. Lexical only, like writeViolation. */
export function readViolation(toolName: string, input: Record<string, unknown>, cwd: string, guard: ReadGuard): string | undefined {
  const key = READ_TOOLS[toolName];
  if (!key) return undefined;
  const target = input[key];
  if (typeof target !== 'string' || !target) return undefined;
  const absolute = resolve(cwd, target);
  if (!isInside(guard.deny, absolute) || isInside(guard.allow, absolute)) return undefined;
  return 'That path holds Agent Tower\'s private state. Team members may not read it.';
}
