import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { OutputsPathError, resolveInsideCwd } from '../daemon/outputs/pathSafety.ts';
import { tempDir } from './helpers.ts';

let root: string;
let outside: string;
let junctionMade = false;

beforeAll(() => {
  root = tempDir('outputs-root-');
  outside = tempDir('outputs-outside-');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'src', 'a.ts'), 'a');
  writeFileSync(join(root, '.git', 'config'), '[core]');
  writeFileSync(join(outside, 'secret.txt'), 'nope');
  try {
    // A junction needs no admin rights on Windows; elsewhere it is an ordinary directory symlink.
    symlinkSync(outside, join(root, 'escape'), 'junction');
    junctionMade = true;
  } catch {
    junctionMade = false;
  }
});

describe('resolveInsideCwd', () => {
  it('accepts a relative path to a file inside the folder', () => {
    // Act
    const resolved = resolveInsideCwd(root, 'src/a.ts');

    // Assert
    expect(resolved.rel).toBe('src/a.ts');
    expect(resolved.exists).toBe(true);
  });

  it('accepts an absolute path inside the folder and returns it relative', () => {
    expect(resolveInsideCwd(root, join(root, 'src', 'a.ts')).rel).toBe('src/a.ts');
  });

  it('accepts a file that no longer exists, so deletions can still be diffed', () => {
    const resolved = resolveInsideCwd(root, 'src/deleted.ts');
    expect(resolved).toMatchObject({ rel: 'src/deleted.ts', exists: false });
  });

  it('rejects .. segments even when they would land back inside', () => {
    expect(() => resolveInsideCwd(root, '../outside.txt')).toThrow(OutputsPathError);
    expect(() => resolveInsideCwd(root, 'src/../src/a.ts')).toThrow(OutputsPathError);
    expect(() => resolveInsideCwd(root, 'src\\..\\..\\x')).toThrow(OutputsPathError);
  });

  it('rejects absolute paths outside the folder', () => {
    expect(() => resolveInsideCwd(root, join(outside, 'secret.txt'))).toThrow(OutputsPathError);
  });

  it('rejects anything under .git, in any letter case', () => {
    expect(() => resolveInsideCwd(root, '.git/config')).toThrow(OutputsPathError);
    expect(() => resolveInsideCwd(root, '.GIT/config')).toThrow(OutputsPathError);
    expect(() => resolveInsideCwd(root, 'sub/.git/HEAD')).toThrow(OutputsPathError);
  });

  it('rejects empty, NUL-containing, drive-relative and over-long paths, and the folder itself', () => {
    expect(() => resolveInsideCwd(root, '')).toThrow(OutputsPathError);
    expect(() => resolveInsideCwd(root, 'a\0b')).toThrow(OutputsPathError);
    expect(() => resolveInsideCwd(root, 'C:secret.txt')).toThrow(OutputsPathError);
    expect(() => resolveInsideCwd(root, 'x'.repeat(5000))).toThrow(OutputsPathError);
    expect(() => resolveInsideCwd(root, '.')).toThrow(OutputsPathError);
    expect(() => resolveInsideCwd(root, 'src')).toThrow(OutputsPathError);
  });

  it('rejects a path that escapes through a symlink or junction', () => {
    if (!junctionMade) return;
    expect(() => resolveInsideCwd(root, 'escape/secret.txt')).toThrow(OutputsPathError);
    expect(() => resolveInsideCwd(root, 'escape/missing.txt')).toThrow(OutputsPathError);
  });
});
