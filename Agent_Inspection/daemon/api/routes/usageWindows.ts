import type { Tower } from '../../tower.ts';
import { r, type Route } from './route.ts';

/** 5-hour and weekly plan windows per vendor. Cached in the daemon, so polling every minute is cheap. */
export function usageWindowRoutes(tower: Tower): Route[] {
  return [r('GET', '/api/usage/windows', async () => ({ windows: await tower.usageWindows.report() }))];
}
