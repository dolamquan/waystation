import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Tower } from '../tower.ts';
import { UserError } from '../tower.ts';
import { TeamAuthError } from '../teams/teamManager.ts';
import { OpsInputError } from '../ops/templates.ts';
import { LibraryInputError } from '../library/types.ts';
import { agentRoutes, libraryRoutes } from './routes/index.ts';
import {
  WS_PROTOCOL, contentSecurityPolicy, isAllowedHost, isAllowedOrigin, tokenFromProtocols, tokensMatch,
} from './security.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_AGENT_BODY_BYTES = 32 * 1024;
const MAX_WS_PAYLOAD_BYTES = 64 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

type Handler = (ctx: { params: string[]; body: unknown; req: IncomingMessage; res: ServerResponse }) => unknown;
interface Route { method: string; pattern: RegExp; handler: Handler }

export interface ServerOptions {
  readonly tower: Tower;
  readonly port: number;
  readonly host: string;
  readonly token: string;
  readonly webDist?: string;
  /** Trust the Vite dev server origin. */
  readonly dev?: boolean;
  readonly instance?: { readonly pid: number; readonly startedAt: number };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'body too large'));
      if (chunks.length === 0) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const BASE_HEADERS = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function buildRoutes(tower: Tower, instance?: ServerOptions['instance']): Route[] {
  const r = (method: string, path: string, handler: Handler): Route =>
    ({ method, pattern: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), handler });
  const bodyOf = (body: unknown) => (body ?? {}) as Record<string, unknown>;
  return [
    r('GET', '/api/health', () => ({ app: 'waystation', ...instance })),
    r('GET', '/api/state', () => tower.state()),
    r('GET', '/api/agents/:id/events', ({ params }) => ({ events: tower.events(params[0]) })),
    r('POST', '/api/agents/:id/stop', async ({ params, body }) => {
      if (bodyOf(body).confirm !== true) throw new UserError('Stopping requires confirm: true.');
      await tower.stopAgent(params[0]);
      return { ok: true };
    }),
    r('POST', '/api/agents/:id/instruct', async ({ params, body }) => ({ ok: true, message: await tower.instruct(params[0], bodyOf(body).text) })),
    r('POST', '/api/agents/:id/intercept', ({ params, body }) => {
      tower.setIntercept(params[0], bodyOf(body).on === true);
      return { ok: true };
    }),
    r('POST', '/api/agents/:id/interrupt', async ({ params }) => {
      await tower.interrupt(params[0]);
      return { ok: true };
    }),
    r('POST', '/api/agents/:id/delegate', async ({ params, body }) => ({ ok: true, ...(await tower.delegate(params[0], body)) })),
    r('POST', '/api/agents/:id/skills', ({ params, body }) => {
      if (bodyOf(body).confirm !== true) throw new UserError('Attaching a skill requires confirm: true.');
      return { ok: true, target: tower.attachSkill(params[0], bodyOf(body).skillId) };
    }),
    r('POST', '/api/terminal', async ({ body }) => ({ ok: true, ...(await tower.openTerminal(body)) })),
    r('POST', '/api/agents/:id/cli', async ({ params }) => ({ ok: true, ...(await tower.openCli(params[0])) })),
    r('POST', '/api/teams/:id/operator-cli', async ({ params }) => ({ ok: true, ...(await tower.openTeamOperator(params[0])) })),
    r('POST', '/api/teams/:id/members/:member/return', ({ params }) => ({ ok: true, ...tower.returnTeamMember(params[0], params[1]) })),
    // Reports from the launcher running in the operator's terminal tab.
    r('POST', '/api/cli/:id/started', ({ params, body }) => {
      tower.cliStarted(params[0], body);
      return { ok: true };
    }),
    r('POST', '/api/cli/:id/ended', ({ params }) => {
      tower.cliEnded(params[0]);
      return { ok: true };
    }),
    // ---- usage, runaway guard, rename, restart, templates, schedules, prerequisites ----
    r('GET', '/api/usage', ({ req }) => ({ usage: tower.ops.usage(Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('days') ?? 7)) })),
    r('POST', '/api/agents/:id/name', ({ params, body }) => ({ ok: true, name: tower.ops.renameAgent(params[0], bodyOf(body).name) ?? null })),
    r('POST', '/api/agents/:id/restart', async ({ params, body }) => {
      if (bodyOf(body).confirm !== true) throw new UserError('Restarting requires confirm: true.');
      return { ok: true, agent: await tower.ops.restartAgent(params[0], body) };
    }),
    r('POST', '/api/agents/:id/breaker/reset', ({ params }) => {
      tower.ops.resetBreaker(params[0]);
      return { ok: true };
    }),
    r('GET', '/api/templates', () => ({ templates: tower.ops.templates() })),
    r('POST', '/api/templates', ({ body }) => ({ ok: true, template: tower.ops.createTemplate(body) })),
    r('POST', '/api/templates/:id/delete', ({ params }) => {
      tower.ops.deleteTemplate(params[0]);
      return { ok: true };
    }),
    r('GET', '/api/schedules', () => ({ schedules: tower.ops.schedules() })),
    r('POST', '/api/schedules', ({ body }) => ({ ok: true, schedule: tower.ops.createSchedule(body) })),
    r('POST', '/api/schedules/:id/enabled', ({ params, body }) => ({ ok: true, schedule: tower.ops.setScheduleEnabled(params[0], bodyOf(body).enabled === true) })),
    r('POST', '/api/schedules/:id/run', ({ params }) => ({ ok: true, agent: tower.ops.runScheduleNow(params[0]) })),
    r('POST', '/api/schedules/:id/delete', ({ params, body }) => {
      if (bodyOf(body).confirm !== true) throw new UserError('Deleting a schedule requires confirm: true.');
      tower.ops.deleteSchedule(params[0]);
      return { ok: true };
    }),
    r('GET', '/api/prerequisites', () => ({ prerequisites: tower.ops.prerequisites() })),
    r('GET', '/api/skills', () => ({ skills: tower.skills() })),
    r('POST', '/api/managed', ({ body }) => ({ ok: true, agent: tower.launch(body) })),
    r('POST', '/api/interceptions/:id', ({ params, body }) => {
      tower.decide(params[0], body);
      return { ok: true };
    }),
    r('POST', '/api/hooks/install', ({ body }) => {
      if (bodyOf(body).confirm !== true) throw new UserError('Installing hooks requires confirm: true.');
      return { ok: true, ...tower.installHooks() };
    }),
    r('POST', '/api/hooks/uninstall', () => ({ ok: true, ...tower.uninstallHooks() })),
    r('GET', '/api/audit', () => ({ entries: tower.store.auditLog() })),
    r('GET', '/api/teams', () => ({ teams: tower.teams.list() })),
    r('POST', '/api/teams', async ({ body }) => ({ ok: true, ...(await tower.createTeam(body)) })),
    r('GET', '/api/teams/:id/log', async ({ params }) => ({ entries: await tower.teamLog(params[0]) })),
    r('POST', '/api/teams/:id/message', async ({ params, body }) => ({ ok: true, message: await tower.messageTeam(params[0], bodyOf(body)) })),
    r('POST', '/api/teams/:id/pause', async ({ params }) => {
      await tower.pauseTeam(params[0]);
      return { ok: true };
    }),
    r('POST', '/api/teams/:id/resume', async ({ params }) => {
      await tower.resumeTeam(params[0]);
      return { ok: true };
    }),
    r('GET', '/api/teams/:id/members/:member/diff', async ({ params }) => ({ diff: await tower.teamDiff(params[0], params[1]) })),
    r('POST', '/api/teams/:id/members/:member/merge', async ({ params, body }) => {
      if (bodyOf(body).confirm !== true) throw new UserError('Merging requires confirm: true.');
      return { ok: true, message: await tower.mergeTeamMember(params[0], params[1]) };
    }),
    r('POST', '/api/teams/:id/disband', async ({ params, body }) => {
      if (bodyOf(body).confirm !== true) throw new UserError('Disbanding requires confirm: true.');
      return { ok: true, ...(await tower.disbandTeam(params[0], bodyOf(body).removeWorktrees !== false)) };
    }),
    r('POST', '/hook/event', ({ body }) => {
      tower.handleHookEvent(bodyOf(body));
      return { ok: true };
    }),
    r('POST', '/hook/pretooluse', async ({ body, res }) => {
      const { id, decision } = tower.requestHookDecision(bodyOf(body));
      // If Claude Code gives up (user pressed Esc / session closed), drop the pending request.
      res.on('close', () => { if (!res.writableEnded) tower.interceptions.cancel(id); });
      return decision;
    }),
    ...libraryRoutes(tower),
  ];
}

/** Routes for team members' MCP bridges. They carry a per-member token, never the operator token. */
function buildTeamRoutes(tower: Tower): Route[] {
  const memberToken = (req: IncomingMessage) => {
    const header = req.headers['x-team-token'];
    return Array.isArray(header) ? header[0] : header;
  };
  return [
    { method: 'POST', pattern: /^\/team\/tools$/, handler: ({ req }) => ({ tools: tower.teamTools(memberToken(req)) }) },
    {
      method: 'POST',
      pattern: /^\/team\/call$/,
      handler: ({ req, body }) => tower.teamCall(memberToken(req), (body ?? {}) as Record<string, unknown>),
    },
  ];
}

function serveStatic(webDist: string, port: number, urlPath: string, res: ServerResponse): boolean {
  const root = resolve(webDist);
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    throw new HttpError(400, 'bad path');
  }
  const requested = resolve(join(root, normalize(decoded)));
  const inside = requested === root || requested.startsWith(root + sep);
  const file = inside && existsSync(requested) && statSync(requested).isFile() ? requested : join(root, 'index.html');
  if (!existsSync(file)) return false;
  const isHtml = file.endsWith('.html');
  res.writeHead(200, {
    ...BASE_HEADERS,
    'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    ...(isHtml ? {
      'content-security-policy': contentSecurityPolicy(port),
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    } : {}),
  });
  res.end(readFileSync(file));
  return true;
}

export function startServer(opts: ServerOptions): Promise<Server> {
  const { tower, port, host, token, webDist, dev = false } = opts;
  const routes = buildRoutes(tower, opts.instance);
  const teamRoutes = buildTeamRoutes(tower);
  const bridgeRoutes = agentRoutes(tower);
  tower.teams.setEndpoint(`http://${host}:${port}`);
  tower.library.notifier.setEndpoint(`http://${host}:${port}`);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!isAllowedHost(req.headers.host, port) || !isAllowedOrigin(req.headers.origin, port, dev)) {
      sendJson(res, 403, { error: 'forbidden host or origin' });
      return;
    }
    if (url.pathname.startsWith('/team/')) {
      const teamRoute = teamRoutes.find((candidate) => candidate.method === req.method && candidate.pattern.test(url.pathname));
      if (!teamRoute) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, await teamRoute.handler({ params: [], body: await readBody(req), req, res }));
      return;
    }
    if (url.pathname.startsWith('/agent/')) {
      // Agent bridges (e.g. notify) carry their own per-agent token; each handler checks it.
      const bridgeRoute = bridgeRoutes.find((candidate) => candidate.method === req.method && candidate.pattern.test(url.pathname));
      if (!bridgeRoute) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      // Bridge messages are small (title ≤ 200, body ≤ 8000): don't buffer 1 MB from an unauthenticated caller.
      sendJson(res, 200, await bridgeRoute.handler({ params: [], body: await readBody(req, MAX_AGENT_BODY_BYTES), req, res }));
      return;
    }
    const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/hook/');
    if (!isApi) {
      // The UI shell is public; the token arrives separately in the URL fragment.
      if (req.method === 'GET' && webDist && serveStatic(webDist, port, url.pathname, res)) return;
      sendJson(res, 404, { error: 'not found (build the web UI with `npm run build`)' });
      return;
    }
    const provided = req.headers['x-tower-token'];
    if (!tokensMatch(Array.isArray(provided) ? provided[0] : provided, token)) {
      sendJson(res, 401, { error: 'missing or invalid token' });
      return;
    }
    const route = routes.find((candidate) => candidate.method === req.method && candidate.pattern.test(url.pathname));
    if (!route) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const params = (route.pattern.exec(url.pathname) ?? []).slice(1).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        throw new HttpError(400, 'bad path');
      }
    });
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    sendJson(res, 200, await route.handler({ params, body, req, res }));
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof UserError || error instanceof OpsInputError || error instanceof LibraryInputError) {
        sendJson(res, 400, { error: error.message });
      }
      else if (error instanceof TeamAuthError) sendJson(res, 401, { error: error.message });
      else if (error instanceof HttpError) sendJson(res, error.status, { error: error.message });
      else {
        console.error('[api]', req.method, req.url, error);
        sendJson(res, 500, { error: 'internal error' });
      }
    });
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ok = url.pathname === '/ws'
      && isAllowedHost(req.headers.host, port)
      && isAllowedOrigin(req.headers.origin, port, dev)
      && tokensMatch(tokenFromProtocols(req.headers['sec-websocket-protocol']), token);
    if (!ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const broadcast = (message: unknown) => {
    const data = JSON.stringify(message);
    for (const client of wss.clients) if (client.readyState === 1) client.send(data);
  };
  wss.on('connection', (ws: WebSocket) => {
    ws.on('error', (error) => console.error('[ws]', error.message));
    ws.send(JSON.stringify({ type: 'snapshot', ...tower.state() }));
  });
  const onAgents = (agents: unknown) => broadcast({ type: 'agents', agents, hooks: tower.state().hooks });
  const onEvent = (event: unknown) => broadcast({ type: 'event', event });
  const onPending = (pending: unknown) => broadcast({ type: 'pending', pending });
  const onTeams = (teams: unknown) => broadcast({ type: 'teams', teams });
  const onTeamLog = (entry: unknown) => broadcast({ type: 'team_log', entry });
  const onNotification = (entry: unknown) => broadcast({ type: 'notification', entry });
  tower.library.notifier.on('notification', onNotification);
  tower.registry.on('agents', onAgents);
  tower.registry.on('event', onEvent);
  tower.interceptions.on('changed', onPending);
  tower.teams.on('teams', onTeams);
  tower.teams.on('log', onTeamLog);
  server.on('close', () => {
    tower.registry.off('agents', onAgents);
    tower.registry.off('event', onEvent);
    tower.interceptions.off('changed', onPending);
    tower.teams.off('teams', onTeams);
    tower.teams.off('log', onTeamLog);
    tower.library.notifier.off('notification', onNotification);
    for (const client of wss.clients) client.terminate();
    wss.close();
  });

  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveServer(server));
  });
}
