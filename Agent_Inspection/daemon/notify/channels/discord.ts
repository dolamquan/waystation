import { LibraryInputError } from '../../library/types.ts';
import { clip, postJson, requireHttpUrl } from './http.ts';
import type { ChannelSpec, CleanMessage } from './types.ts';

const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);
const LEVEL_COLOR: Readonly<Record<CleanMessage['level'], number>> = {
  info: 0x3b82f6, success: 0x22c55e, warning: 0xf59e0b, error: 0xef4444,
};
/** Embed limits: title 256, description 4096, footer 2048, 6000 in total. Kept well under. */
const TITLE_MAX = 250;
const DESCRIPTION_MAX = 4000;
const FOOTER_MAX = 200;

export function discordPayload(message: CleanMessage): unknown {
  return {
    embeds: [{
      title: clip(message.title, TITLE_MAX),
      description: clip(message.body, DESCRIPTION_MAX),
      color: LEVEL_COLOR[message.level],
      footer: { text: clip(`${message.level} · ${message.source}`, FOOTER_MAX) },
      timestamp: new Date(message.ts).toISOString(),
    }],
    // Agent-written text must never ping @everyone or a role.
    allowed_mentions: { parse: [] },
  };
}

export const discord: ChannelSpec = {
  kind: 'discord',
  configKeys: [],
  requiredConfig: [],
  secretNames: ['webhookUrl'],
  requiredSecrets: ['webhookUrl'],
  validate: (_config, secrets) => {
    const url = requireHttpUrl(secrets.webhookUrl, 'Discord webhook URL', true);
    if (!DISCORD_HOSTS.has(url.hostname) || !url.pathname.startsWith('/api/webhooks/')) {
      throw new LibraryInputError('Discord webhook URL must look like https://discord.com/api/webhooks/…');
    }
  },
  deliver: (ctx) => postJson(ctx, ctx.secret('webhookUrl') ?? '', discordPayload(ctx.message)),
};
