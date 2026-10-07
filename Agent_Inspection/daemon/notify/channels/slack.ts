import { LibraryInputError } from '../../library/types.ts';
import { clip, postJson, requireHttpUrl } from './http.ts';
import type { ChannelSpec, CleanMessage } from './types.ts';

const LEVEL_EMOJI: Readonly<Record<CleanMessage['level'], string>> = {
  info: ':information_source:', success: ':white_check_mark:', warning: ':warning:', error: ':x:',
};

/** Slack treats &, < and > as control characters (mentions, links). */
const escapeSlack = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackPayload(message: CleanMessage): unknown {
  const title = escapeSlack(message.title);
  const body = escapeSlack(message.body);
  return {
    text: clip(`${title}\n${body}`, 3000),
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: clip(message.title, 150), emoji: true } },
      ...(body ? [{ type: 'section', text: { type: 'mrkdwn', text: clip(body, 2900) } }] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: clip(`${LEVEL_EMOJI[message.level]} ${message.level} · ${escapeSlack(message.source)}`, 300) }] },
    ],
  };
}

export const slack: ChannelSpec = {
  kind: 'slack',
  configKeys: [],
  requiredConfig: [],
  secretNames: ['webhookUrl'],
  requiredSecrets: ['webhookUrl'],
  validate: (_config, secrets) => {
    const url = requireHttpUrl(secrets.webhookUrl, 'Slack webhook URL', true);
    if (url.hostname !== 'hooks.slack.com') throw new LibraryInputError('Slack webhook URL must start with https://hooks.slack.com/');
  },
  deliver: (ctx) => postJson(ctx, ctx.secret('webhookUrl') ?? '', slackPayload(ctx.message)),
};
