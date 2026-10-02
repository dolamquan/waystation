import { describe, expect, it } from 'vitest';
import { normalizeClaudeLine, normalizeCodexLine, parseCodexSessionMeta } from '../daemon/collectors/normalizers.ts';
import { normalizeCodexExecLine } from '../daemon/managed/codexRunner.ts';
import { claudeProjectSlug, parseClaudeSessionFile } from '../daemon/collectors/claudeSessions.ts';
import { candidateDayDirs } from '../daemon/collectors/codexSessions.ts';
import { describeToolInput, projectName, redact } from '../daemon/domain/text.ts';

const ID = 'agent-1';

describe('normalizeClaudeLine', () => {
  it('turns tool_use blocks into tool_call events', () => {
    const line = {
      type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
    };
    const { events } = normalizeClaudeLine(ID, line);
    expect(events).toEqual([{ agentId: ID, ts: Date.parse('2026-01-01T00:00:00.000Z'), kind: 'tool_call', summary: 'Bash: npm test' }]);
  });

  it('captures assistant text, user prompts, and titles', () => {
    expect(normalizeClaudeLine(ID, { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }).events[0].kind).toBe('assistant');
    expect(normalizeClaudeLine(ID, { type: 'user', message: { content: 'Fix the bug' } }).events[0]).toMatchObject({ kind: 'prompt', summary: 'Fix the bug' });
    expect(normalizeClaudeLine(ID, { type: 'ai-title', aiTitle: 'Refactor' }).title).toBe('Refactor');
  });

  it('ignores tool results, sidechains, thinking and junk', () => {
    expect(normalizeClaudeLine(ID, { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }).events).toEqual([]);
    expect(normalizeClaudeLine(ID, { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'x' }] } }).events).toEqual([]);
    expect(normalizeClaudeLine(ID, { type: 'assistant', message: { content: [{ type: 'thinking' }] } }).events).toEqual([]);
    expect(normalizeClaudeLine(ID, null).events).toEqual([]);
    expect(normalizeClaudeLine(ID, { type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>x' }] } }).events).toEqual([]);
  });
});

describe('normalizeCodexLine', () => {
  it('maps tool calls, messages and turn state', () => {
    const tool = normalizeCodexLine(ID, { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'ls -la' } });
    expect(tool.events[0]).toMatchObject({ kind: 'tool_call', summary: 'exec: ls -la' });
    const fn = normalizeCodexLine(ID, { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"x"}' } });
    expect(fn.events[0].kind).toBe('tool_call');
    expect(normalizeCodexLine(ID, { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] } }).events[0].kind).toBe('assistant');
    expect(normalizeCodexLine(ID, { type: 'event_msg', payload: { type: 'user_message', message: 'go' } }).events[0].kind).toBe('prompt');
    expect(normalizeCodexLine(ID, { type: 'event_msg', payload: { type: 'agent_message', message: 'ok' } }).events[0].kind).toBe('assistant');
    expect(normalizeCodexLine(ID, { type: 'event_msg', payload: { type: 'task_started' } }).events[0].summary).toBe('turn started');
    expect(normalizeCodexLine(ID, { type: 'event_msg', payload: { type: 'task_complete' } }).events[0].summary).toBe('turn complete');
  });

  it('ignores developer messages and unknown entries', () => {
    expect(normalizeCodexLine(ID, { type: 'response_item', payload: { type: 'message', role: 'developer', content: [] } }).events).toEqual([]);
    expect(normalizeCodexLine(ID, { type: 'world_state' }).events).toEqual([]);
  });

  it('parses session_meta', () => {
    const meta = parseCodexSessionMeta({ type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: 'abc', cwd: 'C:\\p', originator: 'codex_vscode' } });
    expect(meta).toMatchObject({ id: 'abc', cwd: 'C:\\p', originator: 'codex_vscode' });
    expect(parseCodexSessionMeta({ type: 'event_msg', payload: {} })).toBeUndefined();
  });
});

describe('codex exec output', () => {
  it('maps thread, messages, commands and completion', () => {
    expect(normalizeCodexExecLine({ type: 'thread.started', thread_id: 't1' })).toMatchObject({ threadId: 't1' });
    expect(normalizeCodexExecLine({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } })).toMatchObject({ kind: 'assistant' });
    expect(normalizeCodexExecLine({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } })).toMatchObject({ kind: 'tool_call', summary: 'shell: ls' });
    expect(normalizeCodexExecLine({ type: 'turn.completed' })).toMatchObject({ kind: 'status' });
    expect(normalizeCodexExecLine({ type: 'turn.failed', error: 'x' })).toMatchObject({ kind: 'error' });
    expect(normalizeCodexExecLine({ type: 'other' })).toBeUndefined();
  });
});

describe('session files and paths', () => {
  it('parses a Claude session registry file and rejects bad ones', () => {
    const parsed = parseClaudeSessionFile(JSON.stringify({ pid: 1, sessionId: 's', cwd: 'C:\\x', status: 'busy', updatedAt: 5 }));
    expect(parsed).toMatchObject({ pid: 1, sessionId: 's', status: 'busy', updatedAt: 5 });
    expect(parseClaudeSessionFile('{"pid": 1')).toBeUndefined();
    expect(parseClaudeSessionFile('{"pid":"1","sessionId":"s"}')).toBeUndefined();
  });

  it('builds Claude project slugs like Claude Code does', () => {
    expect(claudeProjectSlug('c:\\Users\\me\\OneDrive\\Documents\\AI Engineer')).toBe('c--Users-me-OneDrive-Documents-AI-Engineer');
  });

  it('scans today and yesterday day folders', () => {
    const dirs = candidateDayDirs('/root', new Date('2026-03-01T12:00:00Z'));
    expect(dirs.some((d) => d.replace(/\\/g, '/').endsWith('2026/03/01'))).toBe(true);
    expect(dirs.some((d) => d.replace(/\\/g, '/').endsWith('2026/02/28'))).toBe(true);
  });
});

describe('text helpers', () => {
  it('redacts common secret shapes', () => {
    const text = 'key sk-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz12 Bearer abcdefghijklmnopqrstu api_key=supersecret1';
    const out = redact(text);
    expect(out).not.toMatch(/sk-abc|ghp_abc|abcdefghijklmnopqrstu$|supersecret1/);
    expect(out).toContain('[REDACTED]');
  });

  it('names projects and describes tool input', () => {
    expect(projectName('C:\\a\\b\\proj\\')).toBe('proj');
    expect(projectName(undefined)).toBe('unknown project');
    expect(describeToolInput('Read', { file_path: '/x/y.ts' })).toBe('Read: /x/y.ts');
    expect(describeToolInput('Weird', { nested: { a: 1 } })).toBe('Weird');
    expect(describeToolInput('Raw', 'echo hi')).toBe('Raw: echo hi');
  });
});
