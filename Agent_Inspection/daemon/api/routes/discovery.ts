import type { Tower } from '../../tower.ts';
import { r, type Route } from './route.ts';

export function discoveryRoutes(tower: Tower): Route[] {
  return [
    r('GET', '/api/discovery', () => ({ rules: tower.discovery.list(), agents: tower.registry.list().filter(agent => agent.observation) })),
    r('POST', '/api/discovery', async ({ body }) => {
      const rule = tower.discovery.add(body);
      tower.store.audit('discovery_add', rule.id, { label: rule.label, executables: rule.executables });
      await tower.refreshDiscovery();
      return { rule };
    }),
    r('POST', '/api/discovery/:id/remove', async ({ params }) => {
      tower.discovery.remove(params[0]);
      tower.store.audit('discovery_remove', params[0], {});
      await tower.refreshDiscovery();
      return { ok: true };
    }),
  ];
}
