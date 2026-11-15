import { describe, expect, it } from 'vitest';
import { linkBetween, orchestratorLinks } from '../web/src/components/consoles/orchestratorLinks.ts';
import { scopeRoster, type Roster } from '../web/src/components/consoles/orchestration.ts';
import { cleanTeamIds, readTile, tileLabel, updateTile } from '../shared/canvasTiles.ts';

const box = (x: number, y: number, width = 100, height = 100) => ({ x, y, width, height });

describe('orchestrator links', () => {
  it('leaves from the facing sides when boxes sit side by side', () => {
    const link = linkBetween(box(0, 0), box(300, 50));
    expect(link.from).toEqual({ x: 100, y: 50 });
    expect(link.to).toEqual({ x: 300, y: 100 });
    expect(link.c1.x).toBeGreaterThan(link.from.x);
    expect(link.c2.x).toBeLessThan(link.to.x);
  });

  it('uses top and bottom when one box is above the other, even if they are also apart sideways', () => {
    const link = linkBetween(box(0, 0), box(600, 300));
    expect(link.from).toEqual({ x: 50, y: 100 });
    expect(link.to).toEqual({ x: 650, y: 300 });
  });

  it('goes from bottom to top when boxes are stacked', () => {
    const link = linkBetween(box(0, 0), box(20, 300));
    expect(link.from).toEqual({ x: 50, y: 100 });
    expect(link.to).toEqual({ x: 70, y: 300 });
  });

  it('links an orchestrator only to the teams and agents wired to it', () => {
    const frames = [{ id: 'a', frame: box(400, 0) }, { id: 'b', frame: box(-400, 0) }];
    const rects = { 'tile:o1': box(0, 0), 'tile:o2': box(0, 300), 'console:x': box(0, 600) };
    const links = orchestratorLinks([
      { key: 'tile:o1', teams: [] }, { key: 'tile:o2', teams: ['b'], agents: ['console:x', 'console:gone'] }, { key: 'tile:gone', teams: ['a'] },
    ], frames, rects);
    expect(links.map((link) => link.key)).toEqual(['tile:o2>b', 'tile:o2>console:x']);
    expect(links.map((link) => link.tone)).toEqual([1, 1]);
  });
});

describe('orchestrator scope', () => {
  const agent = (key: string, status: 'working' | 'idle') => ({ key, agentId: key, name: key, vendor: 'Claude', status });
  const roster: Roster = {
    teams: [{ id: 't1', name: 'One', members: [agent('a', 'working'), agent('b', 'idle')] }, { id: 't2', name: 'Two', members: [agent('c', 'working')] }],
    solos: [agent('d', 'working')], total: 4, working: 3,
  };

  it('directs nobody until something is wired', () => {
    const scoped = scopeRoster(roster, { teams: [], agents: [] });
    expect([scoped.teams, scoped.solos, scoped.total]).toEqual([[], [], 0]);
  });

  it('keeps only the wired teams', () => {
    const scoped = scopeRoster(roster, { teams: ['t1'], agents: [] });
    expect(scoped.teams.map((team) => team.id)).toEqual(['t1']);
    expect(scoped.solos).toEqual([]);
    expect([scoped.total, scoped.working]).toEqual([2, 1]);
  });

  it('adds wired single agents, counting a member of a wired team once', () => {
    const scoped = scopeRoster(roster, { teams: ['t1'], agents: ['a', 'c', 'd', 'missing'] });
    expect(scoped.teams.map((team) => team.id)).toEqual(['t1']);
    expect(scoped.solos.map((agent) => agent.key)).toEqual(['c', 'd']);
    expect([scoped.total, scoped.working]).toEqual([4, 3]);
  });
});

describe('orchestrator tiles', () => {
  it('reads an orchestrator tile, cleaning its team list', () => {
    const tile = readTile({ id: 'o', kind: 'orchestrator', project: 'p', teams: ['a', 'a', 7, '', 'b'] }, 'http://127.0.0.1:4317');
    expect(tile).toMatchObject({ kind: 'orchestrator', teams: ['a', 'b'] });
    expect(tileLabel(tile!)).toBe('Orchestrator');
  });

  it('reads the wired agents, defaulting to none', () => {
    const origin = 'http://127.0.0.1:4317';
    expect(readTile({ id: 'o', kind: 'orchestrator', project: 'p', agents: ['console:a', 3, 'console:a'] }, origin)).toMatchObject({ agents: ['console:a'] });
    expect(readTile({ id: 'o', kind: 'orchestrator', project: 'p' }, origin)).toMatchObject({ teams: [], agents: [] });
  });

  it('caps the team list and updates it immutably', () => {
    expect(cleanTeamIds(Array.from({ length: 40 }, (_, index) => `t${index}`))).toHaveLength(24);
    const before = [{ id: 'o', kind: 'orchestrator' as const, project: 'p', teams: [], createdAt: 1 }];
    const after = updateTile(before, 'o', { teams: ['x'] });
    expect(after[0]!.teams).toEqual(['x']);
    expect(before[0]!.teams).toEqual([]);
  });
});
