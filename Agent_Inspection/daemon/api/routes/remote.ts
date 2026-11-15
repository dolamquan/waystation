import type { RemoteAccess } from '../../remote/remoteAccess.ts';
import { bodyOf, r, type Route } from './route.ts';

/** Remote access settings, pairing and devices. Served on the local listener only. */
export function remoteRoutes(remote: RemoteAccess): Route[] {
  return [
    r('GET', '/api/remote', () => ({ remote: remote.status() })),
    r('POST', '/api/remote/config', async ({ body }) => ({ remote: await remote.configure(body) })),
    r('POST', '/api/remote/pair', ({ body }) => ({ pairing: remote.startPairing(bodyOf(body).role) })),
    r('POST', '/api/remote/pair/cancel', () => { remote.cancelPairing(); return { ok: true }; }),
    r('POST', '/api/remote/devices/:id/revoke', ({ params }) => { remote.revoke(params[0]); return { ok: true }; }),
    r('POST', '/api/remote/devices/:id/role', ({ params, body }) => ({ device: remote.setRole(params[0], bodyOf(body).role) })),
  ];
}
