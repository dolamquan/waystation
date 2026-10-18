import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '../daemon/domain/types.ts';

export function tempDir(prefix = 'tower-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export const GIT_TEST_IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A real git repository with one commit on `main`, for worktree/merge tests. */
export function makeRepo(files: Record<string, string> = { 'app.txt': 'hello\n' }): string {
  const dir = tempDir('team-repo-');
  git(dir, 'init', '-b', 'main');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  git(dir, 'add', '-A');
  git(dir, ...GIT_TEST_IDENTITY, 'commit', '-m', 'init');
  return dir;
}

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'claude:11111111-2222-3333-4444-555555555555',
    vendor: 'claude',
    tier: 'B',
    name: 'Test agent',
    sessionId: '11111111-2222-3333-4444-555555555555',
    pid: 4242,
    cwd: 'C:\\work\\demo',
    project: 'demo',
    status: 'busy',
    source: 'test',
    hooked: true,
    intercepting: false,
    canInstruct: true,
    ...overrides,
  };
}
