import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FolderFileError, LIMITS, listFolder, readFolderFile } from '../daemon/files/folderFiles.ts';

let base: string;
let root: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'waystation-files-'));
  root = join(base, 'project');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'main.py'), 'print("hi")\n');
  writeFileSync(join(root, 'analysis.ipynb'), JSON.stringify({ cells: [], metadata: {} }));
  writeFileSync(join(root, 'paper.pdf'), '%PDF-1.4\n%fake\n');
  writeFileSync(join(root, 'fake.pdf'), 'not a pdf at all');
  writeFileSync(join(root, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  writeFileSync(join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(root, 'src', 'util.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, '.git', 'config'), '[core]');
  writeFileSync(join(base, 'secret.txt'), 'outside');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('listFolder', () => {
  it('lists folders first, then files by name, with sizes, and never .git', () => {
    const listing = listFolder(root, '');
    expect(listing.dir).toBe('');
    expect(listing.entries.map((entry) => [entry.kind, entry.name])).toEqual([
      ['dir', 'src'], ['file', 'analysis.ipynb'], ['file', 'blob.bin'], ['file', 'chart.png'], ['file', 'fake.pdf'], ['file', 'main.py'], ['file', 'paper.pdf'],
    ]);
    expect(listing.entries.find((entry) => entry.name === 'main.py')?.size).toBe(12);
    expect(listing.truncated).toBe(false);
  });
  it('goes into a subfolder, with either slash', () => {
    expect(listFolder(root, 'src').entries.map((entry) => entry.name)).toEqual(['util.ts']);
    expect(listFolder(root, 'src\\').dir).toBe('src');
  });
  it.each([
    ['..', /"\.\."/], ['src/../..', /"\.\."/], ['.git', /\.git/], ['nope', /does not exist/], ['GIT~1', /not valid/],
  ])('refuses the folder %s', (dir, message) => {
    expect(() => listFolder(root, dir)).toThrow(FolderFileError);
    expect(() => listFolder(root, dir)).toThrow(message);
  });
  it('needs a full path to an existing folder', () => {
    expect(() => listFolder('project', '')).toThrow(/full path/);
    expect(() => listFolder(join(base, 'missing'), '')).toThrow(/does not exist/);
    expect(() => listFolder(join(root, 'main.py'), '')).toThrow(/does not exist/);
    expect(() => listFolder(undefined, '')).toThrow(/Choose a folder/);
  });
});

describe('readFolderFile', () => {
  it('reads code and other text', () => {
    expect(readFolderFile(root, 'main.py')).toEqual({ kind: 'text', path: 'main.py', size: 12, text: 'print("hi")\n' });
    expect(readFolderFile(root, 'src/util.ts')).toMatchObject({ kind: 'text', path: 'src/util.ts' });
  });
  it('reads a notebook as its JSON text, a PDF and an image as base64', () => {
    expect(readFolderFile(root, 'analysis.ipynb')).toMatchObject({ kind: 'notebook', text: '{"cells":[],"metadata":{}}' });
    const pdf = readFolderFile(root, 'paper.pdf');
    expect(pdf.kind).toBe('pdf');
    expect(pdf.kind === 'pdf' && Buffer.from(pdf.base64, 'base64').toString()).toBe('%PDF-1.4\n%fake\n');
    expect(readFolderFile(root, 'chart.png')).toMatchObject({ kind: 'image', mime: 'image/png' });
  });
  it('refuses a binary that is not one of the shown kinds, and a .pdf that is not a PDF', () => {
    expect(() => readFolderFile(root, 'blob.bin')).toThrow(/binary/);
    expect(() => readFolderFile(root, 'fake.pdf')).toThrow(/not a PDF/);
  });
  it.each([
    ['../secret.txt', /"\.\."/], ['.git/config', /\.git/], ['src', /Only files/], ['missing.py', /does not exist/],
  ])('refuses %s', (path, message) => {
    expect(() => readFolderFile(root, path)).toThrow(FolderFileError);
    expect(() => readFolderFile(root, path)).toThrow(message);
  });
  it('refuses an absolute path outside the folder, and says "the chosen folder"', () => {
    expect(() => readFolderFile(root, join(base, 'secret.txt'))).toThrow(/outside the chosen folder/);
  });
  it('refuses a text file over the size limit', () => {
    writeFileSync(join(root, 'huge.log'), Buffer.alloc(LIMITS.text + 1, 'a'));
    expect(() => readFolderFile(root, 'huge.log')).toThrow(/too large/);
  });
});
