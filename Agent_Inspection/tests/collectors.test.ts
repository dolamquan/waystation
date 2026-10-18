import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../daemon/domain/registry.ts';
import { ClaudeSessionsCollector, CLAUDE_SOURCE, claudeProjectSlug, isPidAlive } from '../daemon/collectors/claudeSessions.ts';
import { CodexSessionsCollector, CODEX_STOP_BLOCKED, candidateDayDirs } from '../daemon/collectors/codexSessions.ts';
import type { ProcInfo } from '../daemon/collectors/processScanner.ts';
import { makeAgent, tempDir } from './helpers.ts';

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
      currentActivity: 'Running npm test', hooked: false, canInstruct: false, source: 'Claude Code · VS Code',
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
    expect(registry.get(`claude:${SESSION}`)?.currentActivity).toBe('Editing a.ts');
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

  it('lists subagents of a live session without changing the parent listing', async () => {
    // Arrange
    const { sessionsDir, projectsDir } = claudeFixture();
    const subDir = join(projectsDir, claudeProjectSlug('C:\\work\\My Project'), SESSION, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-s1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Map collectors' }));
    writeFileSync(join(subDir, 'agent-s1.jsonl'), JSON.stringify({
      type: 'assistant', isSidechain: true, timestamp: '2026-01-01T00:00:05Z',
      message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'collector' } }] },
    }) + '\n');
    const registry = new AgentRegistry();
    const collector = new ClaudeSessionsCollector({
      registry, sessionsDir, projectsDir, hooksInstalled: () => false, isIntercepting: () => false, isAlive: (pid) => pid === 100,
    });
    // Act
    await collector.scan();
    // Assert
    const parent = registry.get(`claude:${SESSION}`);
    expect(parent).toMatchObject({ name: 'Fix flaky tests', status: 'busy' });
    expect(parent?.parentId).toBeUndefined();
    expect(registry.findBySessionId(SESSION)?.id).toBe(`claude:${SESSION}`);
    expect(registry.get(`claude-sub:${SESSION}:s1`)).toMatchObject({
      name: 'Explore · Map collectors', parentId: `claude:${SESSION}`, canInstruct: false, currentActivity: 'Searching for “collector”',
    });
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
const OPEN_ID = '01a0feb2-7d30-7733-a0c5-f73157b5e6d7';
const CLOSED_ID = '01a0fe5c-bfc6-7780-975d-15c30cc0f770';

/** Older Codex without a thread-writer-locks folder: liveness falls back to turn and time heuristics. */
const legacyCodex = (...[registry, getProcs, root]: ConstructorParameters<typeof CodexSessionsCollector>) =>
  new CodexSessionsCollector(registry, getProcs, root, join(root ?? tempDir(), 'no-thread-writer-locks'));

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
  it('links a spawned Codex agent to its managed parent rather than a duplicate observed thread', async () => {
    const now = new Date();
    const { root, file } = codexFixture(now, 0);
    writeFileSync(file, JSON.stringify({ type: 'session_meta', timestamp: now.toISOString(), payload: {
      id: 'child', cwd: 'C:\\code\\api', originator: 'codex_vscode', parent_thread_id: 'parent-thread', source: { subagent: { other: 'guardian' } },
    } }) + '\n');
    const registry = new AgentRegistry();
    registry.replaceSource('managed', [makeAgent({ id: 'managed:parent', vendor: 'codex', tier: 'A', sessionId: 'parent-thread', name: 'Build the app' })]);
    await legacyCodex(registry, () => [codexBackend], root).scan(now.getTime());
    expect(registry.get('codex:child')).toMatchObject({ parentId: 'managed:parent', name: 'guardian · api', subagent: { type: 'guardian', parentName: 'Build the app' } });
    registry.replaceSource('managed', []);
    await legacyCodex(registry, () => [codexBackend], root).scan(now.getTime());
    expect(registry.get('codex:child')?.parentId).toBe('codex:parent-thread');
  });

  it('lists recent rollouts as observe-only agents while a Codex backend runs', async () => {
    const now = new Date();
    const { root } = codexFixture(now, 0);
    const registry = new AgentRegistry();
    const collector = legacyCodex(registry, () => [codexBackend], root);
    await collector.scan(now.getTime());
    const [agent] = registry.list();
    expect(agent).toMatchObject({
      id: 'codex:codex-thread', vendor: 'codex', tier: 'C', project: 'api', status: 'busy',
      currentActivity: 'Running rg TODO', canInstruct: false, stopBlockedReason: CODEX_STOP_BLOCKED,
    });
  });

  it('names a Codex thread after its first request instead of its folder', async () => {
    // Arrange
    const now = new Date();
    const { root, file } = codexFixture(now, 0);
    const prompt = (message: string) => JSON.stringify({ type: 'event_msg', timestamp: now.toISOString(), payload: { type: 'user_message', message } });
    appendFileSync(file, `${prompt('<environment_context>cwd</environment_context>')}\n${prompt('add retries to the uploader. Then rerun tests')}\n${prompt('also bump the version')}\n`);
    const registry = new AgentRegistry();
    // Act
    await legacyCodex(registry, () => [codexBackend], root).scan(now.getTime());
    // Assert
    expect(registry.get('codex:codex-thread')?.name).toBe('Add retries to the uploader');
  });

  it('falls back to the folder name when a Codex thread has no request yet', async () => {
    const now = new Date();
    const { root } = codexFixture(now, 0);
    const registry = new AgentRegistry();
    await legacyCodex(registry, () => [codexBackend], root).scan(now.getTime());
    expect(registry.get('codex:codex-thread')?.name).toBe('Codex · api');
  });

  it('drops everything when no Codex process is running, and ignores stale rollouts', async () => {
    const now = new Date();
    const { root } = codexFixture(now, 0);
    const registry = new AgentRegistry();
    await legacyCodex(registry, () => [], root).scan(now.getTime());
    expect(registry.list()).toEqual([]);
    const stale = codexFixture(now, 120);
    await legacyCodex(registry, () => [codexBackend], stale.root).scan(now.getTime());
    expect(registry.list()).toEqual([]);
  });

  it('reports idle once a turn completes and the file is quiet', async () => {
    const now = new Date();
    const { root, file } = codexFixture(now, 5);
    writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: 'quiet', cwd: 'C:\\q' } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
    const mtime = new Date(now.getTime() - 5 * 60_000);
    utimesSync(file, mtime, mtime);
    const registry = new AgentRegistry();
    const collector = legacyCodex(registry, () => [codexBackend], root);
    await collector.scan(now.getTime());
    expect(registry.get('codex:quiet')?.status).toBe('idle');
    collector.start();
    collector.stop();
  });

  it('drops idle threads once they have been quiet longer than the idle window', async () => {
    const now = new Date();
    const { root, file } = codexFixture(now, 15);
    const mtime = new Date(now.getTime() - 15 * 60_000);
    writeFileSync(file, `${JSON.stringify({ type: 'session_meta', timestamp: mtime.toISOString(), payload: { id: 'closed', cwd: 'C:\\q', originator: 'codex_vscode' } })}\n${JSON.stringify({ type: 'event_msg', timestamp: mtime.toISOString(), payload: { type: 'task_complete' } })}\n`);
    utimesSync(file, mtime, mtime);
    const registry = new AgentRegistry();
    await legacyCodex(registry, () => [codexBackend], root).scan(now.getTime());
    expect(registry.list()).toEqual([]);
  });

  it('measures the idle window from the last turn, not from housekeeping writes when a thread is closed', async () => {
    const now = new Date();
    const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
    const { root, file } = codexFixture(now, 0);
    writeFileSync(file, [
      { type: 'session_meta', timestamp: at(60), payload: { id: 'closed-later', cwd: 'C:\\q', originator: 'codex_vscode' } },
      { type: 'event_msg', timestamp: at(60), payload: { type: 'task_complete' } },
      { type: 'event_msg', timestamp: at(1), payload: { type: 'item_completed' } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const registry = new AgentRegistry();
    await legacyCodex(registry, () => [codexBackend], root).scan(now.getTime());
    expect(registry.list()).toEqual([]);
  });

  describe('with Codex thread-writer locks (one <threadId>.lock per open thread)', () => {
    function rollout(dir: string, id: string, minutesAgo: number, lastEvent: 'task_started' | 'task_complete') {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `rollout-2020-01-01T00-00-00-${id}.jsonl`);
      const ts = new Date(Date.now() - minutesAgo * 60_000);
      writeFileSync(file, [
        { type: 'session_meta', timestamp: ts.toISOString(), payload: { id, cwd: 'C:\\code\\api', originator: 'codex_vscode' } },
        { type: 'event_msg', timestamp: ts.toISOString(), payload: { type: lastEvent } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n');
      utimesSync(file, ts, ts);
    }

    function setup() {
      const root = tempDir();
      const locks = tempDir();
      writeFileSync(join(locks, '.coordination.lock'), '');
      return { root, locks };
    }

    it('keeps an open thread listed however long it has been idle, even in an old day folder', async () => {
      const { root, locks } = setup();
      rollout(join(root, '2020', '01', '01'), OPEN_ID, 180, 'task_complete');
      writeFileSync(join(locks, `${OPEN_ID}.lock`), '');
      const registry = new AgentRegistry();
      await new CodexSessionsCollector(registry, () => [codexBackend], root, locks).scan();
      expect(registry.get(`codex:${OPEN_ID}`)?.status).toBe('idle');
    });

    it('drops a thread as soon as its lock is released, even mid-turn and freshly written', async () => {
      const now = new Date();
      const { root, locks } = setup();
      rollout(candidateDayDirs(root, now)[0], CLOSED_ID, 0, 'task_started');
      const registry = new AgentRegistry();
      const collector = new CodexSessionsCollector(registry, () => [codexBackend], root, locks);
      writeFileSync(join(locks, `${CLOSED_ID}.lock`), '');
      await collector.scan(now.getTime());
      expect(registry.get(`codex:${CLOSED_ID}`)).toBeDefined();
      rmSync(join(locks, `${CLOSED_ID}.lock`));
      await collector.scan(now.getTime());
      expect(registry.list()).toEqual([]);
    });
  });

  describe('codex exec runs', () => {
    const execProc: ProcInfo = { pid: 12, ppid: 1, name: 'codex.exe', commandLine: 'codex.exe exec --json "fix the build"', created: '' };

    function execFixture(now: Date, lastEvent: 'task_started' | 'task_complete') {
      const { root, file } = codexFixture(now, 0);
      writeFileSync(file, [
        { type: 'session_meta', payload: { id: 'exec-run', cwd: 'C:\\code\\builder', originator: 'codex_exec' } },
        { type: 'event_msg', payload: { type: 'task_started' } },
        ...(lastEvent === 'task_complete' ? [{ type: 'event_msg', payload: { type: 'task_complete' } }] : []),
      ].map((l) => JSON.stringify(l)).join('\n') + '\n');
      return root;
    }

    it('does not rediscover a Waystation-managed exec run or emit its transcript events twice', async () => {
      const now = new Date();
      const root = execFixture(now, 'task_started');
      const registry = new AgentRegistry();
      const managed = makeAgent({ id: 'managed:designer', vendor: 'codex', tier: 'A', name: 'UI Designer', sessionId: 'exec-run' });
      registry.upsert('managed', managed);
      const onEvent = vi.fn();
      registry.on('event', onEvent);
      const collector = legacyCodex(registry, () => [codexBackend, execProc], root);
      await collector.scan(now.getTime());
      await collector.scan(now.getTime());
      expect(registry.list()).toEqual([managed]);
      expect(onEvent).not.toHaveBeenCalled();
      expect(registry.recentEvents('codex:exec-run')).toEqual([]);
    });

    it('stops observing a run when its runner acquires the session after discovery', async () => {
      const now = new Date();
      const root = execFixture(now, 'task_started');
      const registry = new AgentRegistry();
      const collector = legacyCodex(registry, () => [codexBackend, execProc], root);
      await collector.scan(now.getTime());
      expect(registry.get('codex:exec-run')).toBeDefined();
      const managed = makeAgent({ id: 'managed:designer', vendor: 'codex', tier: 'A', name: 'UI Designer', sessionId: 'exec-run' });
      registry.upsert('managed', managed);
      expect(registry.list()).toEqual([managed]);
      await collector.scan(now.getTime());
      registry.drop('managed', managed.id);
      expect(registry.list()).toEqual([]);
      await collector.scan(now.getTime());
      expect(registry.get('codex:exec-run')).toBeDefined();
    });

    it('lists a run while its turn is open and a codex exec process is running', async () => {
      const now = new Date();
      const registry = new AgentRegistry();
      await legacyCodex(registry, () => [codexBackend, execProc], execFixture(now, 'task_started')).scan(now.getTime());
      expect(registry.get('codex:exec-run')?.status).toBe('busy');
    });

    it('drops a run as soon as its turn completes, because codex exec exits after one turn', async () => {
      const now = new Date();
      const registry = new AgentRegistry();
      await legacyCodex(registry, () => [codexBackend, execProc], execFixture(now, 'task_complete')).scan(now.getTime());
      expect(registry.list()).toEqual([]);
    });

    it('drops an unfinished run when no codex exec process is left (crashed or killed)', async () => {
      const now = new Date();
      const registry = new AgentRegistry();
      await legacyCodex(registry, () => [codexBackend], execFixture(now, 'task_started')).scan(now.getTime());
      expect(registry.list()).toEqual([]);
    });
  });

  it('reads session_meta lines far longer than one read chunk (real Codex embeds full instructions)', async () => {
    const now = new Date();
    const { root, file } = codexFixture(now, 0);
    const meta = { type: 'session_meta', payload: { id: 'long-meta', cwd: 'C:\\big', base_instructions: 'x'.repeat(200_000) } };
    writeFileSync(file, `${JSON.stringify(meta)}\n`);
    const registry = new AgentRegistry();
    await legacyCodex(registry, () => [codexBackend], root).scan(now.getTime());
    expect(registry.get('codex:long-meta')?.project).toBe('big');
  });

  it('skips files without session_meta', async () => {
    const now = new Date();
    const { root, file } = codexFixture(now, 0);
    writeFileSync(file, 'garbage\n');
    const registry = new AgentRegistry();
    await legacyCodex(registry, () => [codexBackend], root).scan(now.getTime());
    expect(registry.list()).toEqual([]);
  });
});
