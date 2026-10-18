import type { Tower } from '../../tower.ts';
import { LibraryInputError } from '../../library/types.ts';
import { bodyOf, r, type Route } from './route.ts';

/** The skill library: list, read, create, edit, duplicate and delete. */
export function skillRoutes(tower: Tower): Route[] {
  const skills = () => tower.library.skills;
  return [
    r('GET', '/api/library/skills', () => ({ skills: skills().list() })),
    r('GET', '/api/library/skills/:id', ({ params }) => ({ skill: skills().get(params[0]) })),
    r('POST', '/api/library/skills', ({ body }) => ({ ok: true, skill: skills().create(body) })),
    r('POST', '/api/library/skills/:id/duplicate', ({ params }) => ({ ok: true, skill: skills().duplicate(params[0]) })),
    r('POST', '/api/library/skills/:id/delete', ({ params, body }) => {
      if (bodyOf(body).confirm !== true) throw new LibraryInputError('Deleting a skill requires confirm: true.');
      skills().remove(params[0]);
      return { ok: true };
    }),
    r('POST', '/api/library/skills/:id', ({ params, body }) => ({ ok: true, skill: skills().update(params[0], body) })),
  ];
}
