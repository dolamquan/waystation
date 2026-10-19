import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

export interface StaticSite {
  readonly url: string;
  close(): Promise<void>;
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The file a request maps to, or undefined. Stays inside `root` and never serves hidden
 * files or folders (.git, .env), so the preview can't be used to read secrets.
 */
export function resolveSitePath(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return undefined;
  }
  const segments = decoded.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.') || segment.includes(':'))) return undefined;
  const base = resolve(root);
  const target = resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + sep)) return undefined;
  const file = isFile(target) ? target : join(target, 'index.html');
  return isFile(file) && staysInside(base, file) ? file : undefined;
}

/** A junction or symlink inside the site must not lead back out of it. */
function staysInside(base: string, file: string): boolean {
  try {
    const realBase = realpathSync(base);
    return realpathSync(file).startsWith(realBase + sep);
  } catch {
    return false;
  }
}

function handle(root: string, port: number, req: IncomingMessage, res: ServerResponse): void {
  // Block DNS rebinding: only loopback names for this port.
  const host = (req.headers.host ?? '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    res.writeHead(403).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  const file = resolveSitePath(root, req.url ?? '/');
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  // no-store: a reload after the agent's next turn always shows the newest files.
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

/** Serves a plain website folder on a free loopback port. */
export function serveStaticSite(root: string): Promise<StaticSite> {
  let port = 0;
  const server: Server = createServer((req, res) => handle(root, port, req, res));
  return new Promise((resolveSite, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolveSite({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}
