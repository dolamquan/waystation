import { describe, expect, it } from 'vitest';
import { CREW, characterFor, groupCrews } from '../web/src/crew.ts';
import { makeAgent } from './helpers.ts';

describe('Waystation crew', () => {
  it('keeps the character identity independent of session status and ordering', () => {
    const agent = makeAgent({ id: 'stable-session', status: 'busy' });
    const character = characterFor(agent.id);
    const updated = { ...agent, status: 'waiting' as const, currentActivity: 'Needs approval' };
    expect(characterFor(updated.id)).toBe(character);
    characterFor('another-session');
    expect(characterFor(agent.id)).toBe(character);
  });

  it('shows all six original character designs in the labeled demo', () => {
    const characters = CREW.map(c => characterFor(`demo-${c.name}`));
    expect(new Set(characters.map(c => c.kind)).size).toBe(6);
    expect(characters.map(c => c.name)).toEqual(['Pip', 'Mica', 'Orbit', 'Sprout', 'Bolt', 'Nova']);
  });

  it('keeps projects with the same name in different directories as separate teams', () => {
    const agents = [
      makeAgent({ id: 'client-1', project: 'app', cwd: 'C:\\client\\app' }),
      makeAgent({ id: 'personal-1', project: 'app', cwd: 'C:\\personal\\app' }),
      makeAgent({ id: 'client-2', project: 'app', cwd: 'C:\\client\\app' }),
    ];
    const teams = groupCrews(agents);
    expect(teams).toHaveLength(2);
    expect(teams.find(t => t.key === 'C:\\client\\app')?.agents.map(a => a.id)).toEqual(['client-1', 'client-2']);
    expect(teams.find(t => t.key === 'C:\\personal\\app')?.agents.map(a => a.id)).toEqual(['personal-1']);
    expect(agents.map(a => a.id)).toEqual(['client-1', 'personal-1', 'client-2']);
  });

  it('groups sessions without a folder by their available project label', () => {
    const teams = groupCrews([
      makeAgent({ id: 'one', project: 'session', cwd: undefined }),
      makeAgent({ id: 'two', project: 'session', cwd: undefined }),
    ]);
    expect(teams).toHaveLength(1);
    expect(teams[0].agents).toHaveLength(2);
    expect(groupCrews([])).toEqual([]);
  });
});
