import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GIT_TEST_IDENTITY, git, makeAgent, makeRepo, tempDir } from './helpers.ts';

const PORT = 47_333;
const TOKEN = 'outputs-token-0123456789';
const towerHome = join(tempDir('tower-'), 'agent-tower');
mkdirSync(towerHome, { recursive: true });
process.env.AGENT_TOWER_HOME = towerHome;
process.env.CLAUDE_HOME = tempDir('claude-home-');
// Some machines have a repository above the temp folder (even at the drive root); keep git from finding it.
process.env.GIT_CEILING_DIRECTORIES = tmpdir();

type Tower = import('../daemon/tower.ts').Tower;
let tower: Tower;
let server: Server;
let repo: string;
let plainDir: string;
const AGENT_ID = 'claude:outputs-agent';
const PLAIN_ID = 'claude:outputs-plain';

const api = async (path: string, token = TOKEN) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { 'x-tower-token': token } });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const diffOf = (id: string, path: string) => api(`/api/agents/${encodeURIComponent(id)}/outputs/diff?path=${encodeURIComponent(path)}`);

beforeAll(async () => {
  const { Tower } = await import('../daemon/tower.ts');
  const { startServer } = await import('../daemon/api/server.ts');
  tower = new Tower(':memory:');
  server = await startServer({ tower, port: PORT, host: '127.0.0.1', token: TOKEN });

  // Arrange: a repo where the agent edited one file, added another and committed once.
  const startedAt = Date.now() - 60_000;
  repo = makeRepo({ 'app.txt': 'hello\n', 'keep.txt': 'same\n', '.gitignore': 'local.env\n' });
  writeFileSync(join(repo, 'done.txt'), 'committed\n');
  git(repo, 'add', 'done.txt');
  git(repo, ...GIT_TEST_IDENTITY, 'commit', '-m', 'agent work');
  writeFileSync(join(repo, 'app.txt'), 'hello\nworld\n');
  writeFileSync(join(repo, 'new.txt'), 'api_key=abcdefghijklmnop\n');
  writeFileSync(join(repo, 'local.env'), 'ignored\n');

  plainDir = tempDir('outputs-plain-');
  writeFileSync(join(plainDir, 'notes.md'), '# notes\n');
  writeFileSync(join(plainDir, 'other.md'), 'not touched\n');

  tower.registry.upsert('test', makeAgent({ id: AGENT_ID, sessionId: 'outputs-agent', cwd: repo, startedAt, status: 'idle' }));
  tower.registry.upsert('test', makeAgent({ id: PLAIN_ID, sessionId: 'outputs-plain', cwd: plainDir, startedAt, status: 'idle' }));
  const push = (agentId: string, ts: number, kind: 'prompt' | 'assistant' | 'tool_call' | 'status', summary: string) =>
    tower.registry.pushEvent({ agentId, ts, kind, summary });
  push(AGENT_ID, startedAt + 1, 'prompt', 'Add a greeting');
  push(AGENT_ID, startedAt + 2, 'tool_call', `Edit: ${join(repo, 'app.txt')}`);
  push(AGENT_ID, startedAt + 3, 'tool_call', 'apply_patch: *** Begin Patch *** Add File: new.txt +x *** End Patch');
  push(AGENT_ID, startedAt + 4, 'assistant', 'Added **world** to `app.txt`.');
  push(AGENT_ID, startedAt + 5, 'status', 'turn complete (success)');
  push(PLAIN_ID, startedAt + 1, 'tool_call', `Write: ${join(plainDir, 'notes.md')}`);
});

afterAll(async () => {
  server?.close();
  await tower?.shutdown();
});

describe('GET /api/agents/:id/outputs', () => {
  it('returns turns, changed files, folder status and session commits for a git folder', async () => {
    // Act
    const { status, json } = await api(`/api/agents/${encodeURIComponent(AGENT_ID)}/outputs`);

    // Assert
    expect(status).toBe(200);
    const outputs = json.outputs;
    expect(outputs.turns).toHaveLength(1);
    expect(outputs.turns[0]).toMatchObject({ prompt: 'Add a greeting', result: 'Added **world** to `app.txt`.', complete: true });
    expect(outputs.files.map((file: { path: string }) => file.path)).toEqual(['new.txt', 'app.txt']);
    expect(outputs.files.find((file: { path: string }) => file.path === 'app.txt').gitStatus.trim()).toBe('M');
    expect(outputs.git.available).toBe(true);
    const statusPaths = outputs.git.status.map((entry: { path: string }) => entry.path);
    expect(statusPaths).toEqual(expect.arrayContaining(['app.txt', 'new.txt']));
    expect(statusPaths).not.toContain('local.env');
    expect(outputs.git.diffStat).toContain('app.txt');
    expect(outputs.git.commits.map((commit: { subject: string }) => commit.subject)).toContain('agent work');
  });

  it('reports git as unavailable for a folder that is not a repository', async () => {
    const { status, json } = await api(`/api/agents/${encodeURIComponent(PLAIN_ID)}/outputs`);
    expect(status).toBe(200);
    expect(json.outputs.git).toMatchObject({ available: false });
    expect(json.outputs.files[0]).toMatchObject({ path: 'notes.md', insideCwd: true });
  });

  it('rejects unknown agents and requests without the token', async () => {
    expect((await api('/api/agents/nope/outputs')).status).toBe(400);
    expect((await api(`/api/agents/${encodeURIComponent(AGENT_ID)}/outputs`, 'wrong-token-000000000000')).status).toBe(401);
  });
});

describe('GET /api/agents/:id/outputs/diff', () => {
  it('returns the uncommitted diff of a tracked file', async () => {
    const { status, json } = await diffOf(AGENT_ID, 'app.txt');
    expect(status).toBe(200);
    expect(json.diff.kind).toBe('diff');
    expect(json.diff.text).toContain('+world');
  });

  it('returns redacted content for a new untracked file', async () => {
    const { json } = await diffOf(AGENT_ID, 'new.txt');
    expect(json.diff.kind).toBe('untracked');
    expect(json.diff.text).toContain('[REDACTED]');
    expect(json.diff.text).not.toContain('abcdefghijklmnop');
  });

  it('says when a tracked file has no uncommitted changes, and withholds ignored files', async () => {
    expect((await diffOf(AGENT_ID, 'keep.txt')).json.diff.kind).toBe('clean');
    const ignored = (await diffOf(AGENT_ID, 'local.env')).json.diff;
    expect(ignored.kind).toBe('ignored');
    expect(ignored.text).toBe('');
  });

  it('refuses paths outside the folder, with .. segments, or under .git', async () => {
    expect((await diffOf(AGENT_ID, '../escape.txt')).status).toBe(400);
    expect((await diffOf(AGENT_ID, join(plainDir, 'notes.md'))).status).toBe(400);
    expect((await diffOf(AGENT_ID, '.git/config')).status).toBe(400);
    expect((await api(`/api/agents/${encodeURIComponent(AGENT_ID)}/outputs/diff`)).status).toBe(400);
  });

  it('previews only the agent\'s own files in a folder without git', async () => {
    const own = (await diffOf(PLAIN_ID, 'notes.md')).json.diff;
    expect(own).toMatchObject({ kind: 'preview', text: '# notes\n' });
    const other = (await diffOf(PLAIN_ID, 'other.md')).json.diff;
    expect(other.text).toBe('');
  });
});
