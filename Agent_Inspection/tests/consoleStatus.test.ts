import { describe, expect, it } from 'vitest';
import type { ConsoleInfo } from '../web/src/api.ts';
import { WORKING_WINDOW_MS, needsYouCount, statusLabel, statusOf } from '../web/src/components/consoles/consoleStatus.ts';

const NOW = 100_000;
const make = (patch: Partial<ConsoleInfo> = {}): ConsoleInfo =>
  ({ id: 'c', name: 'c', kind: 'claude', cwd: 'C:\\w', state: 'running', createdAt: 0, lastOutputAt: 0, ...patch });

describe('statusOf', () => {
  it('falls back to output recency without attention', () => {
    expect(statusOf(make({ lastOutputAt: NOW - 10 }), NOW)).toBe('working');
    expect(statusOf(make({ lastOutputAt: NOW - WORKING_WINDOW_MS - 1 }), NOW)).toBe('idle');
  });

  it('prefers the CLI attention over recency', () => {
    expect(statusOf(make({ attention: 'needs-you', lastOutputAt: NOW }), NOW)).toBe('needs-you');
    expect(statusOf(make({ attention: 'ready', lastOutputAt: NOW }), NOW)).toBe('ready');
    expect(statusOf(make({ attention: 'working', lastOutputAt: 0 }), NOW)).toBe('working');
  });

  it('always reports an exited console as exited', () => {
    expect(statusOf(make({ state: 'exited', attention: 'needs-you' }), NOW)).toBe('exited');
  });
});

describe('statusLabel', () => {
  it.each([
    ['working', 'working'],
    ['idle', 'idle'],
    ['needs-you', 'needs you'],
    ['ready', 'ready'],
    ['exited', 'exited'],
  ] as const)('labels %s as "%s"', (status, label) => {
    expect(statusLabel(status)).toBe(label);
  });
});

describe('needsYouCount', () => {
  it('counts only running consoles waiting on the operator', () => {
    const list = [
      make({ id: 'a', attention: 'needs-you' }),
      make({ id: 'b', attention: 'needs-you' }),
      make({ id: 'c', attention: 'ready' }),
      make({ id: 'd', state: 'exited', attention: 'needs-you' }),
      make({ id: 'e' }),
    ];
    expect(needsYouCount(list)).toBe(2);
    expect(needsYouCount([])).toBe(0);
  });
});
