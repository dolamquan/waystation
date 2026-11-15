import { LibraryInputError } from '../library/types.ts';
import type { ConnectorProvider } from '../../shared/connectors.ts';

export const OAUTH = {
  gmail: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token' },
  drive: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token' },
  slack: { authorize: 'https://slack.com/oauth/v2/authorize', token: 'https://slack.com/api/oauth.v2.access' },
  canva: { authorize: 'https://www.canva.com/api/oauth/authorize', token: 'https://api.canva.com/rest/v1/oauth/token' },
} as const;
export type OAuthProvider = keyof typeof OAUTH;
export type ProviderRequest = { url: URL; method: 'GET' | 'POST'; body?: unknown; text?: boolean };
const enc = (v: unknown) => encodeURIComponent(String(v));
/** Fixed hosts, paths, verbs and body shapes: agents never supply an arbitrary URL or authorization header. */
export function providerRequest(provider: ConnectorProvider, tool: string, a: Record<string, unknown>): ProviderRequest {
  const get = (base: string, params: Record<string, unknown> = {}): ProviderRequest => { const url = new URL(base); for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v)); return { url, method: 'GET' }; };
  const post = (url: string, body: unknown): ProviderRequest => ({ url: new URL(url), method: 'POST', body });
  const n = a.limit ?? 20;
  switch (`${provider}:${tool}`) {
    case 'gmail:gmail_search': return get('https://gmail.googleapis.com/gmail/v1/users/me/messages', { q: a.query, maxResults: n });
    case 'gmail:gmail_read': return get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${enc(a.messageId)}`, { format: 'full' });
    case 'gmail:gmail_send': {
      if (/[\r\n]/.test(String(a.to) + String(a.subject))) throw new LibraryInputError('Email recipient and subject must be single lines.');
      const subject = Buffer.from(String(a.subject)).toString('base64');
      const raw = Buffer.from(`To: ${a.to}\r\nSubject: =?UTF-8?B?${subject}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(String(a.body)).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''}`).toString('base64url');
      return post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { raw });
    }
    case 'drive:drive_search': return get('https://www.googleapis.com/drive/v3/files', { q: a.query ?? 'trashed = false', pageSize: n, fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)' });
    case 'drive:drive_metadata': return get(`https://www.googleapis.com/drive/v3/files/${enc(a.fileId)}`, { fields: 'id,name,mimeType,modifiedTime,webViewLink,description' });
    case 'drive:drive_export': return { ...get(`https://www.googleapis.com/drive/v3/files/${enc(a.fileId)}/export`, { mimeType: 'text/plain' }), text: true };
    case 'slack:slack_channels': return get('https://slack.com/api/conversations.list', { types: 'public_channel', exclude_archived: true, limit: n });
    case 'slack:slack_history': return get('https://slack.com/api/conversations.history', { channel: a.channel, limit: n });
    case 'slack:slack_send': return post('https://slack.com/api/chat.postMessage', { channel: a.channel, text: a.text, unfurl_links: false, unfurl_media: false });
    case 'discord:discord_history': return get(`https://discord.com/api/v10/channels/${enc(a.channel)}/messages`, { limit: n });
    case 'discord:discord_send': return post(`https://discord.com/api/v10/channels/${enc(a.channel)}/messages`, { content: a.text, allowed_mentions: { parse: [] } });
    case 'whatsapp:whatsapp_template': return post(`https://graph.facebook.com/v25.0/${enc(a.phoneNumberId)}/messages`, { messaging_product: 'whatsapp', to: a.to, type: 'template', template: { name: a.template, language: { code: a.language } } });
    case 'canva:canva_designs': return get('https://api.canva.com/rest/v1/designs', { query: a.query });
    case 'canva:canva_design': return get(`https://api.canva.com/rest/v1/designs/${enc(a.designId)}`);
    case 'canva:canva_create': return post('https://api.canva.com/rest/v1/designs', { design_type: { type: 'preset', name: 'doc' }, title: a.title });
    default: throw new LibraryInputError('Unsupported connector tool.');
  }
}

export async function boundedText(response: Response, max = 80_000): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return '';
  let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) throw new LibraryInputError('Provider response is too large; narrow the request.'); chunks.push(value); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}
