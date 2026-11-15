import { describe, expect, it } from 'vitest';
import { completeCommand, resultLines, tileCommands } from '../web/src/components/consoles/tileCommands.ts';
import { makeAgent } from './helpers.ts';

const names = (agent: Parameters<typeof tileCommands>[0]) => tileCommands(agent).map((command) => command.name);

describe('tileCommands', () => {
  it('offers Claude Code commands to an observed session, not only to agents launched here', () => {
    // Arrange: started in your own terminal, hooks connected
    const observed = makeAgent({ tier: 'B', vendor: 'claude', status: 'idle', canInstruct: true, sessionId: 's', cwd: 'C:/repo' });

    // Act
    const list = names(observed);

    // Assert
    expect(list).toEqual(expect.arrayContaining(['usage', 'context', 'model', 'cost', 'help', 'rename']));
  });

  it('leaves out controls that need a confirmation dialog or a pending call (those live in Details)', () => {
    const agent = makeAgent({ tier: 'A', vendor: 'claude', status: 'busy', canInstruct: true, sessionId: 's', cwd: 'C:/repo' });
    expect(names(agent)).not.toContain('stop');
    expect(names(agent)).not.toContain('cli');
    expect(names(agent)).not.toContain('approve');
  });
});

describe('completeCommand', () => {
  const commands = tileCommands(makeAgent({ tier: 'B', vendor: 'claude', status: 'idle', canInstruct: true, sessionId: 's', cwd: 'C:/repo' }));
  it('completes a partial command to the first match, with a trailing space', () => {
    expect(completeCommand('/usa', commands)).toBe('/usage ');
  });
  it('leaves plain text and unknown prefixes alone', () => {
    expect(completeCommand('hello', commands)).toBe('hello');
    expect(completeCommand('/zzzz', commands)).toBe('/zzzz');
  });
});

describe('resultLines', () => {
  it('prints a native command result as plain lines for the feed', () => {
    const lines = resultLines('/usage', {
      title: 'Usage',
      sections: [{ heading: 'Plan', rows: [{ label: '5-hour', value: '42%', detail: 'resets 3pm' }, { label: 'Weekly' }] }],
      note: 'From local logs',
    });
    expect(lines).toEqual(['/usage · Usage', 'Plan', '  5-hour: 42% (resets 3pm)', '  Weekly', 'From local logs']);
  });
});
