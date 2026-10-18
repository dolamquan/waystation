import { describe, expect, it } from 'vitest';
import { filetimeToMs, killRefusal, wmiDateToMs } from '../daemon/actions/kill.ts';
import type { ProcInfo } from '../daemon/collectors/processScanner.ts';
import { makeAgent } from './helpers.ts';

// 2026-10-01T22:00:00.000Z expressed both ways.
const FILETIME = String((BigInt(Date.UTC(2026, 9, 1, 22, 0, 0)) + 11_644_473_600_000n) * 10_000n);
const WMI_LOCAL = '20261001150000.000000-420';

const proc = (overrides: Partial<ProcInfo> = {}): ProcInfo =>
  ({ pid: 4242, ppid: 1, name: 'claude.exe', commandLine: 'claude', created: WMI_LOCAL, ...overrides });

describe('time conversions', () => {
  it('agree between FILETIME and WMI dates', () => {
    expect(filetimeToMs(FILETIME)).toBe(Date.UTC(2026, 9, 1, 22, 0, 0));
    expect(wmiDateToMs(WMI_LOCAL)).toBe(Date.UTC(2026, 9, 1, 22, 0, 0));
    expect(filetimeToMs('abc')).toBeUndefined();
    expect(wmiDateToMs('garbage')).toBeUndefined();
  });
});

describe('killRefusal', () => {
  it('allows stopping a verified agent process', () => {
    expect(killRefusal({ agent: makeAgent(), proc: proc(), expectedProcStart: FILETIME })).toBeUndefined();
  });

  it('refuses when the PID was reused by a newer process', () => {
    const reused = proc({ created: '20261001160000.000000-420' });
    expect(killRefusal({ agent: makeAgent(), proc: reused, expectedProcStart: FILETIME })).toMatch(/reused/);
  });

  it('refuses host applications and unexpected processes', () => {
    expect(killRefusal({ agent: makeAgent(), proc: proc({ name: 'Code.exe' }) })).toMatch(/host application/);
    expect(killRefusal({ agent: makeAgent(), proc: proc({ name: 'explorer.exe' }) })).toMatch(/host application/);
    expect(killRefusal({ agent: makeAgent(), proc: proc({ name: 'chrome.exe' }) })).toMatch(/unexpected/);
  });

  it('refuses when blocked, missing or mismatched', () => {
    expect(killRefusal({ agent: makeAgent({ stopBlockedReason: 'shared' }), proc: proc() })).toBe('shared');
    expect(killRefusal({ agent: makeAgent({ pid: undefined }), proc: proc() })).toMatch(/no stoppable/);
    expect(killRefusal({ agent: makeAgent({ pid: 4 }), proc: proc() })).toMatch(/no stoppable/);
    expect(killRefusal({ agent: makeAgent(), proc: undefined })).toMatch(/no longer running/);
    expect(killRefusal({ agent: makeAgent(), proc: proc({ pid: 1 }) })).toMatch(/mismatch/);
  });
});
