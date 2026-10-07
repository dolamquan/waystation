import { LibraryInputError } from '../../library/types.ts';
import { clip, postJson, requireHttpUrl } from './http.ts';
import type { ChannelSpec, CleanMessage } from './types.ts';

export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';
const TOPIC = /^[A-Za-z0-9_-]{1,64}$/;
const PRIORITY: Readonly<Record<CleanMessage['level'], number>> = { info: 3, success: 3, warning: 4, error: 5 };
const TAGS: Readonly<Record<CleanMessage['level'], string>> = {
  info: 'information_source', success: 'white_check_mark', warning: 'warning', error: 'x',
};

const serverOf = (config: Readonly<Record<string, string>>): string => (config.server || DEFAULT_NTFY_SERVER).replace(/\/+$/, '');

/** JSON publishing (POST to the server root) keeps non-ASCII titles out of HTTP headers. */
export function ntfyPayload(topic: string, message: CleanMessage): unknown {
  return {
    topic,
    title: clip(message.title, 200),
    message: clip(message.body || message.title, 4000),
    priority: PRIORITY[message.level],
    tags: [TAGS[message.level]],
  };
}

export const ntfy: ChannelSpec = {
  kind: 'ntfy',
  configKeys: ['server', 'topic'],
  requiredConfig: ['topic'],
  secretNames: ['token'],
  requiredSecrets: [],
  validate: (config, secrets) => {
    requireHttpUrl(serverOf(config), 'ntfy server');
    if (!TOPIC.test(config.topic ?? '')) throw new LibraryInputError('ntfy topic: 1-64 letters, digits, - or _');
    if (secrets.token !== undefined && !/^[\x21-\x7e]+$/.test(secrets.token)) throw new LibraryInputError('ntfy token must be printable ASCII without spaces');
  },
  deliver: (ctx) => {
    const token = ctx.secret('token');
    return postJson(ctx, `${serverOf(ctx.config)}/`, ntfyPayload(ctx.config.topic, ctx.message), token ? { authorization: `Bearer ${token}` } : {});
  },
};
