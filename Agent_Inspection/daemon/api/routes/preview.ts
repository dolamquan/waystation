import { execFile } from 'node:child_process';
import { UserError, type Tower } from '../../tower.ts';
import { r, type Route } from './route.ts';

/** Opens a loopback address in the operator's default browser. Only the preview's own URL ever gets here. */
function openInBrowser(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    return Promise.reject(new UserError('Only a local preview address can be opened.'));
  }
  if (process.platform !== 'win32') return Promise.reject(new UserError(`Open ${parsed.href} in your browser.`));
  return new Promise((done, reject) => {
    execFile('rundll32', ['url.dll,FileProtocolHandler', parsed.href], { windowsHide: true }, (error) => (
      error ? reject(new UserError(`Couldn’t open a browser. Visit ${parsed.href} instead.`)) : done()
    ));
  });
}

/**
 * The live app preview for an agent's project folder. The folder and the command both come from the
 * daemon (the agent's recorded cwd and detectPreview), never from the request body.
 */
export function previewRoutes(tower: Tower): Route[] {
  const folderOf = (agentId: string): string | undefined => {
    const agent = tower.sessionAgent(agentId);
    if (!agent) throw new UserError('Agent not found (it may have exited).');
    return agent.cwd;
  };
  return [
    r('GET', '/api/agents/:id/preview', ({ params }) => ({ preview: tower.previews.view(folderOf(params[0])) })),
    r('POST', '/api/agents/:id/preview/start', async ({ params }) => ({ preview: await tower.previews.start(folderOf(params[0])) })),
    r('POST', '/api/agents/:id/preview/stop', async ({ params }) => ({ preview: await tower.previews.stop(folderOf(params[0])) })),
    r('POST', '/api/agents/:id/preview/open', async ({ params }) => {
      const { url } = tower.previews.view(folderOf(params[0]));
      if (!url) throw new UserError('The preview isn’t running yet.');
      await openInBrowser(url);
      return { ok: true };
    }),
  ];
}
