import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TowerStore } from '../daemon/store/db.ts';
import { SessionHistory } from '../daemon/sessions/history.ts';
import { makeAgent, tempDir } from './helpers.ts';

describe('session history', () => {
  it('persists observed runtimes without claiming conversation recovery or matching absent session ids', () => {
    const path = join(tempDir(), 'history.db');
    let store = new TowerStore(path);
    let history = new SessionHistory(store);
    const agent = makeAgent({ id: 'proc:1:created', sessionId: undefined, tier: 'C', vendor: 'other', providerId: 'copilot', providerLabel: 'GitHub Copilot', observation: { processName: 'copilot-runtime.exe', created: '2026-10-19T00:00:00Z', host: 'editor' } });
    history.sync([agent], () => undefined);
    expect(history.list([agent])[0]).toMatchObject({ live: true, canResume: false });
    history.sync([], () => undefined);
    expect(history.list([makeAgent({ id: 'proc:2', vendor: 'other', sessionId: undefined })])[0]).toMatchObject({ live: false, state: 'finished', canResume: false, resumeBlockedReason: expect.stringContaining('Process detection') });
    store.close();
    store = new TowerStore(path); history = new SessionHistory(store);
    expect(history.list([])[0].agent.providerLabel).toBe('GitHub Copilot');
    store.close();
  });
  it('keeps project-searchable history and interrupted recovery without persisting credentials', () => {
    const path = join(tempDir(), 'sessions.db');
    let store = new TowerStore(path);
    let history = new SessionHistory(store);
    const agent = makeAgent({ id: 'managed:test', tier: 'A', vendor: 'codex', sessionId: 'thread', cwd: tempDir(), pid: undefined });
    history.remember(agent);
    history.rememberLaunch(agent.id, { vendor: 'codex', cwd: agent.cwd!, prompt: 'Original request', env: { SECRET: 'never-save' },
      mcpServers: { private: { command: 'tool', args: [], env: { SECRET: 'never-save' } } } });
    history.event({ agentId: agent.id, ts: Date.now(), kind: 'assistant', summary: 'Result for database migration' });
    store.recordEvent({ agentId: agent.id, ts: 1, kind: 'prompt', summary: 'old request' });
    store.recordEvent({ agentId: agent.id, ts: 2, kind: 'tool_result', summary: 'check complete', tool: { command: 'npm test', exitCode: 0, output: '24 passed' } });
    store.pruneOlderThan(Date.now());
    expect(store.eventsFor(agent.id)).toHaveLength(2);
    expect(JSON.stringify(store.loadRecords('session_history'))).not.toContain('never-save');
    store.close();
    store = new TowerStore(path); history = new SessionHistory(store);
    expect(store.eventsFor(agent.id)[1].tool).toEqual({ command: 'npm test', exitCode: 0, output: '24 passed' });
    expect(history.list([], 'migration', agent.cwd)[0]).toMatchObject({ state: 'interrupted', live: false, canResume: true });
    expect(history.archivedAgent(agent.id)).toMatchObject({ status: 'stopped', canInstruct: false, pid: undefined });
    expect(history.list([agent])[0]).toMatchObject({ state: 'active', canResume: false });
    store.close();
  });
  it('keeps finished work separate from the live fleet and blocks missing conversation recovery', () => {
    const store = new TowerStore(':memory:');
    const history = new SessionHistory(store);
    const agent = makeAgent({ id: 'managed:new', tier: 'A', sessionId: undefined });
    history.sync([agent], () => undefined);
    history.sync([], () => undefined);
    expect(history.list([])[0]).toMatchObject({ state: 'interrupted', canResume: false });
    expect(history.list([])[0].resumeBlockedReason).toMatch(/conversation id/);
    store.close();
  });
});
