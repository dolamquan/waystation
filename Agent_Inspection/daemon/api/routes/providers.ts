import type { Tower } from '../../tower.ts';
import { bodyOf, r, type Route } from './route.ts';
import { UserError } from '../../userError.ts';

export function providerRoutes(tower: Tower): Route[] {
  return [
    r('GET', '/api/providers', () => { tower.providers.refresh(); return tower.providers.report(); }),
    r('POST', '/api/providers/acp', ({ body }) => {
      try { tower.providers.add(body); return tower.providers.report(); }
      catch (error) { throw new UserError((error as Error).message); }
    }),
    r('POST', '/api/providers/:id/remove', ({ params }) => {
      try { tower.providers.remove(params[0]); return tower.providers.report(); }
      catch (error) { throw new UserError((error as Error).message); }
    }),
    r('GET', '/api/providers/copilot', ({ req }) => tower.copilotAccount.read(new URL(req.url ?? '/', 'http://localhost').searchParams.has('refresh'))),
    r('POST', '/api/providers/copilot/auth/begin', () => tower.copilotAccount.beginLogin()),
    r('POST', '/api/providers/copilot/auth/advance', async ({ body }) => {
      const { flowId, input } = bodyOf(body);
      if (typeof flowId !== 'string' || input !== undefined && typeof input !== 'string') throw new UserError('Invalid sign-in response.');
      try { return await tower.copilotAccount.advanceLogin(flowId, input as string | undefined); }
      catch (error) { throw new UserError((error as Error).message); }
    }),
    r('POST', '/api/providers/copilot/auth/cancel', async ({ body }) => {
      await tower.copilotAccount.cancelLogin(String(bodyOf(body).flowId ?? '')); return { ok: true };
    }),
  ];
}
