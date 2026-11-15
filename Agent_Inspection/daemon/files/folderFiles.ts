import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { OutputsPathError, resolveInsideCwd } from '../outputs/pathSafety.ts';

/**
 * Browsing and reading files inside a folder the operator chose, for the canvas's file tiles (code, notebooks, PDFs,
 * images). Read-only. Every path is checked to stay inside the folder (no "..", no .git, no symlink or junction
 * escape); reading reuses the Outputs tab's resolver, listing applies the same rules to folders.
 */

export class FolderFileError extends Error {}

export interface FolderEntry {
  readonly name: string;
  readonly kind: 'dir' | 'file';
  /** Bytes; absent for folders. */
  readonly size?: number;
}

export interface FolderListing {
  /** The folder's real path. */
  readonly root: string;
  /** The listed folder, relative to the root with forward slashes ('' for the root). */
  readonly dir: string;
  readonly entries: readonly FolderEntry[];
  /** More entries than MAX_ENTRIES: only the first ones are listed. */
  readonly truncated: boolean;
}

export type FileContent =
  | { readonly kind: 'text'; readonly path: string; readonly size: number; readonly text: string }
  | { readonly kind: 'notebook'; readonly path: string; readonly size: number; readonly text: string }
  | { readonly kind: 'pdf'; readonly path: string; readonly size: number; readonly base64: string }
  | { readonly kind: 'image'; readonly path: string; readonly size: number; readonly base64: string; readonly mime: string };

export const MAX_ENTRIES = 1000;
const MIB = 1024 * 1024;
export const LIMITS = { text: 2 * MIB, notebook: 25 * MIB, pdf: 40 * MIB, image: 15 * MIB } as const;
const SNIFF_BYTES = 8000;
const MAX_PATH_CHARS = 1024;

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  // Shown through <img>, which never runs an SVG's scripts.
  '.svg': 'image/svg+xml',
};

const isGitDir = (segment: string) => segment.toLowerCase() === '.git';
const isNtfsAlias = (segment: string) => /~\d|[:$]/.test(segment);
const escapes = (rel: string) => rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel);

/** The chosen folder: an absolute path to an existing directory. Returns its real path. */
export function folderRoot(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new FolderFileError('Choose a folder.');
  if (raw.length > MAX_PATH_CHARS || raw.includes('\0') || !isAbsolute(raw)) throw new FolderFileError('The folder must be a full path, such as C:\\Users\\you\\project.');
  if (!existsSync(raw) || !statSync(raw).isDirectory()) throw new FolderFileError('That folder does not exist.');
  return realpathSync.native(raw);
}

/** A folder inside `root` ('' is the root itself): no "..", no .git, and its real path stays inside. */
function insideDir(root: string, raw: unknown): { readonly abs: string; readonly rel: string } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length > MAX_PATH_CHARS || text.includes('\0')) throw new FolderFileError('That folder path is not valid.');
  const segments = text.split(/[\\/]+/).filter(Boolean);
  if (segments.includes('..')) throw new FolderFileError('Paths with ".." are not allowed.');
  if (segments.some(isGitDir)) throw new FolderFileError('Folders inside .git are not shown.');
  if (segments.some(isNtfsAlias)) throw new FolderFileError('That folder path is not valid.');
  const abs = resolve(root, ...segments);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new FolderFileError('That folder does not exist.');
  const real = relative(root, realpathSync.native(abs));
  if (escapes(real)) throw new FolderFileError('That folder is outside the chosen folder.');
  return { abs, rel: segments.join('/') };
}

/** One folder's entries, folders first, then by name. .git is never listed. */
export function listFolder(rootRaw: unknown, dirRaw: unknown): FolderListing {
  const root = folderRoot(rootRaw);
  const { abs, rel } = insideDir(root, dirRaw);
  const names = readdirSync(abs).filter((name) => !isGitDir(name));
  const entries = names.slice(0, MAX_ENTRIES).flatMap((name): FolderEntry[] => {
    try {
      const stat = statSync(resolve(abs, name));
      if (stat.isDirectory()) return [{ name, kind: 'dir' }];
      return stat.isFile() ? [{ name, kind: 'file', size: stat.size }] : [];
    } catch {
      return []; // a broken link or a file that vanished meanwhile
    }
  });
  const sorted = [...entries].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1));
  return { root, dir: rel, entries: sorted, truncated: names.length > MAX_ENTRIES };
}

function head(abs: string, bytes: number): Buffer {
  const fd = openSync(abs, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

const tooBig = (what: string, limit: number) => new FolderFileError(`That ${what} is too large to show here (over ${Math.round(limit / MIB)} MB).`);

/** A file inside `root`, as the kind of content a tile can show. Anything else (a binary that is not one of those) is refused. */
export function readFolderFile(rootRaw: unknown, pathRaw: unknown): FileContent {
  const root = folderRoot(rootRaw);
  let safe;
  try {
    safe = resolveInsideCwd(root, pathRaw);
  } catch (error) {
    if (error instanceof OutputsPathError) throw new FolderFileError(error.message.replace(/this agent’s folder/g, 'the chosen folder'));
    throw error;
  }
  if (!safe.exists) throw new FolderFileError('That file does not exist.');
  const size = statSync(safe.abs).size;
  const ext = extname(safe.abs).toLowerCase();
  const path = safe.rel;

  if (ext === '.pdf') {
    if (size > LIMITS.pdf) throw tooBig('PDF', LIMITS.pdf);
    if (!head(safe.abs, 1024).toString('latin1').includes('%PDF-')) throw new FolderFileError('That file is not a PDF.');
    return { kind: 'pdf', path, size, base64: readFileSync(safe.abs).toString('base64') };
  }
  const mime = IMAGE_TYPES[ext];
  if (mime) {
    if (size > LIMITS.image) throw tooBig('image', LIMITS.image);
    return { kind: 'image', path, size, mime, base64: readFileSync(safe.abs).toString('base64') };
  }
  if (ext === '.ipynb') {
    if (size > LIMITS.notebook) throw tooBig('notebook', LIMITS.notebook);
    return { kind: 'notebook', path, size, text: readFileSync(safe.abs, 'utf8') };
  }
  if (size > LIMITS.text) throw tooBig('file', LIMITS.text);
  // Text is whatever has no NUL byte near the start: source code, data, config, markdown, logs.
  if (head(safe.abs, SNIFF_BYTES).includes(0)) throw new FolderFileError('That file is binary; tiles show code, text, notebooks, PDFs and images.');
  return { kind: 'text', path, size, text: readFileSync(safe.abs, 'utf8') };
}
