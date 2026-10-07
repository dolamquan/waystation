import { describe, expect, it, vi } from 'vitest';
import { INBOX_CHANNEL_ID, type NotificationEntry, type NotifyMessage } from '../daemon/library/types.ts';
import { scrubError } from '../daemon/notify/delivery.ts';
import { DISCORD_URL, SLACK_URL, fetchBody, makeNotifier } from './notifyHelpers.ts';

describe('Notifier.send', () => {
  it('records to the inbox, emits, and delivers to Slack', async () => {
    const { notifier, fetch, clock } = makeNotifier();
    const slack = notifier.createChannel({ kind: 'slack', label: 'S', secrets: { webhookUrl: SLACK_URL } });
    const emitted: NotificationEntry[] = [];
    notifier.on('notification', (entry: NotificationEntry) => emitted.push(entry));

    const results = await notifier.send([slack.id, INBOX_CHANNEL_ID], { title: 'Nightly <sync> done', body: 'All good & green', level: 'success', source: 'schedule:Nightly' });

    expect(results).toEqual([{ channelId: slack.id, ok: true }, { channelId: INBOX_CHANNEL_ID, ok: true }]);
    expect(emitted[0]).toMatchObject({ id: expect.stringMatching(/^ntf_[0-9a-f]{8}$/), title: 'Nightly <sync> done', read: false, ts: clock.now });
    expect(fetch.mock.calls[0][0]).toBe(SLACK_URL);
    const payload = fetchBody(fetch);
    expect(String(payload.text)).toContain('Nightly &lt;sync&gt; done');
    expect(JSON.stringify(payload.blocks)).toContain('All good &amp; green');
    const { notifications, unread } = notifier.notifications();
    expect(unread).toBe(1);
    expect(notifications[0].deliveries).toEqual([{ channelId: slack.id, ok: true }]);
    expect(notifier.listChannels().find((c) => c.id === slack.id)?.lastSentAt).toBe(clock.now);
  });

  it('formats Discord, webhook and ntfy payloads', async () => {
    const { notifier, fetch } = makeNotifier();
    const ids = [
      notifier.createChannel({ kind: 'discord', label: 'D', secrets: { webhookUrl: DISCORD_URL } }).id,
      notifier.createChannel({ kind: 'webhook', label: 'W', secrets: { url: 'https://example.test/in', authorization: 'Bearer abc123' } }).id,
      notifier.createChannel({ kind: 'ntfy', label: 'N', config: { topic: 'ws-topic', server: 'https://ntfy.example/' }, secrets: { token: 'tk_123456' } }).id,
    ];
    await notifier.send(ids, { title: 'T'.repeat(300), body: 'B'.repeat(9000), level: 'error' });
    const byUrl = new Map(fetch.mock.calls.map((call, index) => [String(call[0]), { init: call[1] as RequestInit, body: fetchBody(fetch, index) }]));

    const discord = byUrl.get(DISCORD_URL)!.body as { embeds: Array<{ title: string; description: string }>; allowed_mentions: unknown };
    expect(discord.embeds[0].title.length).toBeLessThanOrEqual(256);
    expect(discord.embeds[0].description.length).toBeLessThanOrEqual(4096);
    expect(discord.allowed_mentions).toEqual({ parse: [] });

    const hook = byUrl.get('https://example.test/in')!;
    expect(hook.body).toMatchObject({ level: 'error', source: 'waystation' });
    expect(String(hook.body.title).length).toBe(200);
    expect(String(hook.body.body).length).toBe(8000);
    expect((hook.init.headers as Record<string, string>).authorization).toBe('Bearer abc123');

    const ntfy = byUrl.get('https://ntfy.example/')!;
    expect(ntfy.body).toMatchObject({ topic: 'ws-topic', priority: 5 });
    expect((ntfy.init.headers as Record<string, string>).authorization).toBe('Bearer tk_123456');
  });

  it('sends email through the mail transport', async () => {
    const { notifier, sendMail } = makeNotifier();
    const mail = notifier.createChannel({
      kind: 'email', label: 'Gmail',
      config: { smtpHost: 'smtp.gmail.com', smtpPort: '465', secure: 'true', from: 'me@gmail.com', to: 'a@x.test, b@x.test', username: 'me@gmail.com' },
      secrets: { password: 'app-password' },
    });
    const [result] = await notifier.send([mail.id], { title: 'Line\r\nBreak', body: 'Hi' });
    expect(result.ok).toBe(true);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.gmail.com', port: 465, secure: true, user: 'me@gmail.com', pass: 'app-password' }),
      expect.objectContaining({ from: 'me@gmail.com', to: ['a@x.test', 'b@x.test'], subject: '[WayStation] Line Break' }),
    );
  });

  it('shows a desktop toast', async () => {
    const { notifier, showToast } = makeNotifier();
    const desktop = notifier.createChannel({ kind: 'desktop', label: 'PC' });
    await notifier.send([desktop.id], { title: 'Done', body: 'Body' });
    expect(showToast).toHaveBeenCalledWith('Done', 'Body', expect.any(AbortSignal));
  });

  it('never throws: failures, unknown and paused channels become results; secrets are scrubbed', async () => {
    const { notifier, fetch } = makeNotifier();
    const slack = notifier.createChannel({ kind: 'slack', label: 'S', secrets: { webhookUrl: SLACK_URL } });
    const paused = notifier.createChannel({ kind: 'discord', label: 'D', enabled: false, secrets: { webhookUrl: DISCORD_URL } });
    fetch.mockRejectedValueOnce(new Error(`connect failed for ${SLACK_URL}`, { cause: new Error('ECONNREFUSED') }));

    const results = await notifier.send([slack.id, paused.id, 'nch_gone'], { title: 'x', body: 'y' });

    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0].error).toContain('connect failed for [redacted]');
    expect(results[0].error).toContain('ECONNREFUSED');
    expect(results[0].error).not.toContain('SuperSecret');
    expect(results[1]).toEqual({ channelId: paused.id, ok: false, error: 'channel is paused' });
    expect(results[2]).toEqual({ channelId: 'nch_gone', ok: false, error: 'unknown channel' });
    expect(notifier.listChannels().find((c) => c.id === slack.id)?.lastError).toBe(results[0].error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports HTTP errors with a short reason', async () => {
    const { notifier, fetch } = makeNotifier();
    const slack = notifier.createChannel({ kind: 'slack', label: 'S', secrets: { webhookUrl: SLACK_URL } });
    fetch.mockResolvedValueOnce(new Response('invalid_token', { status: 403 }));
    const [result] = await notifier.send([slack.id], { title: 'x', body: '' });
    expect(result).toEqual({ channelId: slack.id, ok: false, error: 'HTTP 403: invalid_token' });
    fetch.mockResolvedValueOnce(new Response('', { status: 200 }));
    await notifier.send([slack.id], { title: 'x', body: '' });
    expect(notifier.listChannels()[1].lastError).toBeUndefined();
  });

  it('times out a hung channel and aborts it', async () => {
    const { notifier, fetch } = makeNotifier({ timeoutMs: 20 });
    const slack = notifier.createChannel({ kind: 'slack', label: 'S', secrets: { webhookUrl: SLACK_URL } });
    let signal: AbortSignal | undefined;
    fetch.mockImplementationOnce((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise(() => undefined);
    });
    const [result] = await notifier.send([slack.id], { title: 'x', body: '' });
    expect(result).toEqual({ channelId: slack.id, ok: false, error: 'timed out after 0s' });
    expect(signal?.aborted).toBe(true);
  });

  it('rate limits each channel per minute', async () => {
    const { notifier, fetch, clock } = makeNotifier({ channelRatePerMinute: 2 });
    const slack = notifier.createChannel({ kind: 'slack', label: 'S', secrets: { webhookUrl: SLACK_URL } });
    const send = () => notifier.send([slack.id], { title: 'x', body: '' });
    await send();
    await send();
    expect((await send())[0]).toMatchObject({ ok: false, error: expect.stringMatching(/rate limited/) });
    clock.now += 61_000;
    expect((await send())[0].ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(notifier.notifications().unread).toBe(4);
  });

  it('cleans malformed messages instead of throwing', async () => {
    const { notifier, clock } = makeNotifier();
    const results = await notifier.send(null as unknown as string[], { title: 42, body: undefined, level: 'loud' } as unknown as NotifyMessage);
    expect(results).toEqual([]);
    expect(notifier.notifications().notifications[0]).toMatchObject({ title: '42', body: '', level: 'info', source: 'waystation' });
    clock.now += 1;
    await notifier.send([], { title: '   ', body: '' });
    expect(notifier.notifications().notifications[0].title).toBe('Update');
  });

  it('returns failure results if the store breaks', async () => {
    const { notifier, deps } = makeNotifier();
    vi.spyOn(deps.store, 'saveRecord').mockImplementation(() => { throw new Error('disk full'); });
    expect(await notifier.send(['a'], { title: 'x', body: '' })).toEqual([{ channelId: 'a', ok: false, error: 'notification failed: disk full' }]);
  });
});

describe('inbox', () => {
  it('lists newest first with a limit and marks entries read', async () => {
    const { notifier, clock } = makeNotifier();
    for (const title of ['one', 'two', 'three']) {
      clock.now += 1000;
      await notifier.send([], { title, body: '' });
    }
    const listed = notifier.notifications('2');
    expect(listed.notifications.map((n) => n.title)).toEqual(['three', 'two']);
    expect(listed.unread).toBe(3);
    expect(notifier.markRead({ ids: [listed.notifications[0].id] })).toBe(1);
    expect(notifier.notifications().unread).toBe(2);
    expect(notifier.markRead({ all: true })).toBe(2);
    expect(notifier.notifications('nope').unread).toBe(0);
    expect(() => notifier.markRead({})).toThrow(/ids/);
    expect(() => notifier.markRead({ ids: [1] })).toThrow(/ids/);
    expect(notifier.listChannels()[0].lastSentAt).toBe(clock.now);
  });

  it('keeps at most 500 entries', async () => {
    const { notifier, deps } = makeNotifier();
    const prune = vi.spyOn(deps.store, 'pruneRecords');
    await notifier.send([], { title: 'x', body: '' });
    expect(prune).toHaveBeenCalledWith('notifications', 500);
  });
});

describe('test and manual send', () => {
  it('tests one channel, even when paused, and audits it', async () => {
    const { notifier, fetch, deps } = makeNotifier();
    const slack = notifier.createChannel({ kind: 'slack', label: 'Team', enabled: false, secrets: { webhookUrl: SLACK_URL } });
    expect(await notifier.test(slack.id)).toEqual({ channelId: slack.id, ok: true });
    expect(String(fetchBody(fetch).text)).toContain('Test from WayStation: Team');
    expect(await notifier.test(INBOX_CHANNEL_ID)).toEqual({ channelId: INBOX_CHANNEL_ID, ok: true });
    await expect(notifier.test('nch_nope')).rejects.toThrow(/unknown/);
    expect(deps.audit).toHaveBeenCalledWith('notify_channel_test', slack.id, {});
  });

  it('validates manual sends', async () => {
    const { notifier } = makeNotifier();
    expect(await notifier.sendManual({ channelIds: [INBOX_CHANNEL_ID], title: 'Hi', body: 'there', level: 'warning' })).toEqual([{ channelId: INBOX_CHANNEL_ID, ok: true }]);
    expect(notifier.notifications().notifications[0]).toMatchObject({ source: 'operator', level: 'warning' });
    await expect(notifier.sendManual({ channelIds: 'x', title: 'Hi' })).rejects.toThrow(/list/);
    await expect(notifier.sendManual({ channelIds: ['nch_x'], title: 'Hi' })).rejects.toThrow(/unknown/);
    await expect(notifier.sendManual({ title: '' })).rejects.toThrow(/title/);
    await expect(notifier.sendManual({ title: 'x', body: 3 })).rejects.toThrow(/body/);
    await expect(notifier.sendManual({ title: 'x', level: 'loud' })).rejects.toThrow(/level/);
  });
});

describe('scrubError', () => {
  it('removes secrets, encoded secrets and URL paths', () => {
    expect(scrubError('bad abc%2F123 and abc/123 at https://x.test/path?q=1', ['abc/123', 'no'])).toBe('bad [redacted] and [redacted] at https://x.test/…');
    expect(scrubError('', [])).toBe('delivery failed');
  });
});
