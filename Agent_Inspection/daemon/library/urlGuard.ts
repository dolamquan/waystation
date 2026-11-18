import dns from 'node:dns';
import { isIP } from 'node:net';
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
 * `assertAllowedHost` / `assertNotInternalHost` block IP *literals* synchronously.
 * A hostname that resolves to a private address is caught by the async
 * `assertResolvedHostAllowed`; pair either with `redirect: 'error'` on the fetch so
 * a public URL cannot redirect into internal space. (A DNS answer can still change
 * between the check and the connect — rebinding — so these are defence in depth.)
 */

const privateFetchAllowed = (): boolean => process.env.WAYSTATION_ALLOW_PRIVATE_FETCH === '1';

type HostClass = { readonly kind: 'loopback' | 'internal'; readonly reason: string };

const LOOPBACK: HostClass = { kind: 'loopback', reason: 'a loopback address' };
const PRIVATE: HostClass = { kind: 'internal', reason: 'a private or internal address' };
const LINK_LOCAL: HostClass = { kind: 'internal', reason: 'a link-local address (incl. cloud metadata)' };
const UNIQUE_LOCAL: HostClass = { kind: 'internal', reason: 'a unique-local address' };
const UNSPECIFIED: HostClass = { kind: 'internal', reason: 'an unspecified ("this host") address' };

function parseIpv4(host: string): readonly number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : undefined;
}

function classifyIpv4([a, b]: readonly number[]): HostClass | undefined {
  if (a === 127) return LOOPBACK;
  if (a === 0) return UNSPECIFIED; // 0.0.0.0/8 "this network" — reaches loopback services on most stacks
  if (a === 169 && b === 254) return LINK_LOCAL; // incl. 169.254.169.254 cloud metadata
  if (a === 10) return PRIVATE;
  if (a === 192 && b === 168) return PRIVATE;
  if (a === 172 && b >= 16 && b <= 31) return PRIVATE;
  if (a === 100 && b >= 64 && b <= 127) return PRIVATE; // carrier-grade NAT
  return undefined;
}

/** Expands an IPv6 literal (with optional trailing dotted IPv4) into 8 16-bit groups. */
function parseIpv6(host: string): readonly number[] | undefined {
  if (isIP(host) !== 6) return undefined;
  let text = host.split('%')[0];
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = parseIpv4(dotted[1]);
    if (!v4) return undefined;
    text = `${text.slice(0, -dotted[1].length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined];
  const parse = (part: string | undefined): number[] => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  const left = parse(head);
  const right = parse(tail);
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<number>(Math.max(fill, 0)).fill(0), ...right];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

function classifyIpv6(groups: readonly number[]): HostClass | undefined {
  const embeddedV4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
  const firstFiveZero = groups.slice(0, 5).every((g) => g === 0);
  if (groups.every((g) => g === 0)) return UNSPECIFIED;
  if (firstFiveZero && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return LOOPBACK;
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d): judge the embedded address,
  // but never grant the loopback exemption through an IPv6 wrapper.
  if (firstFiveZero && (groups[5] === 0xffff || groups[5] === 0)) {
    const inner = classifyIpv4(embeddedV4);
    return inner ? { kind: 'internal', reason: inner.reason } : undefined;
  }
  // NAT64 well-known prefix 64:ff9b::/96 also embeds an IPv4 address.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    const inner = classifyIpv4(embeddedV4);
    return inner ? { kind: 'internal', reason: inner.reason } : undefined;
  }
  if ((groups[0] & 0xffc0) === 0xfe80) return LINK_LOCAL; // fe80::/10
  if ((groups[0] & 0xffc0) === 0xfec0) return LINK_LOCAL; // deprecated site-local fec0::/10
  if ((groups[0] & 0xfe00) === 0xfc00) return UNIQUE_LOCAL; // fc00::/7
  return undefined;
}

/** How `hostname` (a URL hostname or a bare address) is internal, or undefined for public / unresolved names. */
function classifyHost(hostname: string): HostClass | undefined {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return LOOPBACK;
  const v6 = parseIpv6(host);
  if (v6) return classifyIpv6(v6);
  if (host.includes(':')) return UNIQUE_LOCAL; // unparseable IPv6-ish literal: fail closed
  const v4 = parseIpv4(host);
  return v4 ? classifyIpv4(v4) : undefined;
}

export interface InternalHostOptions {
  /** Permit 127.0.0.0/8, ::1 and localhost (e.g. a dev MCP server). Never exempts other internal ranges. */
  readonly allowLoopback?: boolean;
}

function assertHostClass(host: string, what: string, opts: InternalHostOptions | undefined): void {
  const found = classifyHost(host);
  if (!found || (found.kind === 'loopback' && opts?.allowLoopback)) return;
  throw new LibraryInputError(
    `${what} must not point at ${found.reason}. Set WAYSTATION_ALLOW_PRIVATE_FETCH=1 to allow local targets.`,
  );
}

/**
 * Throws LibraryInputError if `url`'s host literal is link-local, private, CGNAT, unspecified,
 * unique-local or an IPv4-mapped form of those; loopback too unless `opts.allowLoopback`.
 * WAYSTATION_ALLOW_PRIVATE_FETCH=1 disables the check.
 */
export function assertNotInternalHost(url: URL, what: string, opts?: InternalHostOptions): void {
  if (privateFetchAllowed()) return;
  assertHostClass(url.hostname, what, opts);
}

/** Throws LibraryInputError if `url` targets an internal or loopback address, unless the private-fetch opt-in is set. */
export function assertAllowedHost(url: URL, what: string): void {
  assertNotInternalHost(url, what);
}

export type HostLookup = (hostname: string) => Promise<ReadonlyArray<{ readonly address: string; readonly family: number }>>;

const systemLookup: HostLookup = (hostname) => dns.promises.lookup(hostname, { all: true });

/**
 * Resolves `hostname` and applies the same rules as `assertNotInternalHost` to every address.
 * IP literals are checked directly without DNS. A DNS failure does not throw: the real
 * connection will fail on its own, and we must not turn a transient resolver error into a
 * misleading SSRF message.
 */
export async function assertResolvedHostAllowed(
  hostname: string,
  what: string,
  opts?: InternalHostOptions & { readonly lookup?: HostLookup },
): Promise<void> {
  if (privateFetchAllowed()) return;
  assertHostClass(hostname, what, opts);
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare) !== 0) return;
  let addresses: ReadonlyArray<{ readonly address: string }>;
  try {
    addresses = await (opts?.lookup ?? systemLookup)(bare);
  } catch {
    return;
  }
  for (const { address } of addresses) assertHostClass(address, what, opts);
}
