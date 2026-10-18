import { request } from '../api.ts';
import type {
  NotificationEntry, NotifyChannelInput, NotifyChannelView, NotifyKind, NotifyLevel, NotifyResult,
} from '../../../daemon/library/types.ts';

export type { NotificationEntry, NotifyChannelInput, NotifyChannelView, NotifyKind, NotifyLevel, NotifyResult };
export { INBOX_CHANNEL_ID } from '../../../daemon/library/types.ts';

export type ChannelKind = Exclude<NotifyKind, 'inbox'>;

const enc = encodeURIComponent;

export const notifyApi = {
  channels: () => request<{ channels: NotifyChannelView[] }>('GET', '/api/library/notify'),
  create: (input: NotifyChannelInput) => request<{ ok: true; channel: NotifyChannelView }>('POST', '/api/library/notify', input),
  update: (id: string, input: Partial<NotifyChannelInput>) => request<{ ok: true; channel: NotifyChannelView }>('POST', `/api/library/notify/${enc(id)}`, input),
  remove: (id: string) => request<{ ok: true }>('POST', `/api/library/notify/${enc(id)}/delete`, { confirm: true }),
  test: (id: string) => request<{ result: NotifyResult }>('POST', `/api/library/notify/${enc(id)}/test`),
  notifications: (limit = 50) => request<{ notifications: NotificationEntry[]; unread: number }>('GET', `/api/notifications?limit=${limit}`),
  markRead: (body: { readonly ids?: readonly string[]; readonly all?: boolean }) => request<{ ok: true }>('POST', '/api/notifications/read', body),
};

export interface FieldSpec {
  readonly name: string;
  readonly label: string;
  readonly secret?: boolean;
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly type?: 'text' | 'email' | 'number' | 'select';
  readonly options?: readonly string[];
}

export interface KindSpec {
  readonly kind: ChannelKind;
  readonly label: string;
  readonly guide: string;
  readonly fields: readonly FieldSpec[];
  /** Starting config, e.g. the Gmail preset. */
  readonly defaults?: Readonly<Record<string, string>>;
}

export const KIND_SPECS: readonly KindSpec[] = [
  {
    kind: 'slack', label: 'Slack',
    guide: 'In Slack, create an app with an Incoming Webhook (api.slack.com/apps → Incoming Webhooks → Add New Webhook), pick the channel, and paste the https://hooks.slack.com/… URL.',
    fields: [{ name: 'webhookUrl', label: 'Webhook URL', secret: true, required: true, placeholder: 'https://hooks.slack.com/services/…' }],
  },
  {
    kind: 'discord', label: 'Discord',
    guide: 'In Discord: Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.',
    fields: [{ name: 'webhookUrl', label: 'Webhook URL', secret: true, required: true, placeholder: 'https://discord.com/api/webhooks/…' }],
  },
  {
    kind: 'email', label: 'Email (Gmail / SMTP)',
    guide: 'Gmail: turn on 2-Step Verification, then create an App Password (Google Account → Security → App passwords) and use it below — never your normal password. Other providers: use their SMTP settings.',
    defaults: { smtpHost: 'smtp.gmail.com', smtpPort: '465', secure: 'true' },
    fields: [
      { name: 'to', label: 'Send to (comma-separated)', required: true, type: 'text', placeholder: 'me@gmail.com' },
      { name: 'from', label: 'From address', required: true, type: 'email', placeholder: 'me@gmail.com' },
      { name: 'username', label: 'SMTP username', placeholder: 'me@gmail.com' },
      { name: 'password', label: 'SMTP / App Password', secret: true },
      { name: 'smtpHost', label: 'SMTP host', required: true },
      { name: 'smtpPort', label: 'SMTP port', required: true, type: 'number' },
      { name: 'secure', label: 'TLS from the start (port 465)', type: 'select', options: ['true', 'false'] },
    ],
  },
  {
    kind: 'ntfy', label: 'ntfy (phone push)',
    guide: 'Install the ntfy app and subscribe to a topic. Pick a long, hard-to-guess topic name: anyone who knows it can read your updates on ntfy.sh.',
    defaults: { server: 'https://ntfy.sh' },
    fields: [
      { name: 'topic', label: 'Topic', required: true, placeholder: 'waystation-7f3k9q2x' },
      { name: 'server', label: 'Server', placeholder: 'https://ntfy.sh' },
      { name: 'token', label: 'Access token (optional)', secret: true },
    ],
  },
  {
    kind: 'webhook', label: 'Webhook',
    guide: 'Any URL that accepts a POST with JSON { title, body, level, source, ts } — e.g. Zapier, n8n, Home Assistant.',
    fields: [
      { name: 'url', label: 'URL', secret: true, required: true, placeholder: 'https://…' },
      { name: 'authorization', label: 'Authorization header (optional)', secret: true, placeholder: 'Bearer …' },
    ],
  },
  {
    kind: 'desktop', label: 'Windows desktop',
    guide: 'Shows a Windows notification on this PC. Nothing to configure.',
    fields: [],
  },
];

export const kindSpec = (kind: string): KindSpec | undefined => KIND_SPECS.find((spec) => spec.kind === kind);
export const kindLabel = (kind: string): string => (kind === 'inbox' ? 'In-app' : kindSpec(kind)?.label ?? kind);
