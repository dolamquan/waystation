import { mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerOutput, readOutput } from '../daemon/teams/outputs.ts';
import { toView } from '../daemon/teams/board.ts';
import { restored } from '../daemon/teams/teamManager.ts';
import type { TeamMember, TeamState } from '../daemon/teams/types.ts';
import { tempDir } from './helpers.ts';
import { delimitedPreview } from '../shared/delimitedPreview.ts';

function fixture() {
  const worktree = tempDir('output-worktree-');
  const teamsDir = tempDir('output-store-');
  const member: TeamMember = { id: 'writer', name: 'writer', role: 'lead', vendor: 'claude', worktree, branch: 'team/writer', merged: false };
  const team: TeamState = { id: 'abc123', name: 'Report', goal: 'Write a report', repoRoot: worktree, baseBranch: 'main', baseCommit: 'abc', status: 'running', createdAt: 0, members: [member], tasks: [], messages: [], readUpTo: {}, budget: { maxWakes: 10, wakesUsed: 0, deadline: 10000 }, idleNudged: false, intercept: false, requirePlanApproval: false };
  const args = { title: 'Research report', description: 'The findings and next steps.', path: 'report.md' };
  writeFileSync(join(worktree, 'report.md'), '# Findings\nHello 世界');
  return { team, member, teamsDir, worktree, args };
}

describe('team deliverables', () => {
  it('previews CSV with escaped quotes, multiline cells, CRLF and row bounds', () => {
    expect(delimitedPreview('Name,Note\r\n"A, B","Says ""hello""\nnext line"\r\n')).toEqual([['Name', 'Note'], ['A, B', 'Says "hello"\nnext line']]);
    expect(delimitedPreview('Name\tValue\nA\t2', '\t')).toEqual([['Name', 'Value'], ['A', '2']]);
    expect(delimitedPreview(Array(300).fill('a,b').join('\n'))).toHaveLength(101);
  });
  it('preserves a named snapshot through edits, worktree cleanup, archival and restart', () => {
    const { team, member, args, teamsDir, worktree } = fixture();
    const output = registerOutput(team, member, args, teamsDir, 123);
    writeFileSync(join(worktree, 'report.md'), 'Revised');
    rmSync(join(worktree, 'report.md'));
    const saved = restored({ ...team, status: 'disbanded', outputs: [output] }, 456);
    expect(toView(saved).outputs).toEqual([output]);
    const result = readOutput(saved, output.id, teamsDir);
    expect(result.kind).toBe('text');
    expect(Buffer.from(result.data, 'base64').toString()).toBe('# Findings\nHello 世界');
    expect(output).toMatchObject({ filename: 'report.md', path: 'report.md', createdAt: 123 });
  });

  it('rejects traversal, absolute paths outside the member worktree, and junction escapes', () => {
    const { team, member, args, teamsDir, worktree } = fixture();
    const outside = tempDir('outside-output-');
    writeFileSync(join(outside, 'secret.txt'), 'private');
    for (const path of ['../outside.txt', join(outside, 'secret.txt')]) {
      expect(() => registerOutput(team, member, { ...args, path }, teamsDir, 0)).toThrow();
    }
    symlinkSync(outside, join(worktree, 'linked'), 'junction');
    expect(() => registerOutput(team, member, { ...args, path: 'linked/secret.txt' }, teamsDir, 0)).toThrow(/own worktree/);
  });

  it('rejects missing files, directories, oversized files and missing descriptions', () => {
    const { team, member, args, teamsDir, worktree } = fixture();
    mkdirSync(join(worktree, 'folder'));
    writeFileSync(join(worktree, 'large.txt'), '');
    truncateSync(join(worktree, 'large.txt'), 20 * 1024 * 1024 + 1);
    for (const path of ['missing.txt', 'folder', 'large.txt']) {
      expect(() => registerOutput(team, member, { ...args, path }, teamsDir, 0)).toThrow();
    }
    expect(() => registerOutput(team, member, { ...args, description: '' }, teamsDir, 0)).toThrow(/description/);
  });

  it('serves only registered IDs and keeps active document types inert', () => {
    const { team, member, args, teamsDir, worktree } = fixture();
    writeFileSync(join(worktree, 'page.html'), '<script>alert(1)</script>');
    const output = registerOutput(team, member, { ...args, path: 'page.html' }, teamsDir, 0);
    const state = { ...team, outputs: [output] };
    expect(readOutput(state, output.id, teamsDir)).toMatchObject({ kind: 'text', mime: 'text/plain;charset=utf-8' });
    expect(() => readOutput(state, '../report.md', teamsDir)).toThrow(/not found/);
    expect(() => readOutput(team, output.id, teamsDir)).toThrow(/not found/);
  });

  it('loads old teams without outputs', () => {
    expect(toView(fixture().team).outputs).toEqual([]);
  });
});
