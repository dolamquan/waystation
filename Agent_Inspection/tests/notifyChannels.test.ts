import { describe, expect, it } from 'vitest';
import { INBOX_CHANNEL_ID } from '../daemon/library/types.ts';
import { DISCORD_URL, SLACK_URL, makeNotifier } from './notifyHelpers.ts';

const gmail = {
  kind: 'email', label: 'My Gmail',
  config: { smtpHost: 'smtp.gmail.com', smtpPort: '465', secure: 'true', from: 'me@gmail.com', to: 'me@gmail.com, you@example.com', username: 'me@gmail.com' },
  secrets: { password: 'abcd efgh ijkl mnop' },
};

describe('notification channels', () => {
  it('always lists the Updates inbox first', () => {
    const { notifier } = makeNotifier();
    notifier.createChannel({ kind: 'slack', label: 'Team', secrets: { webhookUrl: SLACK_URL } });
    const channels = notifier.listChannels();
    expect(channels[0]).toMatchObject({ id: INBOX_CHANNEL_ID, kind: 'inbox', enabled: true });
    expect(channels.map((c) => c.kind)).toEqual(['inbox', 'slack']);
  });

  it('creates each kind and never returns secret values', () => {
    const { notifier, deps } = makeNotifier();
    const inputs = [
      { kind: 'slack', label: 'Slack', secrets: { webhookUrl: SLACK_URL } },
      { kind: 'discord', label: 'Discord', secrets: { webhookUrl: DISCORD_URL } },
      gmail,
      { kind: 'webhook', label: 'Hook', secrets: { url: 'https://example.test/hook', authorization: 'Bearer hook-secret-1' } },
      { kind: 'ntfy', label: 'Phone', config: { topic: 'waystation-x7f9' }, secrets: { token: 'tk_ntfysecret' } },
      { kind: 'desktop', label: 'This PC' },
    ];
    const views = inputs.map((input) => notifier.createChannel(input));
    expect(views.map((v) => v.id)).toEqual(expect.arrayContaining([expect.stringMatching(/^nch_[0-9a-f]{8}$/)]));
    expect(views[2].secretNames).toEqual(['password']);
    expect(views[3].secretNames).toEqual(['authorization', 'url']);
    const shown = JSON.stringify(notifier.listChannels()) + JSON.stringify(deps.audit.mock.calls);
    ['SuperSecret', 'abcd efgh', 'hook-secret-1', 'tk_ntfysecret'].forEach((secret) => expect(shown).not.toContain(secret));
    expect(deps.secrets.get(`notify:${views[0].id}:webhookUrl`)).toBe(SLACK_URL);
  });

  it.each([
    [{ kind: 'inbox', label: 'x' }, /cannot be added/],
    [{ kind: 'pager', label: 'x' }, /kind must be/],
    [{ kind: 'slack', label: '' }, /label/],
    [{ kind: 'slack', label: 'x'.repeat(61), secrets: { webhookUrl: SLACK_URL } }, /label/],
    [{ kind: 'slack', label: 'Slack' }, /missing secret: webhookUrl/],
    [{ kind: 'slack', label: 'Slack', secrets: { webhookUrl: 'https://evil.test/hook' } }, /hooks\.slack\.com/],
    [{ kind: 'slack', label: 'Slack', secrets: { webhookUrl: 'http://hooks.slack.com/x' } }, /https/],
    [{ kind: 'discord', label: 'D', secrets: { webhookUrl: 'https://discord.com/channels/1' } }, /api\/webhooks/],
    [{ kind: 'webhook', label: 'W', secrets: { url: 'ftp://x.test' } }, /http/],
    [{ kind: 'webhook', label: 'W', secrets: { url: 'https://u:p@x.test' } }, /user name/],
    [{ kind: 'webhook', label: 'W', secrets: { url: 'https://x.test', authorization: 'a\nb' } }, /single line/],
    [{ kind: 'webhook', label: 'W', secrets: { url: 'not a url' } }, /valid URL/],
    [{ kind: 'ntfy', label: 'N', config: { topic: 'bad topic!' } }, /topic/],
    [{ kind: 'ntfy', label: 'N', config: { topic: 't', server: 'file:///x' } }, /server/],
    [{ kind: 'ntfy', label: 'N', config: { topic: 't' }, secrets: { token: 'has space' } }, /token/],
    [{ kind: 'ntfy', label: 'N' }, /missing setting: topic/],
    [{ kind: 'ntfy', label: 'N', config: { topic: 't', other: 'x' } }, /unknown setting/],
    [{ kind: 'ntfy', label: 'N', config: { topic: 'x'.repeat(501) } }, /longer than 500/],
    [{ kind: 'ntfy', label: 'N', config: { topic: 5 } }, /must be text/],
    [{ kind: 'ntfy', label: 'N', config: 'topic' }, /must be an object/],
    [{ kind: 'slack', label: 'S', secrets: { other: 'x' } }, /unknown secret/],
    [{ kind: 'slack', label: 'S', enabled: 'yes', secrets: { webhookUrl: SLACK_URL } }, /enabled/],
    [{ ...gmail, config: { ...gmail.config, smtpHost: 'bad host' } }, /SMTP host/],
    [{ ...gmail, config: { ...gmail.config, smtpPort: '99999' } }, /port/],
    [{ ...gmail, config: { ...gmail.config, secure: 'yes' } }, /secure/],
    [{ ...gmail, config: { ...gmail.config, from: 'nobody' } }, /From/],
    [{ ...gmail, config: { ...gmail.config, to: 'a@b.c, nope' } }, /To/],
    [{ ...gmail, secrets: {} }, /password is required/],
  ])('rejects invalid input %#', (input, message) => {
    const { notifier } = makeNotifier();
    expect(() => notifier.createChannel(input)).toThrow(message);
  });

  it('updates labels, config and secrets: "" deletes, omitted keeps', () => {
    const { notifier, deps } = makeNotifier();
    const hook = notifier.createChannel({ kind: 'webhook', label: 'Hook', secrets: { url: 'https://x.test', authorization: 'Bearer a' } });
    const kept = notifier.updateChannel(hook.id, { label: 'Renamed', enabled: false });
    expect(kept).toMatchObject({ label: 'Renamed', enabled: false, secretNames: ['authorization', 'url'] });
    const dropped = notifier.updateChannel(hook.id, { secrets: { authorization: '' } });
    expect(dropped.secretNames).toEqual(['url']);
    expect(() => notifier.updateChannel(hook.id, { secrets: { url: '' } })).toThrow(/missing secret: url/);
    expect(() => notifier.updateChannel(hook.id, { kind: 'slack' })).toThrow(/kind cannot change/);
    expect(() => notifier.updateChannel('nch_nope', {})).toThrow(/unknown notification channel/);
    expect(() => notifier.updateChannel(INBOX_CHANNEL_ID, {})).toThrow(/cannot be changed/);
    const topic = notifier.createChannel({ kind: 'ntfy', label: 'N', config: { topic: 'a' } });
    expect(notifier.updateChannel(topic.id, { config: { topic: 'b', server: 'https://ntfy.example' } }).config).toEqual({ topic: 'b', server: 'https://ntfy.example' });
    expect(deps.audit).toHaveBeenCalledWith('notify_channel_update', hook.id, expect.anything());
  });

  it('deletes a channel and its secrets only when confirmed; the inbox cannot be deleted', () => {
    const { notifier, deps } = makeNotifier();
    const slack = notifier.createChannel({ kind: 'slack', label: 'S', secrets: { webhookUrl: SLACK_URL } });
    expect(() => notifier.deleteChannel(slack.id, {})).toThrow(/confirm/);
    expect(() => notifier.deleteChannel(INBOX_CHANNEL_ID, { confirm: true })).toThrow(/cannot be deleted/);
    notifier.deleteChannel(slack.id, { confirm: true });
    expect(notifier.listChannels()).toHaveLength(1);
    expect(deps.secrets.namesUnder(`notify:${slack.id}:`)).toEqual([]);
    expect(() => notifier.deleteChannel(slack.id, { confirm: true })).toThrow(/unknown/);
  });
});
