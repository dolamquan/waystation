import { request } from '../api.ts';
import type { LibrarySkill, LibrarySkillDetail, SkillInput } from '../../../daemon/library/types.ts';

export type { LibrarySkill, LibrarySkillDetail, SkillInput };

const path = (id: string) => `/api/library/skills/${encodeURIComponent(id)}`;

export const skillsApi = {
  list: () => request<{ skills: LibrarySkill[] }>('GET', '/api/library/skills'),
  get: (id: string) => request<{ skill: LibrarySkillDetail }>('GET', path(id)),
  create: (input: SkillInput) => request<{ ok: true; skill: LibrarySkillDetail }>('POST', '/api/library/skills', input),
  update: (id: string, input: Omit<SkillInput, 'name'>) => request<{ ok: true; skill: LibrarySkillDetail }>('POST', path(id), input),
  duplicate: (id: string) => request<{ ok: true; skill: LibrarySkillDetail }>('POST', `${path(id)}/duplicate`),
  remove: (id: string) => request<{ ok: true }>('POST', `${path(id)}/delete`, { confirm: true }),
};
