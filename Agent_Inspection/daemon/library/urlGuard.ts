import { LibraryInputError } from './types.ts';

/**
 * Guards server-side HTTP requests (MCP probes, outbound webhooks) against SSRF.
 *
 * The daemon runs on a trusted machine, so a request it makes can reach places a
 * remote caller cannot: cloud metadata (169.254.169.254), other services bound to
 * loopback, and hosts on the private LAN. An operator-chosen MCP or webhook URL
 * should not be aimed at those by default. Legitimate local targets (a dev MCP
 * server on 127.0.0.1, a webhook on the LAN) are still reachable by setting
 * WAYSTATION_ALLOW_PRIVATE_FETCH=1 — an explicit, deliberate opt-in.
 *
 * This blocks IP *literals* synchronously. A hostname that resolves to a private
 * address via DNS is not caught here (resolution is async and happens at connect
 * time); pair this with `redirect: 'error'` on the fetch so a public URL cannot
 * redirect into internal space.
 */

const privateFetchAllowed = (): boolean => process.env.WAYSTATION_ALLOW_PRIVATE_FETCH === '1';

function parseIpv4(host: string): readonly number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : undefined;
}

function ipv4Blocked([a, b]: readonly number[]): boolean {
  if (a === 0 || a === 127 || a === 10) return true; // "this host", loopback, private
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 cloud metadata
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

/** Why `hostname` is an internal address, or undefined if it is an allowed (or unresolvable) public host. */
function blockedReason(hostname: string): string | undefined {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return 'a loopback address';

  if (host.includes(':')) {
    if (host === '::1' || host === '::') return 'a loopback address';
    if (/^fe[89ab]/.test(host)) return 'a link-local address';
    if (/^f[cd]/.test(host)) return 'a unique-local address';
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    const octets = mapped && parseIpv4(mapped[1]);
    return octets && ipv4Blocked(octets) ? 'a private or loopback address' : undefined;
  }

  const octets = parseIpv4(host);
  return octets && ipv4Blocked(octets) ? 'a private or loopback address' : undefined;
}

/** Throws LibraryInputError if `url` targets an internal address, unless the private-fetch opt-in is set. */
export function assertAllowedHost(url: URL, what: string): void {
  if (privateFetchAllowed()) return;
  const reason = blockedReason(url.hostname);
  if (reason) {
    throw new LibraryInputError(
      `${what} must not point at ${reason}. Set WAYSTATION_ALLOW_PRIVATE_FETCH=1 to allow local targets.`,
    );
  }
}
