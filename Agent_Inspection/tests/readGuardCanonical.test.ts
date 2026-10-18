import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readViolation, type ReadGuard } from '../daemon/managed/writeGuard.ts';
import { tempDir } from './helpers.ts';

const onWindows = process.platform === 'win32';

let towerHome: string;
let worktree: string;
let guard: ReadGuard;
let junction: string | undefined;

beforeAll(() => {
  towerHome = realpathSync.native(tempDir('guard-tower-'));
  worktree = realpathSync.native(tempDir('guard-work-'));
  mkdirSync(join(towerHome, 'teams', 'abc'), { recursive: true });
  writeFileSync(join(towerHome, 'daemon.json'), '{"token":"synthetic"}');
  guard = { deny: towerHome, allow: join(towerHome, 'teams', 'abc') };
  try {
    symlinkSync(towerHome, join(worktree, 'link'), 'junction');
    junction = join(worktree, 'link');
  } catch {
    junction = undefined;
  }
});

const read = (file_path: string) => readViolation('Read', { file_path }, worktree, guard);

describe('readViolation on canonical paths', () => {
  it('blocks the plain path', () => {
    expect(read(join(towerHome, 'daemon.json'))).toMatch(/private state/);
  });

  it('allows the team folder', () => {
    expect(read(join(towerHome, 'teams', 'abc', 'x.ts'))).toBeUndefined();
  });

  it('blocks a junction inside the worktree that points at the tower state', () => {
    if (!junction) return;
    expect(read(join(junction, 'daemon.json'))).toMatch(/private state/);
  });

  it.runIf(onWindows)('blocks the \\\\?\\ extended-length spelling', () => {
    expect(read(`\\\\?\\${join(towerHome, 'daemon.json')}`)).toMatch(/private state/);
  });

  it.runIf(onWindows)('blocks the administrative-share (UNC) spelling', () => {
    const drive = towerHome[0];
    const rest = towerHome.slice(3);
    expect(read(`\\\\localhost\\${drive}$\\${rest}\\daemon.json`)).toMatch(/private state/);
  });

  it('blocks an absolute Glob pattern and a Grep glob aimed at the tower state', () => {
    const pattern = join(towerHome, '*.json');
    expect(readViolation('Glob', { pattern }, worktree, guard)).toMatch(/private state/);
    expect(readViolation('Grep', { pattern: 'token', glob: pattern }, worktree, guard)).toMatch(/private state/);
  });

  it('still allows ordinary files in the worktree', () => {
    expect(read(join(worktree, 'a.ts'))).toBeUndefined();
    expect(readViolation('Glob', { pattern: 'src/**/*.ts' }, worktree, guard)).toBeUndefined();
  });
});
