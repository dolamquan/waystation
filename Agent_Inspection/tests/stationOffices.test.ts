import { describe, expect, it } from 'vitest';
import type { TeamView } from '../daemon/teams/types.ts';
import { stationOffices } from '../web/src/stationOffices.ts';
import { layoutDecks, teamAgentIds } from '../web/src/stationLayout.ts';
import { makeAgent } from './helpers.ts';

const agent = (id: string, cwd?: string, parentId?: string) => makeAgent({ id, cwd, parentId, project: 'Same project label' });
const team = (overrides: Partial<TeamView> = {}): TeamView => ({
  id: 'team', name: 'Builders', goal: 'Build', repoRoot: 'C:/work/app', baseBranch: 'main', status: 'running', createdAt: 0,
  members: [{ id: 'lead', name: 'lead', role: 'lead', vendor: 'claude', agentId: 'lead', worktree: 'C:/worktrees/lead', branch: 'lead', merged: false }],
  tasks: [], budget: { maxWakes: 10, wakesUsed: 0, deadline: 0 }, ...overrides,
});

describe('station offices', () => {
  it('separates full working folders even when project labels and folder names match', () => {
    const offices = stationOffices([agent('a', 'C:/one/app'), agent('b', 'C:/two/app'), agent('c', 'C:/one/app/subfolder')], []);
    expect(offices).toHaveLength(3);
    expect(offices.map(office => office.name)).toEqual(['one/app', 'subfolder', 'two/app']);
    expect(offices.map(office => office.agents.map(a => a.id))).toEqual([['a'], ['c'], ['b']]);
  });

  it('groups equivalent Windows paths, including case, separators, dot segments and trailing slashes', () => {
    const offices = stationOffices([agent('a', 'C:\\Work\\App\\'), agent('b', 'c:/work/app'), agent('c', 'C:/Work/./App/cache/..')], []);
    expect(offices).toHaveLength(1);
    expect(offices[0].agents).toHaveLength(3);
    expect(offices[0].path).toBe('C:/Work/App');
    expect(stationOffices([agent('a', '\\\\server\\share\\app'), agent('b', '//SERVER/share/app/')], [])).toHaveLength(1);
  });

  it('preserves distinct case-sensitive POSIX folders and root labels', () => {
    expect(stationOffices([agent('a', '/work/App'), agent('b', '/work/app')], [])).toHaveLength(2);
    expect(stationOffices([agent('a', '/')], [])[0].name).toBe('/');
    expect(stationOffices([agent('a', 'C:\\')], [])[0].path).toBe('C:/');
  });

  it('assigns unknown folders to Unassigned without treating a project label as a path', () => {
    const offices = stationOffices([agent('a'), agent('b', '  '), agent('c', 'C:/work/app')], []);
    expect(offices.map(office => office.name)).toEqual(['app', 'Unassigned']);
    expect(offices[1].agents.map(a => a.id)).toEqual(['a', 'b']);
    expect(stationOffices([], [])).toEqual([]);
  });

  it('lets helpers inherit missing folders, while helpers with another folder get their own office', () => {
    const offices = stationOffices([agent('child', undefined, 'parent'), agent('parent', 'C:/app'), agent('other', 'C:/elsewhere', 'parent')], []);
    expect(offices[0].agents.map(a => a.id)).toEqual(['child', 'parent']);
    expect(offices[1].agents.map(a => a.id)).toEqual(['other']);
    expect(stationOffices([agent('orphan', undefined, 'missing')], [])[0].name).toBe('Unassigned');
    expect(stationOffices([agent('a', undefined, 'b'), agent('b', undefined, 'a')], [])[0].agents).toHaveLength(2);
  });

  it('keeps a team table and its worktree members in the repository office without duplicate desks', () => {
    const offices = stationOffices([agent('lead', 'C:/worktrees/lead'), agent('solo', 'C:/work/app'), agent('other', 'C:/different')], [team()]);
    const office = offices.find(candidate => candidate.path === 'C:/work/app')!;
    const seated = teamAgentIds(office.teams);
    const [deck] = layoutDecks(office.teams, office.agents.filter(a => !seated.has(a.id)), office.agents);
    expect(offices).toHaveLength(2);
    expect(deck.map(placement => placement.kind)).toEqual(['team', 'agent']);
    expect(deck[0].kind === 'team' && deck[0].seats[0].agent?.id).toBe('lead');
    expect(office.agents.map(a => a.id)).toEqual(['lead', 'solo']);
  });

  it('includes teams awaiting agents, excludes disbanded tables, and releases their members to their own folders', () => {
    expect(stationOffices([], [team()])[0]).toMatchObject({ name: 'app', agents: [], teams: [team()] });
    expect(stationOffices([], [team({ status: 'disbanded' })])).toEqual([]);
    expect(stationOffices([agent('lead', 'C:/worktrees/lead')], [team({ status: 'disbanded' })])[0].path).toBe('C:/worktrees/lead');
  });
});
