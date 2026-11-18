import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertAllowedHost, assertNotInternalHost, assertResolvedHostAllowed, type HostLookup } from '../daemon/library/urlGuard.ts';
import { LibraryInputError } from '../daemon/library/types.ts';

const ENV = 'WAYSTATION_ALLOW_PRIVATE_FETCH';
let previousEnv: string | undefined;
beforeEach(() => { previousEnv = process.env[ENV]; delete process.env[ENV]; });
afterEach(() => { if (previousEnv === undefined) delete process.env[ENV]; else process.env[ENV] = previousEnv; });

const passes = (raw: string, opts?: { allowLoopback?: boolean }): boolean => {
  try { assertNotInternalHost(new URL(raw), 'url', opts); return true; } catch (error) {
    expect(error).toBeInstanceOf(LibraryInputError);
    return false;
  }
};

describe('assertNotInternalHost', () => {
  const internal = [
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://169.254.1.1/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.0.10/',
    'http://100.64.0.1/', // CGNAT
    'http://100.127.255.255/',
    'http://0.0.0.0/',
    'http://[::]/',
    'http://[::ffff:10.0.0.1]/', // normalised by URL to [::ffff:a00:1]
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:7f00:1]/', // mapped loopback is never exempt
    'http://[fe80::1]/',
    'http://[febf::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
  ];
  it.each(internal)('blocks %s even with allowLoopback', (raw) => {
    expect(passes(raw)).toBe(false);
    expect(passes(raw, { allowLoopback: true })).toBe(false);
  });

  const loopback = ['http://127.0.0.1:4317/', 'http://127.8.9.10/', 'http://[::1]/', 'http://localhost:3000/', 'http://api.localhost/'];
  it.each(loopback)('blocks loopback %s unless allowLoopback is set', (raw) => {
    expect(passes(raw)).toBe(false);
    expect(passes(raw, { allowLoopback: true })).toBe(true);
  });

  const publicTargets = ['http://93.184.216.34/', 'https://example.com/mcp', 'http://172.32.0.1/', 'http://100.128.0.1/', 'http://[2606:4700::1111]/'];
  it.each(publicTargets)('allows public %s', (raw) => {
    expect(passes(raw)).toBe(true);
  });

  it('honours the WAYSTATION_ALLOW_PRIVATE_FETCH opt-in', () => {
    process.env[ENV] = '1';
    expect(passes('http://169.254.169.254/')).toBe(true);
    expect(passes('http://localhost/')).toBe(true);
  });

  it('closes the hex-normalised IPv4-mapped bypass in assertAllowedHost too', () => {
    expect(() => assertAllowedHost(new URL('http://[::ffff:10.0.0.1]/'), 'url')).toThrow(LibraryInputError);
    expect(() => assertAllowedHost(new URL('http://[::ffff:127.0.0.1]/'), 'url')).toThrow(LibraryInputError);
  });
});

describe('assertResolvedHostAllowed', () => {
  const resolver = (addresses: string[]): HostLookup => async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));

  it('rejects a hostname that resolves to cloud metadata', async () => {
    await expect(assertResolvedHostAllowed('metadata.attacker.example', 'url', { lookup: resolver(['169.254.169.254']) })).rejects.toThrow(LibraryInputError);
  });

  it('rejects when any resolved address is internal', async () => {
    await expect(assertResolvedHostAllowed('mixed.example', 'url', { lookup: resolver(['93.184.216.34', '10.1.2.3']) })).rejects.toThrow(/private|internal/);
    await expect(assertResolvedHostAllowed('v6.example', 'url', { lookup: resolver(['::ffff:a00:1']) })).rejects.toThrow(LibraryInputError);
  });

  it('applies the loopback exemption only when asked', async () => {
    await expect(assertResolvedHostAllowed('dev.example', 'url', { lookup: resolver(['127.0.0.1']) })).rejects.toThrow(/loopback/);
    await expect(assertResolvedHostAllowed('dev.example', 'url', { allowLoopback: true, lookup: resolver(['127.0.0.1', '::1']) })).resolves.toBeUndefined();
  });

  it('allows a hostname that resolves only to public addresses', async () => {
    await expect(assertResolvedHostAllowed('example.com', 'url', { lookup: resolver(['93.184.216.34', '2606:2800:220:1::']) })).resolves.toBeUndefined();
  });

  it('skips DNS for IP literals and does not throw on DNS failure', async () => {
    let calls = 0;
    const counting: HostLookup = async () => { calls += 1; throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); };
    await expect(assertResolvedHostAllowed('93.184.216.34', 'url', { lookup: counting })).resolves.toBeUndefined();
    await expect(assertResolvedHostAllowed('[2606:4700::1111]', 'url', { lookup: counting })).resolves.toBeUndefined();
    expect(calls).toBe(0);
    await expect(assertResolvedHostAllowed('nowhere.invalid', 'url', { lookup: counting })).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('honours the WAYSTATION_ALLOW_PRIVATE_FETCH opt-in without resolving', async () => {
    process.env[ENV] = '1';
    await expect(assertResolvedHostAllowed('meta.example', 'url', { lookup: resolver(['169.254.169.254']) })).resolves.toBeUndefined();
  });
});
