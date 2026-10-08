import { describe, expect, it } from 'vitest';
import type { AgentEvent, EventKind } from '../daemon/domain/types.ts';
import { extractChangedFiles, filesFromToolSummary, groupTurns } from '../daemon/outputs/extract.ts';

const ev = (ts: number, kind: EventKind, summary: string): AgentEvent => ({ agentId: 'a1', ts, kind, summary });

describe('filesFromToolSummary', () => {
  it('reads the path from Write, Edit, MultiEdit and NotebookEdit summaries', () => {
    // Arrange
    const summaries = ['Write: C:\\work\\demo\\a.ts', 'Edit: src/b.ts', 'MultiEdit: /repo/c d.ts', 'NotebookEdit: nb.ipynb'];

    // Act
    const found = summaries.map(filesFromToolSummary);

    // Assert
    expect(found).toEqual([
      [{ tool: 'Write', path: 'C:\\work\\demo\\a.ts' }],
      [{ tool: 'Edit', path: 'src/b.ts' }],
      [{ tool: 'MultiEdit', path: '/repo/c d.ts' }],
      [{ tool: 'NotebookEdit', path: 'nb.ipynb' }],
    ]);
  });

  it('ignores read-only tools and summaries without a path', () => {
    expect(filesFromToolSummary('Read: C:\\work\\demo\\a.ts')).toEqual([]);
    expect(filesFromToolSummary('Bash: npm test')).toEqual([]);
    expect(filesFromToolSummary('Edit')).toEqual([]);
  });

  it('lists every file named in apply_patch text, including add and delete', () => {
    // Arrange: newlines are collapsed to spaces when events are recorded.
    const summary = 'apply_patch: *** Begin Patch *** Update File: web/src/App.tsx @@ -1 +1 @@ -old +new '
      + '*** Add File: docs/new file.md +hello *** Delete File: old.txt *** End Patch';

    // Act
    const found = filesFromToolSummary(summary);

    // Assert
    expect(found).toEqual([
      { tool: 'apply_patch', path: 'web/src/App.tsx' },
      { tool: 'apply_patch', path: 'docs/new file.md' },
      { tool: 'apply_patch', path: 'old.txt' },
    ]);
  });

  it('finds patch file lines inside a shell command running apply_patch', () => {
    const summary = "shell: apply_patch <<'EOF' *** Begin Patch *** Update File: daemon/x.ts @@ EOF";
    expect(filesFromToolSummary(summary)).toEqual([{ tool: 'apply_patch', path: 'daemon/x.ts' }]);
  });

  it('drops a path that was clipped when the summary was recorded', () => {
    expect(filesFromToolSummary('Edit: C:\\very\\long\\pa…')).toEqual([]);
    expect(filesFromToolSummary('apply_patch: *** Begin Patch *** Update File: a.ts @@ x *** Update File: src/cli…'))
      .toEqual([{ tool: 'apply_patch', path: 'a.ts' }]);
  });

  it('skips calls still held for approval so they are not counted twice', () => {
    expect(filesFromToolSummary('⏸ Edit: C:\\work\\demo\\a.ts')).toEqual([]);
  });
});

describe('extractChangedFiles', () => {
  it('groups touches per file relative to the agent folder, newest first', () => {
    // Arrange
    const events = [
      ev(1, 'tool_call', 'Edit: C:\\work\\demo\\src\\a.ts'),
      ev(2, 'tool_call', 'Write: C:\\work\\demo\\README.md'),
      ev(3, 'tool_call', 'Edit: c:\\WORK\\demo\\src\\a.ts'),
      ev(4, 'assistant', 'Edit: not a tool call'),
      ev(5, 'tool_call', 'apply_patch: *** Begin Patch *** Update File: src/a.ts @@'),
    ];

    // Act
    const files = extractChangedFiles(events, 'C:\\work\\demo');

    // Assert
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: 'src/a.ts', insideCwd: true, touches: 3, firstTouchedAt: 1, lastTouchedAt: 5 });
    expect(files[0].tools).toEqual(['Edit', 'apply_patch']);
    expect(files[1]).toMatchObject({ path: 'README.md', touches: 1, lastTouchedAt: 2, tools: ['Write'] });
  });

  it('marks files outside the agent folder and keeps their recorded path', () => {
    const files = extractChangedFiles([ev(1, 'tool_call', 'Write: C:\\elsewhere\\notes.md')], 'C:\\work\\demo');
    expect(files).toEqual([expect.objectContaining({ path: 'C:\\elsewhere\\notes.md', insideCwd: false })]);
  });

  it('treats relative patch paths that climb out of the folder as outside', () => {
    const files = extractChangedFiles([ev(1, 'tool_call', 'apply_patch: *** Update File: ../other/x.ts @@')], '/repo/app');
    expect(files[0]).toMatchObject({ path: '../other/x.ts', insideCwd: false });
  });

  it('handles posix folders and ./ prefixes', () => {
    const files = extractChangedFiles([
      ev(1, 'tool_call', 'Edit: /repo/app/lib/x.ts'),
      ev(2, 'tool_call', 'apply_patch: *** Update File: ./lib/x.ts @@'),
    ], '/repo/app/');
    expect(files).toEqual([expect.objectContaining({ path: 'lib/x.ts', touches: 2, insideCwd: true })]);
  });

  it('returns an empty list when nothing was written', () => {
    expect(extractChangedFiles([ev(1, 'tool_call', 'Bash: ls')], '/repo')).toEqual([]);
  });

  it('keeps absolute paths as recorded when the folder is unknown', () => {
    const files = extractChangedFiles([ev(1, 'tool_call', 'Edit: /repo/x.ts')], undefined);
    expect(files[0]).toMatchObject({ path: '/repo/x.ts', insideCwd: false });
  });
});

describe('groupTurns', () => {
  it('pairs each request with the last message of its turn, newest first', () => {
    // Arrange
    const events = [
      ev(1, 'prompt', 'Fix the flaky test'),
      ev(2, 'assistant', 'Looking into it.'),
      ev(3, 'tool_call', 'Edit: /repo/test.ts'),
      ev(4, 'assistant', 'Fixed: the timeout was too short.'),
      ev(5, 'status', 'turn complete (success)'),
      ev(6, 'prompt', 'Now update the docs'),
      ev(7, 'assistant', 'Working on the docs.'),
    ];

    // Act
    const turns = groupTurns(events, '/repo');

    // Assert
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ prompt: 'Now update the docs', complete: false, result: 'Working on the docs.', startedAt: 6 });
    expect(turns[1]).toMatchObject({
      prompt: 'Fix the flaky test', complete: true, result: 'Fixed: the timeout was too short.', resultAt: 4,
      toolCalls: 1, files: ['test.ts'], startedAt: 1, endedAt: 5,
    });
  });

  it('treats a hook stop, a session stop and a newer request as the end of a turn', () => {
    const turns = groupTurns([
      ev(1, 'prompt', 'one'), ev(2, 'assistant', 'done one'), ev(3, 'status', 'finished its turn'),
      ev(4, 'prompt', 'two'), ev(5, 'assistant', 'partial'),
      ev(6, 'prompt', 'three'), ev(7, 'stop', 'Stopped from the tower'),
    ], undefined);
    expect(turns.map((turn) => [turn.prompt, turn.complete])).toEqual([['three', true], ['two', true], ['one', true]]);
  });

  it('keeps activity recorded before any request as a turn without a prompt', () => {
    const turns = groupTurns([ev(1, 'assistant', 'picked up mid-way'), ev(2, 'status', 'turn complete')], undefined);
    expect(turns).toEqual([expect.objectContaining({ prompt: undefined, result: 'picked up mid-way', complete: true })]);
  });

  it('attaches a Codex request that arrives after its "turn started" marker to the same turn', () => {
    const turns = groupTurns([
      ev(1, 'status', 'turn started'), ev(2, 'prompt', 'add a flag'), ev(3, 'assistant', 'Added --dry-run.'), ev(4, 'status', 'turn complete'),
      ev(5, 'status', 'turn started'), ev(6, 'prompt', 'thanks'),
    ], undefined);
    expect(turns.map((turn) => turn.prompt)).toEqual(['thanks', 'add a flag']);
    expect(turns[1]).toMatchObject({ result: 'Added --dry-run.', complete: true });
  });

  it('collects errors in the turn and ignores held approvals as tool calls', () => {
    const turns = groupTurns([
      ev(1, 'prompt', 'go'), ev(2, 'tool_call', '⏸ Bash: rm -rf build'), ev(3, 'tool_call', 'Bash: rm -rf build'), ev(4, 'error', 'boom'),
    ], undefined);
    expect(turns[0]).toMatchObject({ toolCalls: 1, errors: ['boom'] });
  });

  it('returns no turns for no events', () => {
    expect(groupTurns([], undefined)).toEqual([]);
  });
});
