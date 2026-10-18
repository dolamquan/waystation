import { describe, expect, it } from 'vitest';
import {
  appendDictation, availableCommands, commandQuery, matchCommands, parseComposer, parseSpoken, type ComposerContext,
} from '../web/src/composer/commands.ts';
import { CLAUDE_CODE_COMMANDS } from '../shared/claudeCommands.ts';
import { makeAgent } from './helpers.ts';

const context = (overrides: Partial<ComposerContext['agent']> = {}, extra: Partial<Omit<ComposerContext, 'agent'>> = {}): ComposerContext => ({
  agent: makeAgent({ tier: 'A', vendor: 'claude', status: 'busy', canInstruct: true, sessionId: 's1', cwd: 'C:/repo', ...overrides }),
  hasPending: false,
  canIntercept: true,
  canOpenCli: true,
  ...extra,
});

const kinds = (ctx: ComposerContext) => Object.fromEntries(availableCommands(ctx).map(command => [command.name, command.kind]));

describe('availableCommands', () => {
  it('lists every Claude Code built-in for a Claude session, so nothing is missing from the menu', () => {
    // Arrange
    const ctx = context({ tier: 'B' });

    // Act
    const names = availableCommands(ctx).map(command => command.name);

    // Assert
    expect(names).toEqual(expect.arrayContaining(CLAUDE_CODE_COMMANDS.map(command => command.name)));
  });

  it('answers /usage, /mcp and /model natively for any Claude session', () => {
    expect(kinds(context({ tier: 'B' }))).toMatchObject({ usage: 'native', mcp: 'native', model: 'native', context: 'native', status: 'native' });
  });

  it('runs session commands in agents launched here, and explains why not elsewhere', () => {
    // Arrange
    const launched = context();
    const yours = context({ tier: 'B' });

    // Act
    const here = availableCommands(launched).find(command => command.name === 'compact');
    const there = availableCommands(yours).find(command => command.name === 'compact');

    // Assert
    expect(here?.kind).toBe('send');
    expect(there).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('/cli') });
    expect(availableCommands(yours).find(command => command.name === 'vim')?.reason).toMatch(/terminal screen/);
  });

  it('adds /mode and the agent’s custom commands only for agents launched here', () => {
    const launched = context({ slashCommands: [{ name: 'deploy', description: 'Ship it', argumentHint: '<env>' }, { name: 'compact' }] });
    expect(kinds(launched)).toMatchObject({ mode: 'native', deploy: 'send' });
    expect(availableCommands(launched).filter(command => command.name === 'compact')).toHaveLength(1);
    expect(kinds(context({ tier: 'B', slashCommands: [{ name: 'deploy' }] }))).not.toHaveProperty('mode');
  });

  it('gives Codex agents the vendor-neutral native commands only', () => {
    const list = kinds(context({ vendor: 'codex' }));
    expect(list).toMatchObject({ usage: 'native', model: 'native' });
    expect(list).not.toHaveProperty('mcp');
    expect(list).not.toHaveProperty('compact');
  });

  it('leads with /approve and /deny when a call is waiting, and keeps terminal-only commands last', () => {
    // Arrange
    const list = availableCommands(context({ tier: 'B' }, { hasPending: true }));

    // Act
    const order = list.map(command => command.name);

    // Assert
    expect(order.slice(0, 2)).toEqual(['approve', 'deny']);
    expect(list.at(-1)?.kind).toBe('unavailable');
    expect(order).toContain('ask');
  });

  it('respects a blocked stop and offers clearing a tripped guard', () => {
    expect(kinds(context({ stopBlockedReason: 'shared process' }))).not.toHaveProperty('stop');
    expect(kinds(context({ breaker: { level: 'warned', reason: 'loop', since: 1 } }))).toHaveProperty('clear-guard', 'waystation');
  });
});

describe('command menu', () => {
  it('opens only while the first word is a slash command being typed', () => {
    expect(commandQuery('/')).toBe('');
    expect(commandQuery('/comp')).toBe('comp');
    expect(commandQuery('/compact now')).toBeUndefined();
    expect(commandQuery('hello /x')).toBeUndefined();
    expect(commandQuery('//literal')).toBeUndefined();
  });

  it('ranks prefix matches before other matches', () => {
    const list = availableCommands(context());
    const matches = matchCommands('mo', list).map(command => command.name);
    expect(matches.slice(0, 2)).toEqual(['model', 'mode']);
    expect(matches).toContain('memory');
  });
});

describe('parseComposer', () => {
  const launched = availableCommands(context({}, { hasPending: true }));
  const yours = availableCommands(context({ tier: 'B' }));

  it('sends plain text as a message', () => {
    expect(parseComposer('  fix the tests  ', launched)).toEqual({ kind: 'send', text: 'fix the tests' });
    expect(parseComposer('   ', launched)).toEqual({ kind: 'none' });
  });

  it('routes each kind of command', () => {
    expect(parseComposer('/MCP reconnect github', launched)).toEqual({ kind: 'native', name: 'mcp', arg: 'reconnect github' });
    expect(parseComposer('/compact keep the API notes', launched)).toEqual({ kind: 'send', text: '/compact keep the API notes' });
    expect(parseComposer('/deny not on main', launched)).toEqual({ kind: 'run', name: 'deny', arg: 'not on main' });
    expect(parseComposer('/compact', yours)).toMatchObject({ kind: 'unavailable', message: expect.stringContaining('/compact') });
  });

  it('checks Waystation arguments', () => {
    expect(parseComposer('/rename', launched)).toMatchObject({ kind: 'error' });
    expect(parseComposer('/intercept maybe', launched)).toMatchObject({ kind: 'error', message: expect.stringContaining('on or off') });
    expect(parseComposer('/delegate write docs\nfor the API', launched)).toEqual({ kind: 'run', name: 'delegate', arg: 'write docs\nfor the API' });
  });

  it('sends //text as a message starting with a slash, and rejects unknown commands', () => {
    expect(parseComposer('//etc/hosts is wrong', launched)).toEqual({ kind: 'send', text: '/etc/hosts is wrong' });
    expect(parseComposer('/frobnicate', launched)).toMatchObject({ kind: 'error', message: expect.stringContaining('/frobnicate') });
  });
});

describe('voice input', () => {
  it('turns a spoken "slash" into a command', () => {
    expect(parseSpoken('Slash compact')).toEqual({ text: '/compact', send: false });
    expect(parseSpoken('forward slash deny not on main')).toEqual({ text: '/deny not on main', send: false });
  });

  it('submits when the sentence ends with "send it"', () => {
    expect(parseSpoken('please add retries to the uploader, send it.')).toEqual({ text: 'please add retries to the uploader', send: true });
    expect(parseSpoken('send it')).toEqual({ text: '', send: true });
  });

  it('appends dictation with sensible spacing', () => {
    expect(appendDictation('', 'hello')).toBe('hello');
    expect(appendDictation('fix this', 'and that')).toBe('fix this and that');
    expect(appendDictation('line\n', 'next')).toBe('line\nnext');
  });
});
