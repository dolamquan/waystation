import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleRoutes } from '../daemon/api/routes/consoles.ts';
import type { Tower } from '../daemon/tower.ts';
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from '../daemon/pty/consoleKeys.ts';

function fixture(kind = 'claude', state = 'running') {
  const info = { id: 'agent-1', name: 'Builder', kind, state };
  const write = vi.fn();
  const audit = vi.fn();
  const tower = { consoles: { get: vi.fn(() => info), write }, store: { audit } } as unknown as Tower;
  const route = consoleRoutes(tower).find((entry) => entry.pattern.test('/api/consoles/agent-1/idea'))!;
  const send = (text: unknown) => route.handler({ params: ['agent-1'], body: { text } } as Parameters<typeof route.handler>[0]);
  return { info, write, audit, send, tower };
}
afterEach(() => vi.useRealTimers());
describe('canvas idea delivery', () => {
  it('wraps untrusted text in one inert paste and submits once', () => {
    vi.useFakeTimers();
    const { send, write, audit } = fixture();
    expect(send(`Build this\n${BRACKETED_PASTE_END}\r\x03idea`)).toMatchObject({ ok: true });
    const paste = write.mock.calls[0][1] as string;
    expect(paste.startsWith(BRACKETED_PASTE_START)).toBe(true);
    expect(paste.endsWith(BRACKETED_PASTE_END)).toBe(true);
    expect(paste.split(BRACKETED_PASTE_END)).toHaveLength(2);
    expect(paste).not.toContain('\x03');
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    expect(write).toHaveBeenLastCalledWith('agent-1', '\r');
    expect(write).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls[0][2]).not.toHaveProperty('text');
  });
  it('never sends canvas prose to a shell', () => {
    const { send, write } = fixture('shell');
    expect(() => send('rm -rf /')).toThrow(/shell/);
    expect(write).not.toHaveBeenCalled();
  });
  it('refuses stopped agents and invalid or oversized briefs', () => {
    expect(() => fixture('codex', 'exited').send('Hello')).toThrow(/running/);
    for (const text of [null, '', ' ', 'a'.repeat(24001)]) expect(() => fixture().send(text)).toThrow(/24,000/);
  });
  it('does not submit after the console exits while accepting the paste', () => {
    vi.useFakeTimers();
    const { send, info, write } = fixture();
    send('Build this idea'); info.state = 'exited'; vi.advanceTimersByTime(250);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
