import { timingSafeEqual } from 'node:crypto';

export const DEV_WEB_PORT = 5173;
export const WS_PROTOCOL = 'agent-tower';

export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

/** The Vite dev server origin is only trusted when the daemon runs with --dev. */
export function allowedOrigins(port: number, dev = false): Set<string> {
  const own = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const devOrigins = dev ? [`http://127.0.0.1:${DEV_WEB_PORT}`, `http://localhost:${DEV_WEB_PORT}`] : [];
  return new Set([...own, ...devOrigins]);
}

/** Blocks DNS-rebinding: the Host header must be a loopback name we expect. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  return typeof host === 'string' && allowedHosts(port).has(host.toLowerCase());
}

/** Blocks CSRF from other sites. Requests without Origin (the hook script, curl) are allowed; the token still applies. */
export function isAllowedOrigin(origin: string | undefined, port: number, dev = false): boolean {
  return origin === undefined || allowedOrigins(port, dev).has(origin.toLowerCase());
}

export function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Browsers cannot set headers on WebSockets, so the token rides in the subprotocol list. */
export function tokenFromProtocols(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join(',') : header ?? '';
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  return parts[0] === WS_PROTOCOL ? parts[1] : undefined;
}

export function contentSecurityPolicy(port: number): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
    "img-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}
