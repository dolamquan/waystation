import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  TerminalError, launchTerminal, manualAttachCommand, terminalTitle, windowsTerminalArgs,
} from '../daemon/actions/terminal.ts';

const paths = {
  projectRoot: 'C:\\work\\Agent_Inspection',
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  towerHome: 'C:\\Users\\me\\AppData\\Local\\agent-tower',
  script: 'C:\\work\\Agent_Inspection\\daemon\\cli\\attach.ts',
};

describe('windowsTerminalArgs', () => {
  it('opens a new tab that runs the attach console in the project folder', () => {
    expect(windowsTerminalArgs({ kind: 'agent', id: 'managed:1f2e-3d', title: 'Waystation · mica' }, paths)).toEqual([
      '-w', '0', 'new-tab', '--title', 'Waystation · mica', '-d', paths.projectRoot,
      paths.nodePath, '--import', 'tsx', paths.script, 'agent', 'managed:1f2e-3d', '--home', paths.towerHome,
    ]);
  });

  it('refuses ids that could be read as extra commands', () => {
    for (const id of ['', 'a;calc', 'a b', '"x"', '-w']) {
      expect(() => windowsTerminalArgs({ kind: 'team', id, title: 't' }, paths)).toThrow(TerminalError);
    }
  });

  it('refuses paths that Windows Terminal would split', () => {
    expect(() => windowsTerminalArgs({ kind: 'team', id: 'abc123', title: 't' }, { ...paths, towerHome: 'C:\\a;b' }))
      .toThrow(TerminalError);
  });
});

describe('terminalTitle', () => {
  it('keeps readable text and drops separators and control characters', () => {
    expect(terminalTitle('Waystation · auth; calc\u001b[2J')).toBe('Waystation · auth calc2J');
  });

  it('clips long names and never returns an empty title', () => {
    expect(terminalTitle('x'.repeat(200)).length).toBeLessThanOrEqual(60);
    expect(terminalTitle(';;;')).toBe('Waystation');
  });
});

it('prints the command to run by hand', () => {
  expect(manualAttachCommand('team', 'abc123')).toBe('npm run attach -- team abc123');
});

describe('launchTerminal', () => {
  const fakeChild = () => Object.assign(new EventEmitter(), { unref: vi.fn() });

  it('resolves once Windows Terminal has started, without waiting for it', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const launched = launchTerminal(['new-tab'], spawnFn as never);
    child.emit('spawn');
    await expect(launched).resolves.toBeUndefined();
    expect(spawnFn).toHaveBeenCalledWith('wt.exe', ['new-tab'], expect.objectContaining({ detached: true, stdio: 'ignore' }));
    expect(child.unref).toHaveBeenCalled();
  });

  it('rejects when Windows Terminal is missing', async () => {
    const child = fakeChild();
    const launched = launchTerminal(['new-tab'], (() => child) as never);
    child.emit('error', Object.assign(new Error('spawn wt.exe ENOENT'), { code: 'ENOENT' }));
    await expect(launched).rejects.toThrow('ENOENT');
  });
});
