import type { Tower } from '../../tower.ts';
import { LibraryInputError } from '../../library/types.ts';
import { bodyOf, r, type Route } from './route.ts';

export function canvasRoutes(tower: Tower): Route[] {
  const canvas = tower.library.automation.canvas;
  return [
    r('GET', '/api/canvas/tiles', () => ({ tiles: canvas.list() })),
    r('POST', '/api/canvas/tiles', ({ body }) => ({ tile: canvas.create(bodyOf(body)) })),
    r('POST', '/api/canvas/tiles/:id', ({ params, body }) => ({ tile: canvas.update(params[0], bodyOf(body)) })),
    r('POST', '/api/canvas/tiles/:id/close', ({ params }) => { canvas.remove(params[0]); return { ok: true }; }),
    // Import only missing ids; a second window cannot overwrite daemon state. The browser retires its backup after success.
    r('POST', '/api/canvas/import', ({ body }) => {
      const input = bodyOf(body).tiles;
      if (!Array.isArray(input) || input.length > 32) throw new LibraryInputError('Expected at most 32 legacy tiles.');
      const rejected: string[] = [];
      for (const raw of input) {
        const tile = bodyOf(raw);
        if (canvas.list().some(existing => existing.id === tile.id)) continue;
        try { canvas.create(tile); } catch { rejected.push(String(tile.id)); }
      }
      return { tiles: canvas.list(), rejected };
    }),
  ];
}
