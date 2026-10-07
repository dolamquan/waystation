import { LibraryInputError } from '../../library/types.ts';
import { postJson, requireHttpUrl } from './http.ts';
import type { ChannelSpec, CleanMessage } from './types.ts';

export function webhookPayload(message: CleanMessage): unknown {
  return { title: message.title, body: message.body, level: message.level, source: message.source, ts: message.ts };
}

export const webhook: ChannelSpec = {
  kind: 'webhook',
  configKeys: [],
  requiredConfig: [],
  secretNames: ['url', 'authorization'],
  requiredSecrets: ['url'],
  validate: (_config, secrets) => {
    requireHttpUrl(secrets.url, 'Webhook URL');
    if (secrets.authorization !== undefined && /[\r\n]/.test(secrets.authorization)) {
      throw new LibraryInputError('Authorization header must be a single line');
    }
  },
  deliver: (ctx) => {
    const authorization = ctx.secret('authorization');
    return postJson(ctx, ctx.secret('url') ?? '', webhookPayload(ctx.message), authorization ? { authorization } : {});
  },
};
