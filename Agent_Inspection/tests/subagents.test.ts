import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../daemon/domain/registry.ts';
import { claudeProjectSlug } from '../daemon/collectors/claudeSessions.ts';
import {
  MAX_SUBAGENTS_PER_SESSION, SUBAGENT_ANSWER_QUIET_MS, SUBAGENT_LINGER_MS, SUBAGENT_SOURCE, SUBAGENT_STALE_MS, SUBAGENT_STOP_BLOCKED,
  SubagentCollector, finishedSubagentFromParentLine, parseSubagentMeta, subagentName, subagentRegistryId, subagentStatus, subagentStep,
} from '../daemon/collectors/subagents.ts';
import { makeAgent, tempDir } from './helpers.ts';

const SESSION = '11111111-2222-3333-4444-555555555555';
const CWD = 'C:\\work\\Demo App';
const PARENT_ID = `claude:${SESSION}`;
const T0 = Date.parse('2026-01-01T00:00:00Z');

const jsonl = (lines: readonly unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
const prompt = (text: string) => ({ type: 'user', isSidechain: true, agentId: 'x', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } });
const toolUse = (id: string, name: string, input: unknown, usage = { input_tokens: 10, output_tokens: 5 }) => ({
  type: 'assistant', isSidechain: true, timestamp: '2026-01-01T00:00:02Z',
  message: { id, model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'tool_use', id: `tu-${id}`, name, input }], usage },
});
const toolResult = () => ({ type: 'user', isSidechain: true, timestamp: '2026-01-01T00:00:03Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
const answer = (id: string, text: string) => ({
  type: 'assistant', isSidechain: true, timestamp: '2026-01-01T00:00:04Z',
  message: { id, model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } },
});

function fixture() {
  const projectsDir = join(tempDir(), 'projects');
  const dir = join(projectsDir, claudeProjectSlug(CWD), SESSION, 'subagents');
  mkdirSync(dir, { recursive: true });
  const registry = new AgentRegistry();
  registry.replaceSource('claude-sessions', [makeAgent({ id: PARENT_ID, sessionId: SESSION, cwd: CWD, project: 'Demo App', name: 'Parent task' })]);
  let now = T0;
  const collector = new SubagentCollector({ registry, projectsDir, now: () => now });
  const write = (agentId: string, lines: readonly unknown[], meta?: unknown, mtime = now) => {
    const path = join(dir, `agent-${agentId}.jsonl`);
    writeFileSync(path, jsonl(lines));
    if (meta !== undefined) writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
    utimesSync(path, mtime / 1000, mtime / 1000);
    return path;
  };
  const append = (agentId: string, lines: readonly unknown[]) => {
    const path = join(dir, `agent-${agentId}.jsonl`);
    appendFileSync(path, jsonl(lines));
    utimesSync(path, now / 1000, now / 1000);
  };
  return { registry, collector, write, append, setNow: (value: number) => { now = value; } };
}

const sub = (registry: AgentRegistry, agentId: string) => registry.get(subagentRegistryId(SESSION, agentId));

describe('subagent transcript parsing', () => {
  it('reads type, description and tool use id from the meta file', () => {
    // Arrange
    const text = JSON.stringify({ agentType: 'Explore', description: 'Map collectors', toolUseId: 'toolu_1', spawnDepth: 1 });
    // Act
    const meta = parseSubagentMeta(text);
    // Assert
    expect(meta).toEqual({ agentType: 'Explore', description: 'Map collectors', toolUseId: 'toolu_1' });
    expect(subagentName(meta, 'abc123456789')).toBe('Explore · Map collectors');
    expect(subagentName(undefined, 'abc123456789')).toBe('Subagent abc12345');
    expect(parseSubagentMeta('{not json')).toBeUndefined();
  });

  it('classifies the latest step of a subagent turn', () => {
    expect(subagentStep(toolUse('m1', 'Bash', { command: 'ls' }))).toBe('tool');
    expect(subagentStep(toolUse('m2', 'SubagentHandback', { message: 'done' }))).toBe('handback');
    expect(subagentStep(answer('m3', 'All done.'))).toBe('answer');
    expect(subagentStep(toolResult())).toBe('working');
    expect(subagentStep({ type: 'attachment' })).toBeUndefined();
  });

  it('spots completion reports in the parent transcript', () => {
    expect(finishedSubagentFromParentLine({ type: 'user', toolUseResult: { status: 'completed', agentId: 'abc' } })).toBe('abc');
    expect(finishedSubagentFromParentLine({ type: 'user', toolUseResult: { status: 'async_launched', agentId: 'abc' } })).toBeUndefined();
    expect(finishedSubagentFromParentLine({
      type: 'attachment', attachment: { type: 'queued_command', prompt: '<agent-message from="def">\n[Subagent hand-back] report' },
    })).toBe('def');
    expect(finishedSubagentFromParentLine({ type: 'assistant' })).toBeUndefined();
  });

  it('derives status from the step and how long the transcript has been quiet', () => {
    expect(subagentStatus({ finished: false, step: 'tool', quietMs: 60_000 })).toBe('busy');
    expect(subagentStatus({ finished: false, step: 'answer', quietMs: 1000 })).toBe('busy');
    expect(subagentStatus({ finished: false, step: 'answer', quietMs: SUBAGENT_ANSWER_QUIET_MS + 1 })).toBe('stopped');
    expect(subagentStatus({ finished: false, step: 'tool', quietMs: SUBAGENT_STALE_MS + 1 })).toBe('stopped');
    expect(subagentStatus({ finished: true, step: 'tool', quietMs: 0 })).toBe('stopped');
  });
});

describe('SubagentCollector', () => {
  it('lists a running subagent under its parent as a read-only agent', async () => {
    // Arrange
    const { registry, collector, write } = fixture();
    write('a1', [prompt('Find the collectors'), toolUse('m1', 'Grep', { pattern: 'collector' })], { agentType: 'Explore', description: 'Map collectors' });
    // Act
    await collector.scan();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await collector.scan();
    // Assert
    const agent = sub(registry, 'a1');
    expect(agent).toMatchObject({
      name: 'Explore · Map collectors', vendor: 'claude', tier: 'C', status: 'busy', parentId: PARENT_ID,
      cwd: CWD, project: 'Demo App', canInstruct: false, intercepting: false, hooked: false,
      stopBlockedReason: SUBAGENT_STOP_BLOCKED, currentActivity: 'Searching for “collector”', model: 'claude-sonnet-4-5',
      subagent: { type: 'Explore', description: 'Map collectors', parentName: 'Parent task' },
    });
    expect(agent?.sessionId).toBeUndefined();
    expect(agent?.pid).toBeUndefined();
    expect(agent?.usage?.tokens.input).toBe(10);
    expect(agent?.usage?.contextTokens).toBe(10);
    expect(registry.recentEvents(agent!.id).map((event) => event.kind)).toEqual(['prompt', 'tool_call']);
    expect(registry.get(PARENT_ID)?.name).toBe('Parent task');
  });

  it('marks a subagent stopped once it hands back, then drops it after the linger window', async () => {
    // Arrange
    const { registry, collector, write, append, setNow } = fixture();
    write('a2', [prompt('Review'), toolUse('m1', 'Read', { file_path: 'a.ts' })], { agentType: 'general-purpose', description: 'Review' });
    await collector.scan();
    expect(sub(registry, 'a2')?.status).toBe('busy');
    // Act
    append('a2', [toolResult(), toolUse('m2', 'SubagentHandback', { message: 'report' })]);
    await collector.scan();
    // Assert
    expect(sub(registry, 'a2')).toMatchObject({ status: 'stopped', currentActivity: 'Finished · reported back to its parent' });
    setNow(T0 + SUBAGENT_LINGER_MS + 1000);
    await collector.scan();
    expect(sub(registry, 'a2')).toBeUndefined();
  });

  it('treats a parent completion report as finished', async () => {
    // Arrange
    const { registry, collector, write } = fixture();
    write('a3', [prompt('Plan'), toolUse('m1', 'Bash', { command: 'npm test' })]);
    await collector.scan();
    // Act
    collector.noteParentLine(SESSION, { type: 'user', toolUseResult: { status: 'completed', agentId: 'a3' } });
    await collector.scan();
    // Assert
    expect(sub(registry, 'a3')?.status).toBe('stopped');
  });

  it('stops a subagent whose last message is a plain answer once it goes quiet', async () => {
    // Arrange
    const { registry, collector, write, setNow } = fixture();
    write('a4', [prompt('Summarize'), answer('m1', 'Here is the summary.')]);
    await collector.scan();
    expect(sub(registry, 'a4')?.status).toBe('busy');
    // Act
    setNow(T0 + SUBAGENT_ANSWER_QUIET_MS + 1000);
    await collector.scan();
    // Assert
    expect(sub(registry, 'a4')?.status).toBe('stopped');
  });

  it('removes subagents when the parent leaves the registry', async () => {
    // Arrange
    const { registry, collector, write } = fixture();
    write('a5', [prompt('Go'), toolUse('m1', 'Bash', { command: 'ls' })]);
    await collector.scan();
    expect(sub(registry, 'a5')).toBeDefined();
    // Act
    registry.replaceSource('claude-sessions', []);
    await collector.scan();
    // Assert
    expect(registry.list().filter((agent) => agent.parentId)).toEqual([]);
  });

  it('ignores old transcripts and caps how many subagents a session lists', async () => {
    // Arrange
    const { registry, collector, write } = fixture();
    write('old', [prompt('Ancient'), toolUse('m0', 'Bash', { command: 'ls' })], undefined, T0 - SUBAGENT_STALE_MS - SUBAGENT_LINGER_MS - 60_000);
    for (let i = 0; i < MAX_SUBAGENTS_PER_SESSION + 5; i += 1) {
      write(`n${i}`, [prompt(`Task ${i}`), toolUse(`m${i}`, 'Bash', { command: 'ls' })], undefined, T0 - i * 1000);
    }
    // Act
    await collector.scan();
    // Assert
    const subs = registry.list().filter((agent) => agent.parentId === PARENT_ID);
    expect(subs).toHaveLength(MAX_SUBAGENTS_PER_SESSION);
    expect(subs.some((agent) => agent.id.endsWith(':old'))).toBe(false);
    expect(subs.some((agent) => agent.id.endsWith(':n0'))).toBe(true);
    expect(SUBAGENT_SOURCE).toBe('claude-subagents');
  });

  it('does not treat subagents as parents of their own', async () => {
    // Arrange
    const { registry, collector, write } = fixture();
    registry.replaceSource('other', [makeAgent({ id: 'child', sessionId: 'other-session', cwd: CWD, parentId: PARENT_ID })]);
    write('a6', [prompt('Go'), toolUse('m1', 'Bash', { command: 'ls' })]);
    // Act
    await collector.scan();
    // Assert
    expect(registry.list().filter((agent) => agent.parentId === 'child')).toEqual([]);
    expect(sub(registry, 'a6')).toBeDefined();
  });
});

describe('card nesting (web)', () => {
  it('moves subagents directly under a listed parent and counts them', async () => {
    // Arrange
    const { nestSubagents } = await import('../web/src/crew.ts');
    const { subagentOfLabel } = await import('../web/src/format.ts');
    const parent = makeAgent({ id: 'p', name: 'Parent' });
    const other = makeAgent({ id: 'o', name: 'Other' });
    const child = makeAgent({ id: 'c', parentId: 'p', subagent: { parentName: 'Parent' } });
    const orphan = makeAgent({ id: 'x', parentId: 'gone' });
    // Act
    const nested = nestSubagents([child, other, parent, orphan]);
    // Assert
    expect(nested.map((entry) => [entry.agent.id, entry.nested, entry.subagentCount])).toEqual([
      ['o', false, 0], ['p', false, 1], ['c', true, 0], ['x', false, 0],
    ]);
    expect(subagentOfLabel(child)).toBe('Subagent of Parent');
    expect(subagentOfLabel(parent)).toBeUndefined();
  });
});
