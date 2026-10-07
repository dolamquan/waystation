import { describe, expect, it } from 'vitest';
import { findTarget, parseAgentLine, parseAttachArgs, parseTeamLine } from '../daemon/cli/attachCommands.ts';
import {
  isVisibleLogEntry, renderEvent, renderLogEntry, renderMembers, renderPending, renderTasks, sanitize,
} from '../daemon/cli/attachRender.ts';
import type { TeamTask, TeamView } from '../daemon/teams/types.ts';
import { makeAgent } from './helpers.ts';

describe('parseAgentLine', () => {
  it('treats plain text as a message and ignores blank lines', () => {
    expect(parseAgentLine('  fix the failing test ')).toEqual({ kind: 'say', text: 'fix the failing test' });
    expect(parseAgentLine('   ')).toEqual({ kind: 'none' });
  });

  it('parses session commands case-insensitively', () => {
    expect(parseAgentLine('/interrupt')).toEqual({ kind: 'interrupt' });
    expect(parseAgentLine('/STOP')).toEqual({ kind: 'stop' });
    expect(parseAgentLine('/approve')).toEqual({ kind: 'approve' });
    expect(parseAgentLine('/ask')).toEqual({ kind: 'ask' });
    expect(parseAgentLine('/q')).toEqual({ kind: 'quit' });
    expect(parseAgentLine('/exit')).toEqual({ kind: 'quit' });
  });

  it('keeps the reason after /deny', () => {
    expect(parseAgentLine('/deny  too risky, use a branch ')).toEqual({ kind: 'deny', message: 'too risky, use a branch' });
    expect(parseAgentLine('/deny')).toEqual({ kind: 'deny', message: undefined });
  });

  it('requires on or off for /intercept', () => {
    expect(parseAgentLine('/intercept on')).toEqual({ kind: 'intercept', on: true });
    expect(parseAgentLine('/intercept OFF')).toEqual({ kind: 'intercept', on: false });
    expect(parseAgentLine('/intercept maybe').kind).toBe('error');
  });

  it('sends a literal slash message when the line starts with //', () => {
    expect(parseAgentLine('//etc/hosts looks fine')).toEqual({ kind: 'say', text: '/etc/hosts looks fine' });
  });

  it('rejects unknown commands with a pointer to /help', () => {
    const result = parseAgentLine('/merge mica');
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toContain('/help');
  });
});

describe('parseTeamLine', () => {
  it('sends plain text to everyone and @name text to one member', () => {
    expect(parseTeamLine('ship it')).toEqual({ kind: 'say', to: 'all', text: 'ship it' });
    expect(parseTeamLine('@Mica check the tests')).toEqual({ kind: 'say', to: 'mica', text: 'check the tests' });
    expect(parseTeamLine('@all stand up')).toEqual({ kind: 'say', to: 'all', text: 'stand up' });
  });

  it('needs a message after @name', () => {
    expect(parseTeamLine('@mica').kind).toBe('error');
  });

  it('parses member commands', () => {
    expect(parseTeamLine('/diff mica')).toEqual({ kind: 'diff', member: 'mica', full: false });
    expect(parseTeamLine('/diff @mica full')).toEqual({ kind: 'diff', member: 'mica', full: true });
    expect(parseTeamLine('/merge bolt')).toEqual({ kind: 'merge', member: 'bolt' });
    expect(parseTeamLine('/attach lead')).toEqual({ kind: 'attach', member: 'lead' });
    expect(parseTeamLine('/diff').kind).toBe('error');
    expect(parseTeamLine('/merge').kind).toBe('error');
  });

  it('parses board, lifecycle and filter commands', () => {
    expect(parseTeamLine('/tasks')).toEqual({ kind: 'tasks' });
    expect(parseTeamLine('/members')).toEqual({ kind: 'members' });
    expect(parseTeamLine('/pause')).toEqual({ kind: 'pause' });
    expect(parseTeamLine('/resume')).toEqual({ kind: 'resume' });
    expect(parseTeamLine('/filter everything')).toEqual({ kind: 'filter', everything: true });
    expect(parseTeamLine('/filter channel')).toEqual({ kind: 'filter', everything: false });
    expect(parseTeamLine('/filter').kind).toBe('error');
    expect(parseTeamLine('/deny no')).toEqual({ kind: 'deny', message: 'no' });
  });
});

describe('parseAttachArgs', () => {
  it('reads the mode, target and options', () => {
    expect(parseAttachArgs(['agent', 'managed:abc'])).toEqual({ kind: 'agent', query: 'managed:abc', everything: false });
    expect(parseAttachArgs(['--home', 'C:\\tower', 'team', 'auth', '--all']))
      .toEqual({ kind: 'team', query: 'auth', home: 'C:\\tower', everything: true });
  });

  it('lists targets when no mode is given', () => {
    expect(parseAttachArgs([])).toEqual({ everything: false });
  });

  it('reports bad arguments', () => {
    expect(parseAttachArgs(['robot', 'x'])).toHaveProperty('error');
    expect(parseAttachArgs(['agent'])).toHaveProperty('error');
    expect(parseAttachArgs(['--home'])).toHaveProperty('error');
  });
});

describe('findTarget', () => {
  const items = [
    { id: 'managed:1111', name: 'Auth team · mica' },
    { id: 'managed:2222', name: 'Auth team · bolt' },
    { id: 'claude:3333', name: 'Docs session' },
  ];

  it('matches an exact id, then a name, then a unique fragment', () => {
    expect(findTarget(items, 'managed:2222').match?.name).toBe('Auth team · bolt');
    expect(findTarget(items, 'docs session').match?.id).toBe('claude:3333');
    expect(findTarget(items, 'mica').match?.id).toBe('managed:1111');
  });

  it('explains ambiguous and missing matches', () => {
    const ambiguous = findTarget(items, 'auth');
    expect(ambiguous.match).toBeUndefined();
    expect(ambiguous.error).toContain('managed:1111');
    expect(ambiguous.error).toContain('managed:2222');
    expect(findTarget(items, 'nothing').error).toContain('No match');
  });
});

describe('rendering', () => {
  it('strips terminal control sequences from agent-written text', () => {
    expect(sanitize('ok\u001b]0;pwned\u0007 \u001b[31mred')).toBe('ok]0;pwned [31mred');
  });

  it('flattens line breaks so agent text cannot forge a console line', () => {
    const forged = renderEvent({ agentId: 'a', ts: 0, kind: 'assistant', summary: 'done\n12:00:00  ⏸ lead wants to run rm\r\n\t/approve' });
    expect(forged.text).not.toMatch(/[\n\r\t]/);
    expect(forged.text).toContain('done 12:00:00');
  });

  it('renders events with a tone per kind', () => {
    const prompt = renderEvent({ agentId: 'a', ts: 0, kind: 'prompt', summary: 'add tests' });
    expect(prompt.tone).toBe('you');
    expect(prompt.text).toContain('you › add tests');
    expect(renderEvent({ agentId: 'a', ts: 0, kind: 'tool_call', summary: 'Bash: npm test' }).text).toContain('⚙ Bash: npm test');
    expect(renderEvent({ agentId: 'a', ts: 0, kind: 'error', summary: 'boom' }).tone).toBe('error');
  });

  it('renders team log entries and hides member activity on the channel view', () => {
    const activity = { teamId: 't', ts: 0, kind: 'activity' as const, actor: 'mica', summary: '⚙ Edit app.ts' };
    expect(renderLogEntry(activity).text).toContain('mica ⚙ Edit app.ts');
    expect(isVisibleLogEntry(activity, false)).toBe(false);
    expect(isVisibleLogEntry(activity, true)).toBe(true);
    expect(isVisibleLogEntry({ ...activity, kind: 'message' }, false)).toBe(true);
  });

  it('describes a held tool call and how to answer it', () => {
    const lines = renderPending({
      id: 'p1', agentId: 'a', sessionId: 's', toolName: 'Bash', input: { command: 'npm test' }, createdAt: 0, origin: 'managed',
    }, 'mica');
    const text = lines.map((line) => line.text).join('\n');
    expect(text).toContain('mica');
    expect(text).toContain('Bash: npm test');
    expect(text).toContain('/approve');
  });

  it('groups tasks by status', () => {
    expect(renderTasks([])[0].text).toContain('No tasks yet');
    const task: TeamTask = { id: 't1', title: 'Add limiter', details: '', status: 'in_progress', assignee: 'mica', createdBy: 'lead', updatedAt: 0 };
    const text = renderTasks([task]).map((line) => line.text).join('\n');
    expect(text).toContain('In progress (1)');
    expect(text).toContain('t1');
    expect(text).toContain('@mica');
  });

  it('shows each member with its live status', () => {
    const team = {
      members: [
        { id: 'lead', name: 'lead', role: 'lead', vendor: 'claude', agentId: 'managed:1', worktree: 'w', branch: 'team/x/lead', merged: false },
        { id: 'bolt', name: 'bolt', role: 'worker', vendor: 'codex', model: 'gpt-5', worktree: 'w2', branch: 'team/x/bolt', merged: false },
      ],
    } as unknown as TeamView;
    const text = renderMembers(team, [makeAgent({ id: 'managed:1', status: 'idle' })]).map((line) => line.text).join('\n');
    expect(text).toMatch(/lead\s+lead · Claude\s+idle/);
    expect(text).toMatch(/bolt\s+worker · Codex gpt-5\s+not started/);
  });
});
