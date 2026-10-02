import type { Agent } from './api.ts';

export const CREW = [
  { name: 'Pip', color: '#f4b85e', light: '#ffe3ab', kind: 'round', detail: 'The little optimist' },
  { name: 'Mica', color: '#b6a2f0', light: '#e1d8ff', kind: 'cat', detail: 'A curious problem solver' },
  { name: 'Orbit', color: '#74c7df', light: '#cbf1ff', kind: 'jelly', detail: 'Always thinking ahead' },
  { name: 'Sprout', color: '#9ac88a', light: '#d7edb3', kind: 'plant', detail: 'Making room for good ideas' },
  { name: 'Bolt', color: '#ee9987', light: '#ffd1b7', kind: 'box', detail: 'Small bot, big energy' },
  { name: 'Nova', color: '#e1b0d7', light: '#ffe1f5', kind: 'cyclops', detail: 'An eye for the details' },
] as const;

export type CrewCharacter = typeof CREW[number];
export type WorldTheme = 'moonbase' | 'greenhouse' | 'deepsea';

export const WORLD_THEMES: Record<WorldTheme, { label: string; location: string; description: string }> = {
  moonbase: { label: 'Moonbase', location: 'Lunar workspace', description: 'Moonbase' },
  greenhouse: { label: 'Greenhouse', location: 'Botanical workspace', description: 'Greenhouse' },
  deepsea: { label: 'Deep Sea', location: 'Underwater workspace', description: 'Deep Sea' },
};

export function characterFor(id: string): CrewCharacter {
  const demo = CREW.find(character => id === `demo-${character.name}`);
  if (demo) return demo;
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return CREW[hash % CREW.length];
}

export function projectKey(agent: Agent): string {
  return agent.cwd ?? agent.project;
}

export function groupCrews(agents: readonly Agent[]) {
  const groups = new Map<string, { key: string; name: string; agents: Agent[] }>();
  for (const agent of agents) {
    const key = projectKey(agent);
    const group = groups.get(key) ?? { key, name: agent.project || 'Untitled project', agents: [] };
    group.agents.push(agent);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
