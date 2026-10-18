import { describe, expect, it, vi } from 'vitest';

// The real client reads the page URL on import; these helpers never call it.
vi.mock('../web/src/api.ts', () => ({ api: {} }));
const { formatDuration, meterLevel, resetText } = await import('../web/src/components/UsageWindows.tsx');

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('plan limit display helpers', () => {
  it('formats time until reset compactly', () => {
    expect(formatDuration(2 * HOUR + 14 * MIN + 30_000)).toBe('2h 14m');
    expect(formatDuration(3 * 24 * HOUR + 4 * HOUR)).toBe('3d 4h');
    expect(formatDuration(2 * 24 * HOUR)).toBe('2d');
    expect(formatDuration(5 * HOUR)).toBe('5h');
    expect(formatDuration(12 * MIN)).toBe('12m');
    expect(formatDuration(10_000)).toBe('under 1m');
  });

  it('says when a window resets, or that it already has', () => {
    const now = 1_000_000_000;
    expect(resetText(now + 90 * MIN, now)).toBe('Resets in 1h 30m');
    expect(resetText(now - MIN, now)).toBe('Window has reset since this reading');
    expect(resetText(undefined, now)).toBeUndefined();
  });

  it('colors the meter by how close the window is to its limit', () => {
    expect(meterLevel(10)).toBe('ok');
    expect(meterLevel(75)).toBe('warn');
    expect(meterLevel(95)).toBe('full');
  });
});
