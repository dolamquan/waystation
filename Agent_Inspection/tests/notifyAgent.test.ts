import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { notifyAgentRoutes, notifyRoutes } from '../daemon/api/routes/notify.ts';
import type { Route } from '../daemon/api/routes/route.ts';
import { INBOX_CHANNEL_ID } from '../daemon/library/types.ts';
import type { ManagedLaunch } from '../daemon/managed/types.ts';
import { NOTIFY_MCP_SCRIPT, NOTIFY_PROMPT, NOTIFY_TOKEN_ENV, NOTIFY_URL_ENV, type Notifier } from '../daemon/notify/notifier.ts';
import { TeamAuthError } from '../daemon/teams/teamManager.ts';
import type { Tower } from '../daemon/tower.ts';
import { SLACK_URL, makeNotifier } from './notifyHelpers.ts';

const launch: ManagedLaunch = { vendor: 'claude', cwd: 'C:/work', prompt: 'go', agentId: 'managed:1', name: 'Scout' };

const fakeTower = (notifier: Notifier, names: Record<string, string> = {}): Tower =>
  ({ library: { notifier }, registry: { get: (id: string) => (names[id] ? { name: names[id] } : undefined) } }) as unknown as Tower;

const call = async (routes: Route[], method: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  const route = routes.find((candidate) => candidate.method === method && candidate.pattern.test(path.split('?')[0]));
  if (!route) throw new Error(`no route ${method} ${path}`);
  const params = (route.pattern.exec(path.split('?')[0]) ?? []).slice(1);
  const req = { headers, url: path } as unknown as IncomingMessage;
  return route.handler({ params, body, req, res: {} as never });
};

describe('contribute', () => {
  it('adds nothing without notify channels', () => {
    const { notifier } = makeNotifier();
    expect(notifier.contribute({ skillIds: ['a'] }, launch)).toEqual({});
  });

  it('requires known channels and a ready endpoint', () => {
    const { notifier } = makeNotifier();
    expect(() => notifier.contribute({ notifyChannelIds: ['nch_missing'] }, launch)).toThrow(/unknown notification channel/);
    expect(() => notifier.contribute({ notifyChannelIds: [INBOX_CHANNEL_ID] }, launch)).toThrow(/endpoint not ready/);
    notifier.setEndpoint('http://127.0.0.1:1');
    expect(() => notifier.contribute({ notifyChannelIds: [INBOX_CHANNEL_ID] }, { ...launch, agentId: undefined })).toThrow(/agent id/);
  });

  it('gives the agent the notify bridge with its own token in env, never on argv', () => {
    const { notifier } = makeNotifier();
    notifier.setEndpoint('http://127.0.0.1:4545');
    const contribution = notifier.contribute({ notifyChannelIds: [INBOX_CHANNEL_ID] }, launch);
    const token = contribution.env?.[NOTIFY_TOKEN_ENV] ?? '';
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(contribution.mcpServers?.notify).toEqual({
      command: process.execPath, args: [NOTIFY_MCP_SCRIPT], env: { [NOTIFY_URL_ENV]: 'http://127.0.0.1:4545' }, inheritEnv: [NOTIFY_TOKEN_ENV],
    });
    expect(contribution.appendSystemPrompt).toBe(NOTIFY_PROMPT);
    expect(notifier.authenticate(token)?.agentId).toBe('managed:1');
  });

  it('keeps one live token per agent and revokes it', () => {
    const { notifier } = makeNotifier();
    notifier.setEndpoint('http://127.0.0.1:1');
    const first = notifier.contribute({ notifyChannelIds: [INBOX_CHANNEL_ID] }, launch).env![NOTIFY_TOKEN_ENV];
    const second = notifier.contribute({ notifyChannelIds: [INBOX_CHANNEL_ID] }, launch).env![NOTIFY_TOKEN_ENV];
    expect(notifier.authenticate(first)).toBeUndefined();
    expect(notifier.authenticate(second)).toBeDefined();
    notifier.revoke('managed:1');
    notifier.revoke('managed:1');
    expect(notifier.authenticate(second)).toBeUndefined();
    expect(notifier.authenticate(undefined)).toBeUndefined();
  });
});

describe('agent route', () => {
  it('posts with a valid token to the granted channels, named after the agent', async () => {
    const { notifier, fetch } = makeNotifier();
    notifier.setEndpoint('http://127.0.0.1:1');
    const slack = notifier.createChannel({ kind: 'slack', label: 'S', secrets: { webhookUrl: SLACK_URL } });
    const token = notifier.contribute({ notifyChannelIds: [slack.id] }, launch).env![NOTIFY_TOKEN_ENV];
    const routes = notifyAgentRoutes(fakeTower(notifier, { 'managed:1': 'Renamed scout' }));

    const answer = await call(routes, 'POST', '/agent/notify', { title: 'Done', body: 'PR #4 opened', level: 'success' }, { 'x-agent-token': token });

    expect(answer).toEqual({ ok: true, results: [{ channelId: slack.id, ok: true }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(notifier.notifications().notifications[0]).toMatchObject({ source: 'agent:Renamed scout', agentId: 'managed:1', level: 'success' });
  });

  it('rejects a missing or wrong token with a 401 error', async () => {
    const { notifier } = makeNotifier();
    const routes = notifyAgentRoutes(fakeTower(notifier));
    await expect(call(routes, 'POST', '/agent/notify', { title: 'x' })).rejects.toBeInstanceOf(TeamAuthError);
    await expect(call(routes, 'POST', '/agent/notify', { title: 'x' }, { 'x-agent-token': 'f'.repeat(48) })).rejects.toBeInstanceOf(TeamAuthError);
    expect(notifier.notifications().notifications).toHaveLength(0);
  });

  it('rate limits a chatty agent and validates its message', async () => {
    const { notifier } = makeNotifier({ agentRatePerMinute: 1 });
    notifier.setEndpoint('http://127.0.0.1:1');
    const token = notifier.contribute({ notifyChannelIds: [INBOX_CHANNEL_ID] }, launch).env![NOTIFY_TOKEN_ENV];
    const routes = notifyAgentRoutes(fakeTower(notifier));
    const headers = { 'x-agent-token': token };
    await expect(call(routes, 'POST', '/agent/notify', {}, headers)).rejects.toThrow(/title/);
    await call(routes, 'POST', '/agent/notify', { title: 'one' }, headers);
    await expect(call(routes, 'POST', '/agent/notify', { title: 'two' }, headers)).rejects.toThrow(/too many/);
    expect(notifier.notifications().notifications[0].source).toBe('agent:Scout');
  });
});

describe('operator routes', () => {
  it('wires CRUD, test, inbox and manual send', async () => {
    const { notifier } = makeNotifier();
    const routes = notifyRoutes(fakeTower(notifier));
    const created = await call(routes, 'POST', '/api/library/notify', { kind: 'slack', label: 'S', secrets: { webhookUrl: SLACK_URL } }) as { channel: { id: string } };
    const id = created.channel.id;
    expect(await call(routes, 'POST', `/api/library/notify/${id}`, { label: 'T' })).toMatchObject({ ok: true, channel: { label: 'T' } });
    expect(await call(routes, 'POST', `/api/library/notify/${id}/test`)).toEqual({ result: { channelId: id, ok: true } });
    expect(await call(routes, 'POST', '/api/notifications/send', { channelIds: [], title: 'Hi' })).toEqual({ results: [] });
    expect(await call(routes, 'GET', '/api/notifications?limit=1')).toMatchObject({ unread: 2, notifications: [{ title: 'Hi' }] });
    expect(await call(routes, 'POST', '/api/notifications/read', { all: true })).toEqual({ ok: true, changed: 2 });
    expect(await call(routes, 'POST', `/api/library/notify/${id}/delete`, { confirm: true })).toEqual({ ok: true });
    expect(await call(routes, 'GET', '/api/library/notify')).toMatchObject({ channels: [{ id: INBOX_CHANNEL_ID }] });
  });
});

describe('notify-mcp.mjs bridge', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it('lists the notify tool and forwards calls with the agent token', async () => {
    const { notifier } = makeNotifier();
    const routes = notifyAgentRoutes(fakeTower(notifier));
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        call(routes, req.method ?? '', req.url ?? '', JSON.parse(raw || '{}'), req.headers as Record<string, string>)
          .then((data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); })
          .catch((error: Error) => { res.writeHead(error instanceof TeamAuthError ? 401 : 400); res.end(JSON.stringify({ error: error.message })); });
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    notifier.setEndpoint(url);
    const token = notifier.contribute({ notifyChannelIds: [INBOX_CHANNEL_ID] }, launch).env![NOTIFY_TOKEN_ENV];

    const answers = await runBridge({ [NOTIFY_URL_ENV]: url, [NOTIFY_TOKEN_ENV]: token }, [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'notify', arguments: { title: 'From bridge', body: 'hello' } } },
      { id: 4, method: 'tools/call', params: { name: 'other' } },
      { id: 5, method: 'nope' },
    ]);

    expect(answers.get(1)).toMatchObject({ result: { serverInfo: { name: 'waystation-notify' } } });
    expect(answers.get(2)).toMatchObject({ result: { tools: [{ name: 'notify' }] } });
    expect(answers.get(3)).toMatchObject({ result: { isError: false, content: [{ text: 'Sent.' }] } });
    expect(answers.get(4)).toMatchObject({ result: { isError: true } });
    expect(answers.get(5)).toMatchObject({ error: { code: -32601 } });
    expect(notifier.notifications().notifications[0]).toMatchObject({ title: 'From bridge', source: 'agent:Scout' });

    const denied = await runBridge({ [NOTIFY_URL_ENV]: url, [NOTIFY_TOKEN_ENV]: 'bad' }, [
      { id: 1, method: 'tools/call', params: { name: 'notify', arguments: { title: 'x' } } },
    ]);
    expect(denied.get(1)).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining('invalid agent token') }] } });
  });
});

async function runBridge(env: Record<string, string>, requests: readonly object[]): Promise<Map<number, Record<string, unknown>>> {
  const child = spawn(process.execPath, [NOTIFY_MCP_SCRIPT], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const expected = requests.filter((request) => 'id' in request).length;
  const answers = new Map<number, Record<string, unknown>>();
  const done = new Promise<void>((resolve) => {
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.id === null) return;
      answers.set(Number(message.id), message);
      if (answers.size === expected) resolve();
    });
  });
  child.stdin.write('not json\n');
  requests.forEach((request) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...request })}\n`));
  await done;
  child.kill();
  return answers;
}
