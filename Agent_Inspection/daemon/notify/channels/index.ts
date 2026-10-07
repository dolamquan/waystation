import { desktop } from './desktop.ts';
import { discord } from './discord.ts';
import { email } from './email.ts';
import { ntfy } from './ntfy.ts';
import { slack } from './slack.ts';
import type { ChannelSpec, ExternalKind } from './types.ts';
import { webhook } from './webhook.ts';

export const CHANNEL_SPECS: Readonly<Record<ExternalKind, ChannelSpec>> = { slack, discord, email, webhook, ntfy, desktop };

export const isExternalKind = (kind: unknown): kind is ExternalKind =>
  typeof kind === 'string' && Object.hasOwn(CHANNEL_SPECS, kind);
