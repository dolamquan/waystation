import type { IncomingMessage, ServerResponse } from 'node:http';

export type Handler = (ctx: { params: string[]; body: unknown; req: IncomingMessage; res: ServerResponse }) => unknown;
export interface Route { method: string; pattern: RegExp; handler: Handler }

/** `r('POST', '/api/things/:id/delete', handler)`: each `:name` becomes a URL-decoded entry in `params`. */
export const r = (method: string, path: string, handler: Handler): Route =>
  ({ method, pattern: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), handler });

export const bodyOf = (body: unknown): Record<string, unknown> =>
  (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;

/** Header value as a single string. */
export const headerOf = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};
