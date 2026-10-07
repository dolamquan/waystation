// OWNER: agent E (schedules). New schedule routes go here; the original ones stay in server.ts.
import type { Tower } from '../../tower.ts';
import { r, type Route } from './route.ts';

export function scheduleRoutes(tower: Tower): Route[] {
  return [
    r('POST', '/api/schedules/:id', ({ params, body }) => ({ ok: true, schedule: tower.ops.updateSchedule(params[0], body) })),
    r('POST', '/api/schedules/:id/resources/upload', ({ params, body }) => ({ ok: true, schedule: tower.ops.uploadScheduleResource(params[0], body) })),
    r('GET', '/api/schedules/:id/runs', ({ params }) => ({ runs: tower.ops.scheduleRuns(params[0]) })),
  ];
}
