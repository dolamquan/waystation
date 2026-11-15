import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { WS_PROTOCOL } from '../api/security.ts';
import { UserError } from '../userError.ts';
import { requiredRole, roleAllows, socketRole } from './access.ts';
import type { DeviceRegistry, RemoteDevice } from './devices.ts';

/**
 * The remote listener. It sits in front of the local API (normally behind Tailscale Serve, which adds
 * HTTPS and keeps it on your private network): it identifies a paired device by its cookie, checks
 * what that device may do, and only then forwards the request to the local server with the local
 * token. Devices never see the local token, and anything not allowed is refused here.
 */
export interface GatewayOptions {
  readonly devices: DeviceRegistry;
  readonly localHost: string;
  readonly localPort: number;
  readonly token: string;
  /** Host names devices use, e.g. `my-pc.tail1234.ts.net`. Loopback on the gateway port is always allowed. */
  readonly hostnames: readonly string[];
  readonly audit: (action: string, target: string, detail: unknown) => void;
  readonly now?: () => number;
}

export const DEVICE_COOKIE = 'waystation_device';
/** Over HTTPS the cookie is host-only and Secure by name, so other services on the same host name never get it. */
export const SECURE_DEVICE_COOKIE = `__Host-${DEVICE_COOKIE}`;
/** Tells the local server a socket comes through the gateway: it is never wired to the desktop or VS Code bridges. */
export const REMOTE_MARK = 'x-waystation-remote';
const COOKIE_MAX_AGE_S = 30 * 86_400;
const MAX_SOCKETS_PER_DEVICE = 8;
const SWEEP_MS = 60_000;
const PAIR_LIMIT = 10;
const PAIR_WINDOW_MS = 60_000;
const MAX_PAIR_BODY = 4096;
const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
/** Request headers passed through to the local API; everything else (cookies included) stays here. */
const FORWARD_HEADERS = ['content-type', 'content-length', 'accept', 'if-none-match'];

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { ...NO_STORE, 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || undefined;
  }
  return undefined;
}

/** Same normalisation the URL parser applies, so `..` can never reach a looser rule. */
function pathOf(rawUrl: string | undefined): { pathname: string; search: string } {
  const url = new URL(rawUrl ?? '/', 'http://gateway.invalid');
  return { pathname: url.pathname, search: url.search };
}

/** The local CSP names loopback WebSocket origins; through the gateway the page talks to its own origin. */
function remoteCsp(value: string): string {
  return value.split(';').map((directive) => (directive.trim().startsWith('connect-src') ? " connect-src 'self'" : directive)).join(';');
}

async function readSmallBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new UserError('Request too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw new UserError('Send JSON.');
  }
}

export class RemoteGateway {
  private server?: Server;
  private sweep?: NodeJS.Timeout;
  private readonly sockets = new Map<string, Set<Duplex>>();
  private pairAttempts: number[] = [];
  private readonly allowedHosts: Set<string>;

  constructor(private readonly options: GatewayOptions, private readonly port: number) {
    this.allowedHosts = new Set([...options.hostnames.map((host) => host.toLowerCase()), `127.0.0.1:${port}`, `localhost:${port}`]);
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  start(bindHost = '127.0.0.1'): Promise<Server> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        if (error instanceof UserError) sendJson(res, 400, { error: error.message });
        else {
          console.error('[remote]', req.method, req.url, (error as Error).message);
          if (!res.headersSent) sendJson(res, 502, { error: 'Waystation could not complete that request.' });
          else res.destroy();
        }
      });
    });
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server = server;
    // Idle-expired devices lose their live sockets; an open socket counts as use.
    this.sweep = setInterval(() => this.sweepSockets(), SWEEP_MS);
    this.sweep.unref();
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, bindHost, () => resolve(server));
    });
  }

  async stop(): Promise<void> {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = undefined;
    for (const sockets of this.sockets.values()) for (const socket of sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private sweepSockets(): void {
    for (const deviceId of [...this.sockets.keys()]) {
      if (this.options.devices.isActive(deviceId)) this.options.devices.touch(deviceId);
      else this.disconnect(deviceId);
    }
  }

  /** Ends a device's live connections (after a revoke or a role change). */
  disconnect(deviceId: string): void {
    for (const socket of this.sockets.get(deviceId) ?? []) socket.destroy();
    this.sockets.delete(deviceId);
  }

  private hostAllowed(host: string | undefined): boolean {
    return typeof host === 'string' && this.allowedHosts.has(host.toLowerCase());
  }

  /** Browsers send Origin on POST and WebSocket requests: it must be one of our own host names. */
  private originAllowed(origin: string | undefined, required: boolean): boolean {
    if (origin === undefined) return !required;
    try {
      const { protocol, host } = new URL(origin);
      return (protocol === 'https:' || protocol === 'http:') && this.allowedHosts.has(host.toLowerCase());
    } catch {
      return false;
    }
  }

  private device(req: IncomingMessage): RemoteDevice | undefined {
    const cookies = req.headers.cookie;
    return this.options.devices.authenticate(cookieValue(cookies, SECURE_DEVICE_COOKIE) ?? cookieValue(cookies, DEVICE_COOKIE));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    if (!this.hostAllowed(req.headers.host) || !this.originAllowed(req.headers.origin, method !== 'GET')) {
      sendJson(res, 403, { error: 'forbidden host or origin' });
      return;
    }
    const { pathname, search } = pathOf(req.url);
    if (pathname.startsWith('/remote/')) {
      await this.handleRemote(method, pathname, req, res);
      return;
    }
    const isApi = pathname.startsWith('/api/') || /^\/(hook|agent|team)\//.test(pathname) || pathname === '/mcp';
    if (!isApi) {
      // The UI shell is public, as it is locally.
      if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
      this.forward(req, res, pathname + search, undefined);
      return;
    }
    const required = requiredRole(method, pathname);
    if (required === 'never') { sendJson(res, 403, { error: 'This is only available on the Waystation desktop.' }); return; }
    const device = this.device(req);
    if (!device) { sendJson(res, 401, { error: 'This device is not paired. Pair it from the Waystation desktop.' }); return; }
    if (!roleAllows(device.role, required)) {
      sendJson(res, 403, { error: `This device has ${device.role} access. Ask for ${required} access on the Waystation desktop.` });
      return;
    }
    if (method !== 'GET') this.options.audit('remote_request', device.id, { device: device.name, method, path: pathname });
    this.forward(req, res, pathname + search, device);
  }

  private async handleRemote(method: string, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (method === 'GET' && pathname === '/remote/session') {
      const device = this.device(req);
      sendJson(res, 200, device ? { paired: true, device: { name: device.name, role: device.role } } : { paired: false });
      return;
    }
    if (method === 'POST' && pathname === '/remote/pair') {
      if (!this.allowPairAttempt()) { sendJson(res, 429, { error: 'Too many pairing attempts. Wait a minute and try again.' }); return; }
      const body = (await readSmallBody(req, MAX_PAIR_BODY)) as Record<string, unknown>;
      const { device, token } = this.options.devices.completePairing(body.code, body.name);
      this.options.audit('remote_pair', device.id, { device: device.name, role: device.role });
      sendJson(res, 200, { paired: true, device: { name: device.name, role: device.role } }, { 'set-cookie': this.cookie(req, token, COOKIE_MAX_AGE_S) });
      return;
    }
    if (method === 'POST' && pathname === '/remote/forget') {
      const device = this.device(req);
      if (device) {
        this.options.devices.revoke(device.id);
        this.disconnect(device.id);
        this.options.audit('remote_forget', device.id, { device: device.name });
      }
      sendJson(res, 200, { paired: false }, { 'set-cookie': this.cookie(req, '', 0) });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  }

  /** Secure whenever the page was loaded over HTTPS (Tailscale Serve); a plain-HTTP test connection could not store it. */
  private cookie(req: IncomingMessage, value: string, maxAge: number): string {
    const https = req.headers.origin?.startsWith('https:') || req.headers['x-forwarded-proto'] === 'https';
    return https
      ? `${SECURE_DEVICE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Secure`
      : `${DEVICE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
  }

  private allowPairAttempt(): boolean {
    const now = this.now;
    this.pairAttempts = [...this.pairAttempts.filter((at) => now - at < PAIR_WINDOW_MS), now];
    return this.pairAttempts.length <= PAIR_LIMIT;
  }

  private forward(req: IncomingMessage, res: ServerResponse, path: string, device: RemoteDevice | undefined): void {
    const headers: Record<string, string> = { host: `${this.options.localHost}:${this.options.localPort}`, [REMOTE_MARK]: '1' };
    for (const name of FORWARD_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    if (device) headers['x-tower-token'] = this.options.token;
    const upstream = httpRequest({ host: this.options.localHost, port: this.options.localPort, method: req.method, path, headers }, (response) => {
      const out = { ...response.headers };
      const csp = out['content-security-policy'];
      if (typeof csp === 'string') out['content-security-policy'] = remoteCsp(csp);
      delete out['set-cookie'];
      res.writeHead(response.statusCode ?? 502, out);
      response.pipe(res);
    });
    upstream.on('error', (error) => {
      if (res.destroyed) return;
      if (!res.headersSent) sendJson(res, 502, { error: 'Waystation is not responding.' });
      else res.destroy(error);
    });
    // The device went away: don't leave the local request running for nobody.
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // After 'upgrade' Node no longer handles socket errors: a client resetting now must not crash the daemon.
    socket.on('error', () => undefined);
    const refuse = (status: string) => { socket.write(`HTTP/1.1 ${status}\r\n\r\n`); socket.destroy(); };
    const { pathname, search } = pathOf(req.url);
    if (!this.hostAllowed(req.headers.host) || !this.originAllowed(req.headers.origin, true)) { refuse('403 Forbidden'); return; }
    const device = this.device(req);
    if (!device) { refuse('401 Unauthorized'); return; }
    if (!roleAllows(device.role, socketRole(pathname))) { refuse('403 Forbidden'); return; }
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (typeof key !== 'string' || typeof version !== 'string') { refuse('400 Bad Request'); return; }
    if ((this.sockets.get(device.id)?.size ?? 0) >= MAX_SOCKETS_PER_DEVICE) { refuse('429 Too Many Requests'); return; }
    const upstream: Socket = connect(this.options.localPort, this.options.localHost, () => {
      const extensions = req.headers['sec-websocket-extensions'];
      const lines = [
        `GET ${pathname}${search} HTTP/1.1`,
        `Host: ${this.options.localHost}:${this.options.localPort}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Key: ${key}`,
        `Sec-WebSocket-Version: ${version}`,
        `Sec-WebSocket-Protocol: ${WS_PROTOCOL}, ${this.options.token}`,
        `${REMOTE_MARK}: 1`,
        ...(typeof extensions === 'string' ? [`Sec-WebSocket-Extensions: ${extensions}`] : []),
      ];
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const tracked = this.sockets.get(device.id) ?? new Set<Duplex>();
    this.sockets.set(device.id, tracked.add(socket));
    const cleanup = () => { upstream.destroy(); socket.destroy(); this.sockets.get(device.id)?.delete(socket); };
    upstream.on('error', cleanup);
    socket.on('error', cleanup);
    upstream.on('close', cleanup);
    socket.on('close', cleanup);
  }
}
