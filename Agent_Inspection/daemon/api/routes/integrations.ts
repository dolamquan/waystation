import type { Tower } from '../../tower.ts';
import { LibraryInputError } from '../../library/types.ts';
import { bodyOf, r, type Route } from './route.ts';

const requireConfirm = (body: unknown, what: string) => {
  if (bodyOf(body).confirm !== true) throw new LibraryInputError(`${what} requires confirm: true.`);
};

/** MCP servers (create, edit, delete, test) and Claude Code plugins (defaults, enable, install, uninstall). */
export function integrationRoutes(tower: Tower): Route[] {
  const mcp = () => tower.library.mcp;
  const plugins = () => tower.library.plugins;
  return [
    r('GET', '/api/library/mcp', () => ({ servers: mcp().list(), presets: mcp().presets() })),
    r('POST', '/api/library/mcp', ({ body }) => ({ ok: true, server: mcp().create(body) })),
    r('POST', '/api/library/mcp/:id/delete', ({ params, body }) => {
      requireConfirm(body, 'Deleting an MCP server');
      mcp().remove(params[0]);
      return { ok: true };
    }),
    r('POST', '/api/library/mcp/:id/test', async ({ params }) => ({ result: await mcp().test(params[0]) })),
    r('POST', '/api/library/mcp/:id/default', ({ params, body }) => ({ ok: true, server: mcp().setDefault(params[0], bodyOf(body).on as boolean) })),
    r('POST', '/api/library/mcp/:id', ({ params, body }) => ({ ok: true, server: mcp().update(params[0], body) })),

    r('GET', '/api/library/plugins', () => ({ plugins: plugins().list() })),
    r('GET', '/api/library/plugins/available', () => ({ plugins: plugins().available() })),
    r('POST', '/api/library/plugins/install', async ({ body }) => {
      requireConfirm(body, 'Installing a plugin');
      return { ok: true, output: await plugins().install(bodyOf(body).id) };
    }),
    r('POST', '/api/library/plugins/:id/default', ({ params, body }) => {
      plugins().setDefault(params[0], bodyOf(body).on);
      return { ok: true };
    }),
    r('POST', '/api/library/plugins/:id/enabled', async ({ params, body }) => ({ ok: true, output: await plugins().setEnabled(params[0], bodyOf(body).on) })),
    r('POST', '/api/library/plugins/:id/uninstall', async ({ params, body }) => {
      requireConfirm(body, 'Uninstalling a plugin');
      return { ok: true, output: await plugins().uninstall(params[0]) };
    }),
  ];
}
