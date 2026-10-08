import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** A requested file is not one the Outputs tab may show. The message is safe to return to the UI. */
export class OutputsPathError extends Error {}

export interface SafePath {
  /** Real path of the agent's folder. */
  readonly root: string;
  /** Absolute path of the file (real path when it exists). */
  readonly abs: string;
  /** Relative to the folder, forward slashes: safe to pass to git after `--`. */
  readonly rel: string;
  readonly exists: boolean;
}

const MAX_PATH_CHARS = 1024;
const DRIVE_RELATIVE = /^[a-zA-Z]:(?![\\/])/;

const isGitDir = (segment: string) => segment.toLowerCase() === '.git';

const escapes = (rel: string) => rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel);

/** `rel` (from path.relative) stays inside the folder and never names a .git directory. */
function checkWithin(rel: string): string[] {
  if (escapes(rel)) throw new OutputsPathError('That file is outside this agent’s folder.');
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.some(isGitDir)) throw new OutputsPathError('Files inside .git are not shown.');
  return segments;
}

/** Like checkWithin, and also refuses the folder itself. */
function checkRelative(rel: string): string {
  const segments = checkWithin(rel);
  if (segments.length === 0) throw new OutputsPathError('Choose a file inside this agent’s folder.');
  return segments.join('/');
}

/** Real path of the nearest existing ancestor of `path` (to catch a symlinked parent of a deleted file). */
function realAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return realpathSync(current);
}

/**
 * Resolves `requested` (relative to `cwd`, or absolute) to a file inside `cwd`. Rejects `..` segments,
 * drive-relative and absolute paths outside the folder, anything under .git, directories, and symlink
 * or junction escapes (checked on the real path of the file, or of its nearest existing parent).
 */
export function resolveInsideCwd(cwd: string, requested: unknown): SafePath {
  if (typeof requested !== 'string' || !requested.trim()) throw new OutputsPathError('A file path is required.');
  if (requested.length > MAX_PATH_CHARS || requested.includes('\0')) throw new OutputsPathError('That file path is not valid.');
  if (requested.split(/[\\/]+/).includes('..')) throw new OutputsPathError('Paths with ".." are not allowed.');
  if (DRIVE_RELATIVE.test(requested)) throw new OutputsPathError('That file path is not valid.');
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new OutputsPathError('This agent’s folder no longer exists.');

  const root = realpathSync(cwd);
  const lexical = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  // An absolute path may name the folder through its original (non-real) spelling.
  const viaCwd = isAbsolute(requested) ? relative(resolve(cwd), lexical) : undefined;
  const lexicalRel = viaCwd !== undefined && !escapes(viaCwd) ? viaCwd : relative(root, lexical);
  const rel = checkRelative(lexicalRel);
  const candidate = resolve(root, rel.split('/').join(sep));

  if (!existsSync(candidate)) {
    checkWithin(relative(root, realAncestor(dirname(candidate))));
    return { root, abs: candidate, rel, exists: false };
  }
  const real = realpathSync(candidate);
  checkRelative(relative(root, real));
  if (!statSync(real).isFile()) throw new OutputsPathError('Only files can be shown.');
  return { root, abs: real, rel, exists: true };
}
