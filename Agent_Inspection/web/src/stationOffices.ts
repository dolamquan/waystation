import type { Agent, TeamView } from './api.ts';
import { onFloor } from './stationLayout.ts';

export interface StationOffice {
  readonly key: string;
  readonly name: string;
  readonly path?: string;
  readonly agents: readonly Agent[];
  readonly teams: readonly TeamView[];
}

const UNASSIGNED = 'unassigned';

/** Compare Windows folders regardless of case, separators or trailing slashes. */
function folder(path: string | undefined): { key: string; path: string } | undefined {
  if (!path?.trim()) return undefined;
  const windows = /^[a-z]:[\\/]|^[\\/]{2}/i.test(path.trim()) || path.includes('\\');
  const slashed = path.trim().replace(/\\/g, '/');
  const prefix = slashed.startsWith('//') ? '//' : slashed.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of slashed.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..' && !/^[a-z]:$/i.test(parts.at(-1)!)) parts.pop();
    else parts.push(part);
  }
  let normalized = prefix + parts.join('/');
  if (/^[a-z]:$/i.test(normalized)) normalized += '/';
  return { key: `folder:${windows ? normalized.toLowerCase() : normalized}`, path: normalized };
}

/** Each working folder gets an office. Team worktrees share their repository's table. */
export function stationOffices(agents: readonly Agent[], teams: readonly TeamView[]): StationOffice[] {
  const floorTeams = teams.filter(onFloor);
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const memberFolders = new Map<string, ReturnType<typeof folder>>();
  const teamFolders = new Map(floorTeams.map(team => {
    const location = folder(team.repoRoot) ?? team.members.map(member => folder(byId.get(member.agentId ?? '')?.cwd)).find(Boolean);
    for (const member of team.members) if (member.agentId) memberFolders.set(member.agentId, location);
    return [team.id, location] as const;
  }));
  const agentFolder = (agent: Agent, visited = new Set<string>()): ReturnType<typeof folder> => {
    if (visited.has(agent.id)) return undefined;
    visited.add(agent.id);
    const location = memberFolders.get(agent.id) ?? folder(agent.cwd);
    if (location) return location;
    const parent = byId.get(agent.parentId ?? '');
    return parent ? agentFolder(parent, visited) : undefined;
  };
  const offices = new Map<string, { key: string; path?: string; agents: Agent[]; teams: TeamView[] }>();
  const officeFor = (location: ReturnType<typeof folder>) => {
    const key = location?.key ?? UNASSIGNED;
    let office = offices.get(key);
    if (!office) {
      office = { key, path: location?.path, agents: [], teams: [] };
      offices.set(key, office);
    }
    return office;
  };
  for (const agent of agents) officeFor(agentFolder(agent)).agents.push(agent);
  for (const team of floorTeams) officeFor(teamFolders.get(team.id)).teams.push(team);
  const paths = [...offices.values()].flatMap(office => office.path ? [office.path] : []);
  return [...offices.values()].map(office => {
    const parts = office.path?.split('/').filter(Boolean) ?? [];
    let name = 'Unassigned';
    // Show enough of the parent path to distinguish folders with the same name.
    for (let length = 1; length <= parts.length; length++) {
      name = parts.slice(-length).join('/');
      if (paths.filter(path => path.split('/').filter(Boolean).slice(-length).join('/').toLowerCase() === name.toLowerCase()).length === 1) break;
    }
    if (office.path === '/') name = '/';
    return { ...office, name };
  }).sort((a, b) => Number(a.key === UNASSIGNED) - Number(b.key === UNASSIGNED) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
