import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../daemon/domain/registry.ts';
import { ClaudeSessionsCollector, CLAUDE_SOURCE, claudeProjectSlug, isPidAlive } from '../daemon/collectors/claudeSessions.ts';
import { CodexSessionsCollector, CODEX_STOP_BLOCKED, candidateDayDirs } from '../daemon/collectors/codexSessions.ts';
import type { ProcInfo } from '../daemon/collectors/processScanner.ts';
import { tempDir } from './helpers.ts';

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function claudeFixture() {
  const root = tempDir();
  const sessionsDir = join(root, 'sessions');
  const projectsDir = join(root, 'projects');
  const cwd = 'C:\\work\\My Project';
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(join(projectsDir, claudeProjectSlug(cwd)), { recursive: true });
  writeFileSync(join(sessionsDir, '100.json'), JSON.stringify({
    pid: 100, sessionId: SESSION, cwd, status: 'busy', entrypoint: 'claude-vscode', name: 'derived-name', startedAt: 1, updatedAt: 2,
  }));
  writeFileSync(join(sessionsDir, '200.json'), JSON.stringify({ pid: 200, sessionId: 'dead-session', cwd, status: 'idle' }));
  const transcript = join(projectsDir, claudeProjectSlug(cwd), `${SESSION}.jsonl`);
  writeFileSync(transcript, [
    { type: 'ai-title', aiTitle: 'Fix flaky tests' },
    { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'please fix tests' } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { sessionsDir, projectsDir };
}

describe('ClaudeSessionsCollector', () => {
  it('lists live sessions with title, project and activity from the transcript', async () => {
    const { sessionsDir, projectsDir } = claudeFixture();
    const registry = new AgentRegistry();
    const collector = new ClaudeSessionsCollector({
      registry, sessionsDir, projectsDir, hooksInstalled: () => false, isIntercepting: () => false, isAlive: (pid) => pid === 100,
    });
    await collector.scan();
    const agents = registry.list();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: `claude:${SESSION}`, name: 'Fix flaky tests', project: 'My Project', status: 'busy', tier: 'B',
      currentActivity: 'Bash: npm test', hooked: false, canInstruct: false, source: 'Claude Code · VS Code',
    });
    expect(registry.recentEvents(`claude:${SESSION}`).map((e) => e.kind)).toEqual(['prompt', 'tool_call']);
    expect(collector.sessionFileFor(SESSION)?.pid).toBe(100);
  });

  it('keeps the last good parse when a session file is half-written', async () => {
    const { sessionsDir, projectsDir } = claudeFixture();
    const registry = new AgentRegistry();
    const collector = new ClaudeSessionsCollector({
      registry, sessionsDir, projectsDir, hooksInstalled: () => true, isIntercepting: () => true, isAlive: () => true,
    });
    await collector.scan();
    writeFileSync(join(sessionsDir, '100.json'), '{"pid": 100, "sessionId": "aaaa');
    await collector.scan();
    const agent = registry.get(`claude:${SESSION}`);
    expect(agent).toMatchObject({ hooked: true, intercepting: true, canInstruct: true });
  });

  it('skips transcript tool calls when hooks provide them, and records hook activity', async () => {
    const { sessionsDir, projectsDir } = claudeFixture();
    const registry = new AgentRegistry();
    const collector = new ClaudeSessionsCollector({
      registry, sessionsDir, projectsDir, hooksInstalled: () => true, isIntercepting: () => false, isAlive: (pid) => pid === 100,
    });
    await collector.scan();
    expect(registry.recentEvents(`claude:${SESSION}`).map((e) => e.kind)).toEqual(['prompt']);
    collector.noteActivity(SESSION, { agentId: `claude:${SESSION}`, ts: Date.now(), kind: 'tool_call', summary: 'Edit: a.ts' });
    collector.noteActivity('unknown', { agentId: 'x', ts: 1, kind: 'tool_call', summary: 'ignored' });
    await collector.scan();
    expect(registry.get(`claude:${SESSION}`)?.currentActivity).toBe('Edit: a.ts');
  });

  it('hides sessions owned by managed runners and survives a missing directory', async () => {
    const { sessionsDir, projectsDir } = claudeFixture();
    const registry = new AgentRegistry();
    const collector = new ClaudeSessionsCollector({
      registry, sessionsDir, projectsDir, hooksInstalled: () => false, isIntercepting: () => false,
      isAlive: () => true, isManagedSession: (id) => id === SESSION,
    });
    await collector.scan();
    expect(registry.list().map((a) => a.sessionId)).toEqual(['dead-session']);
    const empty = new ClaudeSessionsCollector({
      registry: new AgentRegistry(), sessionsDir: join(sessionsDir, 'missing'), hooksInstalled: () => false, isIntercepting: () => false,
    });
    await empty.scan();
  });

  it('starts and stops polling', async () => {
    vi.useFakeTimers();
    const registry = new AgentRegistry();
    const collector = new ClaudeSessionsCollector({ registry, sessionsDir: tempDir(), hooksInstalled: () => false, isIntercepting: () => false });
    collector.start();
    collector.stop();
    vi.useRealTimers();
    expect(registry.list()).toEqual([]);
    expect(CLAUDE_SOURCE).toBe('claude-sessions');
  });

  it('detects whether a pid is alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 30)).toBe(false);
  });
});

const codexBackend: ProcInfo = { pid: 9, ppid: 1, name: 'codex.exe', commandLine: 'codex app-server', created: '' };

function codexFixture(now: Date, minutesAgo: number) {
  const root = tempDir();
  const dayDir = candidateDayDirs(root, now)[0];
  mkdirSync(dayDir, { recursive: true });
  const file = join(dayDir, 'rollout-1.jsonl');
  writeFileSync(file, [
    { type: 'session_meta', timestamp: now.toISOString(), payload: { id: 'codex-thread', cwd: 'C:\\code\\api', originator: 'codex_vscode' } },
    { type: 'event_msg', timestamp: now.toISOString(), payload: { type: 'task_started' } },
    { type: 'response_item', timestamp: now.toISOString(), payload: { type: 'custom_tool_call', name: 'exec', input: 'rg TODO' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const mtime = new Date(now.getTime() - minutesAgo * 60_000);
  utimesSync(file, mtime, mtime);
  return { root, file };
}

describe('CodexSessionsCollector', () => {
  it('lists recent rollouts as observe-only agents while a Codex backend runs', async () => {
    const now = new Date();
    const { root } = codexFixture(now, 0);
    const registry = new AgentRegistry();
    const collector = new CodexSessionsCollector(registry, () => [codexBackend], root);
    await collector.scan(now.getTime());
    const [agent] = registry.list();
    expect(agent).toMatchObject({
      id: 'codex:codex-thread', vendor: 'codex', tier: 'C', project: 'api', status: 'busy',
      currentActivity: 'exec: rg TODO', canInstruct: false, stopBlockedReason: CODEX_STOP_BLOCKED,
    });
  });

  it('drops everything when no Codex process is running, and ignores stale rollouts', async () => {
    const now = new Date();
    const { root } = codexFixture(now, 0);
    const registry = new AgentRegistry();
    await new CodexSessionsCollector(registry, () => [], root).scan(now.getTime());
    expect(registry.list()).toEqual([]);
    const stale = codexFixture(now, 120);
    await new CodexSessionsCollector(registry, () => [codexBackend], stale.root).scan(now.getTime());
    expect(registry.list()).toEqual([]);
  });

  it('reports idle once a turn completes and the file is quiet', async () => {
    const now = new Date();
    const { root, file } = codexFixture(now, 5);
    writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: 'quiet', cwd: 'C:\\q' } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
    const mtime = new Date(now.getTime() - 5 * 60_000);
    utimesSync(file, mtime, mtime);
    const registry = new AgentRegistry();
    const collector = new CodexSessionsCollector(registry, () => [codexBackend], root);
    await collector.scan(now.getTime());
    expect(registry.get('codex:quiet')?.status).toBe('idle');
    collector.start();
    collector.stop();
  });

  it('reads session_meta lines far longer than one read chunk (real Codex embeds full instructions)', async () => {
    const now = new Date();
    const { root, file } = codexFixture(now, 0);
    const meta = { type: 'session_meta', payload: { id: 'long-meta', cwd: 'C:\\big', base_instructions: 'x'.repeat(200_000) } };
    writeFileSync(file, `${JSON.stringify(meta)}\n`);
    const registry = new AgentRegistry();
    await new CodexSessionsCollector(registry, () => [codexBackend], root).scan(now.getTime());
    expect(registry.get('codex:long-meta')?.project).toBe('big');
  });

  it('skips files without session_meta', async () => {
    const now = new Date();
    const { root, file } = codexFixture(now, 0);
    writeFileSync(file, 'garbage\n');
    const registry = new AgentRegistry();
    await new CodexSessionsCollector(registry, () => [codexBackend], root).scan(now.getTime());
    expect(registry.list()).toEqual([]);
  });
});
