import { describe, expect, it, vi } from 'vitest';
import { MAX_WAKES_PER_WINDOW } from '../daemon/channels/board.ts';
import { ChannelManager, type ChannelHost } from '../daemon/channels/channelManager.ts';
import type { Agent } from '../daemon/domain/types.ts';
import { TowerStore } from '../daemon/store/db.ts';
import { makeAgent } from './helpers.ts';

const CLI = 'C:\\tower\\ws-channel.mjs';
const UI = makeAgent({ id: 'claude:ui', name: 'UI work', vendor: 'claude', pid: 100, status: 'busy' });
const API = makeAgent({ id: 'codex:api', name: 'API work', vendor: 'codex', pid: 200, status: 'idle' });
const DOCS = makeAgent({ id: 'managed:docs', name: 'Docs', vendor: 'gemini', pid: undefined, status: 'idle' });

const setup = (agents: Agent[] = [UI, API, DOCS], store = new TowerStore(':memory:')) => {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const instruct = vi.fn(async (_agentId: string, _text: string) => 'Sent.');
  const host: ChannelHost = {
    agent: (id) => byId.get(id),
    agents: () => agents,
    processes: async () => [],
    instruct,
    audit: () => undefined,
  };
  let now = 1_761_200_000_000;
  const manager = new ChannelManager(host, store, { cliScript: CLI, now: () => now });
  return { manager, instruct, store, host, advance: (ms: number) => { now += ms; } };
};

const as = (agentId: string, extra: Record<string, unknown> = {}) => ({ caller: { agentId }, ...extra });

/** A channel with ui and api as members, join notices already sent. */
async function withChannel() {
  const ctx = setup();
  const channel = ctx.manager.create({ name: 'Frontend', purpose: 'agree the users API' });
  await ctx.manager.addMember(channel.id, { agentId: UI.id, name: 'ui' });
  await ctx.manager.addMember(channel.id, { agentId: API.id, name: 'api' });
  ctx.instruct.mockClear();
  return { ...ctx, channel };
}

describe('operator actions', () => {
  it('creates, lists and persists channels', () => {
    const { manager, store } = setup();
    const created = manager.create({ name: 'Frontend', purpose: 'x' });
    expect(manager.list().map((c) => c.name)).toEqual(['frontend']);
    const reloaded = setup([UI, API], store).manager;
    expect(reloaded.list().map((c) => c.id)).toEqual([created.id]);
  });

  it('adds a running session and tells it how to use the channel', async () => {
    const { manager, instruct } = setup();
    const channel = manager.create({ name: 'Frontend', purpose: 'agree the users API' });
    await manager.addMember(channel.id, { agentId: API.id });
    const result = await manager.addMember(channel.id, { agentId: UI.id });
    expect(result.member.name).toBe('ui-work');
    const [agentId, text] = instruct.mock.calls[1];
    expect(agentId).toBe(UI.id);
    expect(text).toContain('#frontend');
    expect(text).toContain('agree the users API');
    expect(text).toContain('api-work (codex)');
    expect(text).toContain('node "C:/tower/ws-channel.mjs"');
  });

  it('refuses unknown sessions', async () => {
    const { manager } = setup();
    const channel = manager.create({ name: 'Frontend', purpose: '' });
    await expect(manager.addMember(channel.id, { agentId: 'claude:nope' })).rejects.toThrow(/not running/);
  });

  it('shows members with their live status in the view', async () => {
    const { manager, channel } = await withChannel();
    const view = manager.list().find((c) => c.id === channel.id)!;
    expect(view.members.map((m) => [m.name, m.status, m.agentName])).toEqual([['ui', 'busy', 'UI work'], ['api', 'idle', 'API work']]);
  });
});

describe('agent messaging', () => {
  it('wakes the recipient with a framed message and marks it delivered', async () => {
    const { manager, instruct } = await withChannel();
    const sent = await manager.send(as(UI.id, { to: 'api', text: 'What does GET /users return?' }));
    expect(sent.deliveries).toEqual([{ to: 'api', via: 'woken', note: 'Sent.' }]);
    const [agentId, text] = instruct.mock.calls[0];
    expect(agentId).toBe(API.id);
    expect(text).toContain('from ui');
    expect(text).toContain('What does GET /users return?');
    expect(text).toContain('not from your operator');
    expect(text).toContain(`--reply-to ${sent.message.id}`);
    expect((await manager.inbox(as(API.id))).messages).toEqual([]);
  });

  it('leaves mail in the inbox when asked not to wake', async () => {
    const { manager, instruct } = await withChannel();
    const sent = await manager.send(as(UI.id, { to: 'api', text: 'fyi', wake: false }));
    expect(sent.deliveries).toEqual([{ to: 'api', via: 'inbox' }]);
    expect(instruct).not.toHaveBeenCalled();
    const inbox = await manager.inbox(as(API.id));
    expect(inbox.messages.map((m) => [m.from, m.text])).toEqual([['ui', 'fyi']]);
    expect((await manager.inbox(as(API.id))).messages).toEqual([]);
  });

  it('keeps the message unread when the session cannot be woken', async () => {
    const { manager, instruct } = await withChannel();
    instruct.mockRejectedValueOnce(new Error('This agent is observe-only'));
    const sent = await manager.send(as(UI.id, { to: 'api', text: 'ping' }));
    expect(sent.deliveries).toEqual([{ to: 'api', via: 'inbox', note: 'This agent is observe-only' }]);
    expect((await manager.inbox(as(API.id))).messages.map((m) => m.text)).toEqual(['ping']);
  });

  it('broadcasts to every other member', async () => {
    const { manager, channel, instruct } = await withChannel();
    await manager.addMember(channel.id, { agentId: DOCS.id, name: 'docs' });
    instruct.mockClear();
    const sent = await manager.send(as(UI.id, { to: 'all', text: 'schema changed' }));
    expect(sent.deliveries.map((d) => d.to)).toEqual(['api', 'docs']);
    expect(instruct.mock.calls.map(([id]) => id)).toEqual([API.id, DOCS.id]);
  });

  it('only lets members talk, and only to members', async () => {
    const { manager } = await withChannel();
    await expect(manager.send(as(DOCS.id, { to: 'api', text: 'hi' }))).rejects.toThrow(/not a member of any channel/);
    await expect(manager.send(as(UI.id, { to: 'docs', text: 'hi' }))).rejects.toThrow(/No member named "docs"/);
  });

  it('asks which channel when the session is in several', async () => {
    const { manager } = await withChannel();
    const second = manager.create({ name: 'Backend', purpose: '' });
    await manager.addMember(second.id, { agentId: UI.id, name: 'ui' });
    await manager.addMember(second.id, { agentId: DOCS.id, name: 'docs' });
    await expect(manager.send(as(UI.id, { to: 'docs', text: 'hi' }))).rejects.toThrow(/#frontend, #backend.*--channel/);
    const sent = await manager.send(as(UI.id, { channel: 'backend', to: 'docs', text: 'hi' }));
    expect(sent.channel).toBe('backend');
    await expect(manager.send(as(API.id, { channel: 'backend', to: 'docs', text: 'hi' }))).rejects.toThrow(/not a member of #backend/);
  });

  it('describes the caller and its peers', async () => {
    const { manager } = await withChannel();
    const me = await manager.whoami(as(UI.id));
    expect(me.channels).toEqual([{ id: expect.any(String), name: 'frontend', purpose: 'agree the users API', you: 'ui', peers: [{ name: 'api', vendor: 'codex', status: 'idle' }] }]);
  });

  it('stops waking once the loop guard is spent', async () => {
    const { manager, instruct } = await withChannel();
    for (let i = 0; i < MAX_WAKES_PER_WINDOW; i++) await manager.send(as(UI.id, { to: 'api', text: `m${i}` }));
    const sent = await manager.send(as(UI.id, { to: 'api', text: 'one more' }));
    expect(sent.deliveries[0]).toMatchObject({ via: 'inbox', note: expect.stringMatching(/wake-up limit/) });
    expect(instruct).toHaveBeenCalledTimes(MAX_WAKES_PER_WINDOW);
  });

  it('posts operator messages with the same delivery', async () => {
    const { manager, channel, instruct } = await withChannel();
    const deliveries = await manager.postAsOperator(channel.id, { to: 'all', text: 'wrap up' });
    expect(deliveries.map((d) => d.to)).toEqual(['ui', 'api']);
    expect(instruct.mock.calls[0][1]).toContain('from operator');
  });
});

describe('wait', () => {
  it('returns unread mail at once', async () => {
    const { manager } = await withChannel();
    await manager.send(as(UI.id, { to: 'api', text: 'early', wake: false }));
    const waited = await manager.wait(as(API.id, { timeoutSeconds: 5 }));
    expect(waited.messages.map((m) => m.text)).toEqual(['early']);
  });

  it('hands a new message to a waiting member instead of waking it', async () => {
    const { manager, instruct } = await withChannel();
    const waiting = manager.wait(as(UI.id, { from: 'api', timeoutSeconds: 30 }));
    const sent = await manager.send(as(API.id, { to: 'ui', text: '{ id, name }' }));
    expect(sent.deliveries).toEqual([{ to: 'ui', via: 'waiting' }]);
    expect((await waiting).messages.map((m) => m.text)).toEqual(['{ id, name }']);
    expect(instruct).not.toHaveBeenCalled();
  });

  it('times out with nothing', async () => {
    vi.useFakeTimers();
    try {
      const { manager } = await withChannel();
      const waiting = manager.wait(as(UI.id, { timeoutSeconds: 2 }));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await waiting).toMatchObject({ messages: [], timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends when the caller goes away or is removed', async () => {
    const { manager, channel } = await withChannel();
    const abort = new AbortController();
    const first = manager.wait(as(UI.id, { timeoutSeconds: 30 }), abort.signal);
    abort.abort();
    expect((await first).messages).toEqual([]);
    const second = manager.wait(as(UI.id, { timeoutSeconds: 30 }));
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the wait register
    manager.removeMember(channel.id, 'ui');
    expect(await second).toMatchObject({ messages: [], removed: true });
  });
});
