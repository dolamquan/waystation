import { describe, expect, it } from 'vitest';
import { activityFromEvent, plainToolActivity } from '../shared/plainActivity.ts';
import { describeToolInput, taskTitle } from '../daemon/domain/text.ts';
import { normalizeClaudeLine, normalizeCodexLine } from '../daemon/collectors/normalizers.ts';

describe('plainToolActivity', () => {
  it('describes common tools as plain sentences', () => {
    expect(plainToolActivity('Bash: npm test')).toBe('Running npm test');
    expect(plainToolActivity('exec_command: git status')).toBe('Running git status');
    expect(plainToolActivity('Read: C:\\repo\\daemon\\api\\server.ts')).toBe('Reading server.ts');
    expect(plainToolActivity('Edit: /repo/web/src/App.tsx')).toBe('Editing App.tsx');
    expect(plainToolActivity('Write: /repo/notes.md')).toBe('Writing notes.md');
    expect(plainToolActivity('Grep: TODO')).toBe('Searching for “TODO”');
    expect(plainToolActivity('Glob: **/*.ts')).toBe('Looking for files matching **/*.ts');
    expect(plainToolActivity('WebSearch: vite 8 release')).toBe('Searching the web for “vite 8 release”');
    expect(plainToolActivity('WebFetch: https://example.com/docs/page')).toBe('Reading a page on example.com');
    expect(plainToolActivity('Task: Explore the collectors')).toBe('Handing off: Explore the collectors');
    expect(plainToolActivity('TodoWrite')).toBe('Updating its to-do list');
    expect(plainToolActivity('mcp__github__create_issue: x')).toBe('Using github (create issue)');
  });

  it('names the file an apply_patch touches', () => {
    expect(plainToolActivity('apply_patch: *** Begin Patch *** Update File: web/src/App.tsx @@')).toBe('Editing App.tsx');
    expect(plainToolActivity('apply_patch: *** Begin Patch')).toBe('Editing files');
  });

  it('marks held calls as waiting for approval', () => {
    expect(plainToolActivity('⏸ Bash: rm -rf dist')).toBe('Waiting for approval: Running rm -rf dist');
  });

  it('keeps unknown tools readable', () => {
    expect(plainToolActivity('deploy_site: prod')).toBe('deploy site: prod');
    expect(plainToolActivity('Frobnicate')).toBe('Using Frobnicate');
  });

  it('only rewrites tool calls', () => {
    expect(activityFromEvent({ kind: 'assistant', summary: 'Note: all done' })).toBe('Note: all done');
    expect(activityFromEvent({ kind: 'tool_call', summary: 'Read: a/b.ts' })).toBe('Reading b.ts');
  });
});

describe('describeToolInput with JSON-string arguments (Codex)', () => {
  it('reads the interesting field from a JSON string', () => {
    expect(describeToolInput('exec_command', '{"cmd":"npm test","workdir":"C:/x"}')).toBe('exec_command: npm test');
  });

  it('uses the script of an argv-style command', () => {
    expect(describeToolInput('shell', '{"command":["bash","-lc","git status"]}')).toBe('shell: git status');
    expect(describeToolInput('shell', { command: ['ls', '-la'] })).toBe('shell: ls -la');
  });

  it('keeps plain strings as they are', () => {
    expect(describeToolInput('Raw', 'echo hi')).toBe('Raw: echo hi');
  });
});

describe('taskTitle', () => {
  it('turns the first request into a short task name', () => {
    expect(taskTitle('fix the flaky login test. It fails on CI about 1 in 5 runs')).toBe('Fix the flaky login test');
    expect(taskTitle('## Add dark mode\nmore detail')).toBe('Add dark mode');
  });

  it('clips long requests on a word boundary', () => {
    const title = taskTitle('Refactor the session collectors so Codex and Claude share one tailing and naming pipeline please');
    expect(title!.length).toBeLessThanOrEqual(48);
    expect(title).toMatch(/…$/);
    expect(title).not.toMatch(/\s…$/);
  });

  it('uses the request part of a Codex IDE prompt', () => {
    expect(taskTitle('# Context from my IDE setup:\n\n## Active file: a.ts\n\n## My request for Codex:\nadd retries to the uploader')).toBe('Add retries to the uploader');
    expect(taskTitle('# Context from my IDE setup:\n\n## Active file: a.ts')).toBeUndefined();
  });

  it('ignores injected context and empty text', () => {
    expect(taskTitle('<environment_context>cwd</environment_context>')).toBeUndefined();
    expect(taskTitle('# AGENTS.md instructions for C:\\x')).toBeUndefined();
    expect(taskTitle('  ')).toBeUndefined();
    expect(taskTitle('ok')).toBeUndefined();
  });

  it('scrubs secrets', () => {
    expect(taskTitle('use key sk-abcdefghijklmnopqrstuvwx to deploy')).not.toContain('sk-abc');
  });
});

describe('normalizers expose a task title from the first request', () => {
  it('Codex user_message', () => {
    const line = { type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'user_message', message: 'speed up the scanner' } };
    expect(normalizeCodexLine('codex:a', line).taskTitle).toBe('Speed up the scanner');
  });

  it('Claude user prompt', () => {
    const line = { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'write the release notes' } };
    expect(normalizeClaudeLine('claude:a', line).taskTitle).toBe('Write the release notes');
  });
});

describe('review follow-ups', () => {
  it('only treats -c as a script flag for real shells', () => {
    expect(describeToolInput('shell', { command: ['grep', '-c', 'foo'] })).toBe('shell: grep -c foo');
    expect(describeToolInput('shell', { command: ['C:/Windows/System32/cmd.exe', '/c', 'dir'] })).toBe('shell: dir');
  });

  it('does not resolve inherited object members as tool phrases', () => {
    expect(plainToolActivity('constructor')).toBe('Using constructor');
    expect(plainToolActivity('toString: x')).toBe('toString: x');
  });
});

describe('agent replies as results', () => {
  it('keep paragraphs and up to 4,000 characters, while the activity line stays short', () => {
    // Arrange
    const reply = `Done.\n\n- added retries\n- updated tests   \r\n\n\n\nAll green. ${'x'.repeat(500)}`;
    const line = { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text: reply }] } };

    // Act
    const [event] = normalizeClaudeLine('claude:a', line).events;

    // Assert
    expect(event.summary.startsWith('Done.\n\n- added retries\n- updated tests\n\nAll green.')).toBe(true);
    expect(event.summary.length).toBeGreaterThan(280);
    expect(activityFromEvent(event).length).toBeLessThanOrEqual(280);
  });
});
