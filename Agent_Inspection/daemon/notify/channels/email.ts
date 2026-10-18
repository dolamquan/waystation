import { LibraryInputError } from '../../library/types.ts';
import { clip } from './http.ts';
import type { ChannelSpec, CleanMessage, MailMessage } from './types.ts';

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const MAX_RECIPIENTS = 10;
export const SMTP_TIMEOUT_MS = 15_000;

/** Gmail needs an App Password (Google account → Security → 2-Step Verification → App passwords). */
export const GMAIL_PRESET: Readonly<Record<string, string>> = { smtpHost: 'smtp.gmail.com', smtpPort: '465', secure: 'true' };

export const recipientsOf = (to: string | undefined): string[] =>
  (to ?? '').split(',').map((address) => address.trim()).filter(Boolean);

export function mailOf(config: Readonly<Record<string, string>>, message: CleanMessage): MailMessage {
  const subject = clip(`[WayStation] ${message.title}`.replace(/[\r\n]+/g, ' '), 200);
  const footer = `\n\n— ${message.level} · ${message.source} · ${new Date(message.ts).toLocaleString()}`;
  return { from: config.from, to: recipientsOf(config.to), subject, text: `${message.body}${footer}` };
}

function validateEmail(config: Readonly<Record<string, string>>): void {
  if (!HOST.test(config.smtpHost ?? '')) throw new LibraryInputError('SMTP host must be a host name, e.g. smtp.gmail.com');
  const port = Number(config.smtpPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new LibraryInputError('SMTP port must be a number from 1 to 65535');
  if (config.secure !== undefined && config.secure !== 'true' && config.secure !== 'false') throw new LibraryInputError('secure must be "true" or "false"');
  if (!EMAIL.test(config.from ?? '')) throw new LibraryInputError('"From" must be an email address');
  const to = recipientsOf(config.to);
  if (to.length === 0 || to.length > MAX_RECIPIENTS || !to.every((address) => EMAIL.test(address))) {
    throw new LibraryInputError(`"To" must be 1-${MAX_RECIPIENTS} email addresses separated by commas`);
  }
  if (config.username !== undefined && /[\r\n]/.test(config.username)) throw new LibraryInputError('username must be a single line');
}

export const email: ChannelSpec = {
  kind: 'email',
  configKeys: ['smtpHost', 'smtpPort', 'secure', 'from', 'to', 'username'],
  requiredConfig: ['smtpHost', 'smtpPort', 'from', 'to'],
  secretNames: ['password'],
  requiredSecrets: [],
  validate: (config, secrets) => {
    validateEmail(config);
    if (config.username && !secrets.password) throw new LibraryInputError('SMTP password is required when a username is set');
  },
  deliver: (ctx) => ctx.io.sendMail({
    host: ctx.config.smtpHost,
    port: Number(ctx.config.smtpPort),
    secure: ctx.config.secure === 'true',
    user: ctx.config.username || undefined,
    pass: ctx.secret('password'),
    timeoutMs: SMTP_TIMEOUT_MS,
  }, mailOf(ctx.config, ctx.message)),
};
