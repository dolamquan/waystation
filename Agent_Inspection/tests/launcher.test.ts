import { describe, expect, it } from 'vitest';
import {
  buildUiUrl,
  isFreshDaemonInfo,
  needsBuild,
  parseDaemonInfo,
  parseLauncherArgs,
  redactToken,
} from '../scripts/waystation.mjs';

const TOKEN = 'a1b2c3d4e5f6';
const validInfo = { port: 4317, token: TOKEN, pid: 4242, startedAt: 1_000_000, dev: false };

describe('needsBuild', () => {
  it('builds when web/dist is missing', () => {
    expect(needsBuild(undefined, 500)).toBe(true);
  });

  it('builds when a source file is newer than the build', () => {
    expect(needsBuild(1_000, 2_000)).toBe(true);
  });

  it('skips the build when the build is up to date', () => {
    expect(needsBuild(2_000, 1_000)).toBe(false);
    expect(needsBuild(2_000, 2_000)).toBe(false);
  });

  it('skips the build when there are no sources to compare', () => {
    expect(needsBuild(2_000, undefined)).toBe(false);
  });
});

describe('parseDaemonInfo', () => {
  it('accepts a well-formed daemon.json', () => {
    expect(parseDaemonInfo(validInfo)).toEqual(validInfo);
  });

  it('defaults dev to false', () => {
    const { dev: _dev, ...withoutDev } = validInfo;
    expect(parseDaemonInfo(withoutDev)?.dev).toBe(false);
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['a missing token', { ...validInfo, token: undefined }],
    ['a non-hex token', { ...validInfo, token: 'abc&autostart=1' }],
    ['a bad port', { ...validInfo, port: 70_000 }],
    ['a missing pid', { ...validInfo, pid: undefined }],
    ['a non-numeric startedAt', { ...validInfo, startedAt: 'yesterday' }],
  ])('rejects %s', (_label, raw) => {
    expect(parseDaemonInfo(raw)).toBeUndefined();
  });
});

describe('isFreshDaemonInfo', () => {
  const info = parseDaemonInfo(validInfo);

  it('accepts info written by the daemon we launched', () => {
    expect(isFreshDaemonInfo(info, { launchedAt: 999_500, pid: 4242 })).toBe(true);
  });

  it('rejects info left over from an earlier run', () => {
    expect(isFreshDaemonInfo(info, { launchedAt: 1_000_000 + 60_000, pid: 4242 })).toBe(false);
  });

  it('rejects info written by a different process', () => {
    expect(isFreshDaemonInfo(info, { launchedAt: 999_500, pid: 9999 })).toBe(false);
  });

  it('tolerates a little clock rounding', () => {
    expect(isFreshDaemonInfo(info, { launchedAt: 1_000_500, pid: 4242 })).toBe(true);
  });

  it('rejects missing info', () => {
    expect(isFreshDaemonInfo(undefined, { launchedAt: 0 })).toBe(false);
  });
});

describe('buildUiUrl', () => {
  it('opens the daemon port with the token and the autostart flag', () => {
    expect(buildUiUrl(validInfo)).toBe(`http://127.0.0.1:4317/#token=${TOKEN}&autostart=1`);
  });

  it('opens the Vite dev server when the daemon runs with --dev', () => {
    expect(buildUiUrl({ ...validInfo, dev: true })).toBe(`http://127.0.0.1:5173/#token=${TOKEN}&autostart=1`);
  });

  it('keeps the token parseable by the UI regex', () => {
    const hash = new URL(buildUiUrl(validInfo)).hash;
    expect(/(?:^#|&)token=([A-Fa-f0-9]+)/.exec(hash)?.[1]).toBe(TOKEN);
    expect(/(?:^#|&)autostart=1(?:&|$)/.test(hash)).toBe(true);
  });
});

describe('redactToken', () => {
  it('hides the token in daemon output', () => {
    const line = `Waystation is running. Open: http://127.0.0.1:4317/#token=${TOKEN}`;
    expect(redactToken(line)).toBe('Waystation is running. Open: http://127.0.0.1:4317/#token=<hidden>');
    expect(redactToken(line)).not.toContain(TOKEN);
  });

  it('leaves other text alone', () => {
    expect(redactToken('(or run `npm run open`)')).toBe('(or run `npm run open`)');
  });
});

describe('parseLauncherArgs', () => {
  it('opens the browser by default', () => {
    expect(parseLauncherArgs([])).toEqual({ open: true });
  });

  it('respects --no-open', () => {
    expect(parseLauncherArgs(['--no-open'])).toEqual({ open: false });
  });
});
