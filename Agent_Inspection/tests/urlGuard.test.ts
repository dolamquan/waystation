import { describe, expect, it } from 'vitest';
import { assertAllowedHost } from '../daemon/library/urlGuard.ts';

const allowed = (raw: string): boolean => {
  try {
    assertAllowedHost(new URL(raw), 'url');
    return true;
  } catch {
    return false;
  }
};

describe('assertAllowedHost (SSRF guard)', () => {
  // Arrange: the internal targets the probe/webhook must refuse.
  const blockedTargets = [
    'http://169.254.169.254/latest/meta-data/', // cloud metadata — the primary SSRF repro
    'http://127.0.0.1:4317/', // loopback (the daemon itself)
    'http://[::1]:4317/', // IPv6 loopback
    'http://10.0.0.5/', // private
    'http://192.168.1.1/', // private
    'http://172.16.0.9/', // private
    'http://100.64.0.1/', // carrier-grade NAT
    'http://localhost:8080/', // loopback hostname
    'https://db.internal.localhost/', // *.localhost
  ];

  it.each(blockedTargets)('blocks %s', (raw) => {
    expect(allowed(raw)).toBe(false);
  });

  // Legitimate public destinations must keep working.
  const allowedTargets = [
    'https://example.com/mcp',
    'https://hooks.slack.com/services/T/B/x',
    'https://discord.com/api/webhooks/1/x',
    'https://ntfy.sh/',
    'http://93.184.216.34/', // a public IP literal
  ];

  it.each(allowedTargets)('allows %s', (raw) => {
    expect(allowed(raw)).toBe(true);
  });

  it('honors the WAYSTATION_ALLOW_PRIVATE_FETCH opt-in', () => {
    const prev = process.env.WAYSTATION_ALLOW_PRIVATE_FETCH;
    process.env.WAYSTATION_ALLOW_PRIVATE_FETCH = '1';
    try {
      expect(allowed('http://127.0.0.1:4317/')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.WAYSTATION_ALLOW_PRIVATE_FETCH;
      else process.env.WAYSTATION_ALLOW_PRIVATE_FETCH = prev;
    }
  });
});
