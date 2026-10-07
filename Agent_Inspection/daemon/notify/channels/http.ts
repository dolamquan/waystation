import { LibraryInputError } from '../../library/types.ts';
import type { DeliveryContext } from './types.ts';

const RESPONSE_SNIPPET = 200;

/** POSTs JSON; a non-2xx answer becomes an error carrying the status and a short reason. */
export async function postJson(
  ctx: DeliveryContext,
  url: string,
  payload: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<void> {
  const response = await ctx.io.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: ctx.signal,
    redirect: 'error',
  });
  if (response.ok) return;
  const reason = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, RESPONSE_SNIPPET);
  throw new Error(`HTTP ${response.status}${reason ? `: ${reason}` : ''}`);
}

export function requireHttpUrl(value: string | undefined, what: string, https = false): URL {
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new LibraryInputError(`${what} must be a valid URL`);
  }
  const allowed = https ? ['https:'] : ['https:', 'http:'];
  if (!allowed.includes(url.protocol)) throw new LibraryInputError(`${what} must start with ${https ? 'https://' : 'http:// or https://'}`);
  if (url.username || url.password) throw new LibraryInputError(`${what} must not contain a user name or password`);
  return url;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
