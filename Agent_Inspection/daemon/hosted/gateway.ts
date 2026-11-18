import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type OrganizationRole = 'viewer' | 'operator' | 'admin';
export interface HostedOrganization { id: string; name: string; upstream: string; token: string; project: string; members: Record<string, OrganizationRole> }
export interface HostedOptions { publicOrigin: string; proxySecret: string; cookieSecret: string; organizations: HostedOrganization[]; audit: (event: HostedAudit) => void; requestsPerMinute?: number; now?: () => number }
export interface HostedAudit { at: number; requestId: string; subject: string; organizationId?: string; method: string; path: string; status: number }
const COOKIE = '__Host-waystation_org';
const ROLES = ['viewer', 'operator', 'admin'];
const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const json = (res: ServerResponse, status: number, value: unknown, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }); res.end(JSON.stringify(value)); };

/** Only this dedicated agent API is exposed. Desktop, shell, filesystem, MCP bridges and pairing stay private. */
export function hostedRole(method: string, path: string): OrganizationRole | undefined {
  if (method === 'GET') return /^\/api\/(?:architectures(?:\/[-\w]+(?:\/connections|\/nodes\/[-\w]+\/resource|\/nodes\/[-\w]+\/releases)?)?|agent-(?:platform|deployments|conversations|runs|evaluation|datasets|evaluators|experiments|sandboxes|secrets|tools)(?:\/[-\w]+)*(?:\/\d+)?|connectors)$/.test(path) || path === '/api/providers' ? 'viewer' : undefined;
  if (method !== 'POST') return;
  if (/^\/api\/architectures\/[-\w]+\/nodes\/[-\w]+\/test$/.test(path)) return;
  // Operator grants execution control; configuration, code and credential access remain administrator-only.
  if (/^\/api\/agent-runs\/[-\w]+\/(?:cancel|decision|resume|retry|evaluate)$/.test(path) || /^\/api\/architectures\/[-\w]+\/(?:run|nodes\/[-\w]+\/run)$/.test(path) || /^\/api\/agent-(?:deployments\/[-\w]+\/(?:runs|conversations)|conversations\/[-\w]+\/messages|experiments(?:\/[-\w]+\/(?:cancel|retry))?)$/.test(path)) return 'operator';
  if (/^\/api\/(?:architectures|agent-(?:capabilities|service-connections|environments|datasets|evaluators|tools|secrets|sandboxes|deployments|triggers))(?:\/[-\w]+)*$/.test(path) || /^\/api\/connectors(?:\/[-\w]+)*$/.test(path)) return 'admin';
  return;
}

/** Identity is supplied by the private OIDC proxy. The shared secret and overwritten identity header are both required. */
export function createHostedGateway(options: HostedOptions) {
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('Hosted publicOrigin must be an HTTPS origin.');
  if (options.proxySecret.length < 32 || options.cookieSecret.length < 32) throw new Error('Hosted proxy and cookie secrets must each contain at least 32 characters.');
  const ids = new Set<string>();
  for (const org of options.organizations) {
    const worker = new URL(org.upstream);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(org.id) || ids.has(org.id) || !org.name || !['http:', 'https:'].includes(worker.protocol) || worker.username || worker.password || worker.pathname !== '/' || worker.search || worker.hash || org.token.length < 32 || Object.values(org.members).some(r => !ROLES.includes(r))) throw new Error('Invalid hosted organization configuration.');
    if (options.organizations.some(other => other.id !== org.id && (other.upstream === org.upstream || other.token === org.token))) throw new Error('Organizations require distinct workers and worker tokens.');
    ids.add(org.id);
  }
  const attempts = new Map<string, { at: number; count: number }>();
  const now = options.now ?? Date.now;
  const sign = (value: string) => createHmac('sha256', options.cookieSecret).update(value).digest('base64url');
  const selectedCookie = (orgId: string, subject: string) => { const value = Buffer.from(JSON.stringify({ orgId, subject, expires: now() + 8 * 3600000 })).toString('base64url'); return `${value}.${sign(value)}`; };
  const selectedOrg = (req: IncomingMessage, subject: string, memberships: HostedOrganization[]) => {
    const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (cookie) {
      const [value, signature, extra] = cookie.split('.');
      if (value && signature && !extra && same(signature, sign(value))) try { const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()); if (parsed.subject === subject && parsed.expires > now()) return memberships.find(o => o.id === parsed.orgId); } catch { /* No trusted selection. */ }
      return undefined;
    }
    return memberships.length === 1 ? memberships[0] : undefined;
  };
  const server = createServer(async (req, res) => {
    const requestId = randomUUID(); const at = now(); let subject = ''; let organizationId: string | undefined; let path = '/';
    res.setHeader('x-request-id', requestId);
    const audit = () => { try { options.audit({ at, requestId, subject, organizationId, method: req.method ?? '', path, status: res.statusCode }); } catch { console.error('[hosted] Audit write failed for request', requestId); } };
    try {
      if (req.url === '/healthz') { json(res, 200, { ok: true }); return; }
      if (req.headers.host !== origin.host) { json(res, 403, { error: 'Unrecognized host.' }); return; }
      const machine = /^\/hooks\/([a-z0-9][a-z0-9-]{0,63})\/([a-zA-Z0-9_-]{1,100})$/.exec(req.url ?? '');
      if (machine && req.method === 'POST') {
        const worker = options.organizations.find(o => o.id === machine[1]);
        const authorization = req.headers.authorization;
        if (!worker || typeof authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(authorization) || req.headers.origin !== undefined && req.headers.origin !== origin.origin) { json(res, 403, { error: 'Valid trigger authorization required.' }); return; }
        subject = `trigger:${machine[2]}`; organizationId = worker.id; path = `/hooks/${worker.id}/${machine[2]}`; res.once('finish', audit);
        const key = `hook:${worker.id}:${machine[2]}`; const bucket = attempts.get(key);
        if (!bucket || at - bucket.at >= 60000) attempts.set(key, { at, count: 1 }); else if (++bucket.count > 60) { json(res, 429, { error: 'Trigger rate limit reached.' }, { 'retry-after': '60' }); return; }
        options.audit({ at, requestId, subject, organizationId, method: 'POST', path, status: 102 });
        const upstream = new URL(worker.upstream); const port = upstream.port || (upstream.protocol === 'https:' ? '443' : '80');
        const proxy = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)(new URL(`/agent/agent-platform/${machine[2]}/invoke`, upstream), { method: 'POST', headers: { host: `127.0.0.1:${port}`, authorization, 'content-type': 'application/json', 'x-waystation-request-id': requestId }, timeout: 15000 }, response => { res.writeHead(response.statusCode ?? 502, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.pipe(res); });
        proxy.on('timeout', () => proxy.destroy()); proxy.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'Organization worker is unavailable.' }); else res.destroy(); });
        req.resume(); proxy.end('{}'); return;
      }
      const duplicates = ['x-waystation-proxy-secret', 'x-waystation-subject'].some(name => req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === name).length !== 1);
      if (duplicates || !same(String(req.headers['x-waystation-proxy-secret'] ?? ''), options.proxySecret) || typeof req.headers['x-waystation-subject'] !== 'string') { json(res, 401, { error: 'Authenticate through the configured identity proxy.' }); return; }
      subject = req.headers['x-waystation-subject'];
      if (!subject || subject.length > 500 || /[\r\n\0]/.test(subject)) { json(res, 401, { error: 'Invalid authenticated identity.' }); return; }
      res.once('finish', audit);
      if (attempts.size >= 10000 && !attempts.has(subject)) { for (const [key, value] of attempts) if (at - value.at >= 60000) attempts.delete(key); if (attempts.size >= 10000) { json(res, 429, { error: 'Gateway capacity reached. Retry shortly.' }); return; } }
      const bucket = attempts.get(subject); if (!bucket || at - bucket.at >= 60000) attempts.set(subject, { at, count: 1 }); else if (++bucket.count > (options.requestsPerMinute ?? 600)) { json(res, 429, { error: 'Request rate limit reached.' }, { 'retry-after': '60' }); return; }
      if (attempts.size > 10000) for (const [key, value] of attempts) if (at - value.at >= 60000) attempts.delete(key);
      const url = new URL(req.url ?? '/', origin); path = url.pathname;
      if (url.origin !== origin.origin || /%2f|%5c|%2e|\\/i.test((req.url ?? '').split('?')[0]) || path.includes('//')) { json(res, 400, { error: 'Invalid request path.' }); return; }
      if (req.headers.origin !== undefined && req.headers.origin !== origin.origin || !['GET', 'HEAD'].includes(req.method ?? '') && req.headers.origin !== origin.origin) { json(res, 403, { error: 'Requests must come from this application origin.' }); return; }
      const memberships = options.organizations.filter(o => Object.hasOwn(o.members, subject));
      const org = selectedOrg(req, subject, memberships); organizationId = org?.id;
      if (path === '/api/hosted/session' && req.method === 'GET') { json(res, 200, { hosted: true, subject, organizations: memberships.map(o => ({ id: o.id, name: o.name, role: o.members[subject] })), organization: org ? { id: org.id, name: org.name, role: org.members[subject], project: org.project } : null }); return; }
      if (path === '/api/hosted/organization' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 2048) { json(res, 413, { error: 'Request too large.' }); return; } }
        let choice: any; try { choice = JSON.parse(body); } catch { json(res, 400, { error: 'Send a valid organization selection.' }); return; }
        const selected = memberships.find(o => o.id === choice.organizationId); if (!selected) { json(res, 403, { error: 'Organization membership required.' }); return; }
        organizationId = selected.id; json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=${selectedCookie(selected.id, subject)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800` }); return;
      }
      if (req.method === 'GET' && path === '/') { res.writeHead(302, { location: '/hosted', 'cache-control': 'no-store' }); res.end(); return; }
      // Static assets contain no tenant data and can be served before choosing an organization.
      const staticPage = req.method === 'GET' && (path === '/hosted' || /^\/assets\/[a-zA-Z0-9_.-]+$/.test(path) || /^\/fonts\/[a-zA-Z0-9_.-]+$/.test(path) || path === '/favicon.svg');
      const worker = org ?? (staticPage ? options.organizations[0] : undefined);
      if (!worker) { json(res, 403, { error: memberships.length ? 'Choose an organization first.' : 'Your identity has no organization membership.' }); return; }
      if (!staticPage) {
        const required = hostedRole(req.method ?? '', path);
        if (!org || !required || ROLES.indexOf(org.members[subject]) < ROLES.indexOf(required)) { json(res, 403, { error: 'Your organization role does not allow this action.' }); return; }
      }
      const upstream = new URL(worker.upstream); const port = upstream.port || (upstream.protocol === 'https:' ? '443' : '80');
      if (req.method === 'POST') options.audit({ at, requestId, subject, organizationId, method: 'POST', path, status: 102 });
      const headers: Record<string, string> = { host: `127.0.0.1:${port}`, 'x-tower-token': worker.token, 'x-waystation-actor': subject, 'x-waystation-request-id': requestId };
      for (const name of ['content-type', 'accept', 'if-none-match']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      if (Number(req.headers['content-length'] ?? 0) > 1000000) { json(res, 413, { error: 'Request too large.' }); return; }
      let received = 0;
      const proxy = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)(new URL(staticPage && path === '/hosted' ? '/' : `${path}${url.search}`, upstream), { method: req.method, headers, timeout: 150000 }, response => {
        const forwarded: Record<string, string | string[]> = {};
        for (const name of ['content-type', 'content-length', 'etag', 'cache-control', 'content-disposition', 'x-content-type-options']) { const value = response.headers[name]; if (value !== undefined) forwarded[name] = value; }
        forwarded['content-security-policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
        forwarded['cache-control'] = staticPage ? forwarded['cache-control'] ?? 'no-cache' : 'no-store';
        res.writeHead(response.statusCode ?? 502, forwarded); response.pipe(res);
      });
      proxy.on('timeout', () => proxy.destroy(new Error('timeout')));
      proxy.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'Organization worker is unavailable. Retry shortly.' }); else res.destroy(); });
      req.on('data', chunk => { received += chunk.length; if (received > 1000000) { proxy.destroy(); if (!res.headersSent) json(res, 413, { error: 'Request too large.' }); } });
      req.on('aborted', () => proxy.destroy()); res.on('close', () => { if (!res.writableFinished) proxy.destroy(); }); req.pipe(proxy);
    } catch { if (!res.headersSent) json(res, 500, { error: 'Hosted request failed. Use the request id when contacting your administrator.' }); else res.destroy(); }
  });
  // Hosted workflows use HTTP polling; native console/browser/WebSocket control is deliberately outside this API.
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  server.requestTimeout = 160000; server.headersTimeout = 15000;
  return server;
}

export function loadHostedOptions(configFile: string): HostedOptions {
  const config = JSON.parse(readFileSync(configFile, 'utf8')); const secret = (name: string) => { const file = process.env[name]; if (!file) throw new Error(`Set ${name} to a mounted secret file.`); return readFileSync(file, 'utf8').trim(); };
  const auditPath = process.env.WAYSTATION_HOSTED_AUDIT_FILE; if (!auditPath) throw new Error('Set WAYSTATION_HOSTED_AUDIT_FILE to a durable audit path.');
  mkdirSync(dirname(auditPath), { recursive: true });
  return { publicOrigin: config.publicOrigin, proxySecret: secret('WAYSTATION_PROXY_SECRET_FILE'), cookieSecret: secret('WAYSTATION_COOKIE_SECRET_FILE'), organizations: config.organizations.map((org: any) => ({ ...org, token: secret(org.tokenFileEnv) })), audit: event => appendFileSync(auditPath, `${JSON.stringify(event)}\n`, { mode: 0o600, flush: true }) };
}
