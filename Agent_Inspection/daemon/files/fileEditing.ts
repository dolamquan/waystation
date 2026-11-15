import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { resolveInsideCwd } from '../outputs/pathSafety.ts';
import { FolderFileError, folderRoot, LIMITS, readFolderFile } from './folderFiles.ts';

export const revisionOf = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export function editableFile(root: unknown, path: unknown) {
  const file = readFolderFile(root, path);
  return file.kind === 'text' || file.kind === 'notebook' ? { ...file, revision: revisionOf(file.text) } : file;
}
export function writeFolderFile(raw: Record<string, unknown>) {
  const root = folderRoot(raw.root), current = readFolderFile(root, raw.path);
  if (current.kind !== 'text' && current.kind !== 'notebook') throw new FolderFileError('Choose a text file or notebook to edit.');
  if (typeof raw.text !== 'string' || Buffer.byteLength(raw.text) > (current.kind === 'notebook' ? LIMITS.notebook : LIMITS.text)) throw new FolderFileError('The edited file exceeds the supported size limit.');
  if (typeof raw.revision !== 'string' || revisionOf(current.text) !== raw.revision) throw new FolderFileError('This file changed on disk. Your edits are still here. Reload the disk version or download your edits before replacing them.');
  if (current.kind === 'notebook') {
    let notebook;
    try { notebook = JSON.parse(raw.text); } catch { throw new FolderFileError('The notebook is not valid JSON.'); }
    if (notebook.nbformat !== 4 || !Array.isArray(notebook.cells)) throw new FolderFileError('Save a notebook in nbformat 4 with a cells array.');
  }
  const safe = resolveInsideCwd(root, raw.path), temp = join(dirname(safe.abs), `.waystation-save-${randomUUID()}${extname(safe.abs)}`);
  try {
    writeFileSync(temp, raw.text, { flag: 'wx', mode: statSync(safe.abs).mode });
    if (revisionOf(readFileSync(safe.abs)) !== raw.revision) throw new FolderFileError('This file changed on disk while saving. Your edits were not written. Reload or download your edits.');
    renameSync(temp, safe.abs);
  } finally { try { unlinkSync(temp); } catch { /* Rename consumed it. */ } }
  return { revision: revisionOf(raw.text), size: Buffer.byteLength(raw.text) };
}
