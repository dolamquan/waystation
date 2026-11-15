import type { Tower } from '../../tower.ts';
import { SketchConflictError } from '../../sketch/sketchStore.ts';
import { bodyOf, r, type Route } from './route.ts';

/** The console board's planning sketch. The board saves whole sketches; agents edit them through get_sketch/update_sketch. */
export function sketchRoutes(tower: Tower): Route[] {
  const sketches = tower.library.automation.sketches;
  return [
    r('GET', '/api/sketch/:project', ({ params }) => sketches.get(params[0])),
    r('POST', '/api/sketch/:project', ({ params, body }) => {
      const b = bodyOf(body);
      try { return { ok: true, ...sketches.replace(params[0], b.doc, b.baseRevision) }; }
      // A conflict is an expected outcome, not a failure: the board needs the newer sketch to offer a choice.
      catch (error) { if (error instanceof SketchConflictError) return { ok: false, conflict: true, ...error.current }; throw error; }
    }),
  ];
}
