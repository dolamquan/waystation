import type { TeamMember, TeamState } from '../daemon/teams/types.ts';

export const member = (
  name: string, role: TeamMember['role'] = 'worker', extra: Partial<TeamMember> = {},
): TeamMember => ({
  id: name, name, role, vendor: 'claude', worktree: `C:\\wt\\${name}`, branch: `team/x/${name}`, merged: false, ...extra,
});

export function makeTeam(overrides: Partial<TeamState> = {}): TeamState {
  return {
    id: 'abc123',
    name: 'Demo',
    goal: 'Ship the feature',
    repoRoot: 'C:\\repo',
    baseBranch: 'main',
    baseCommit: 'deadbeef',
    status: 'running',
    createdAt: 0,
    members: [member('lead', 'lead'), member('api'), member('ui')],
    tasks: [],
    messages: [],
    readUpTo: {},
    budget: { maxWakes: 10, wakesUsed: 0, deadline: Number.MAX_SAFE_INTEGER },
    idleNudged: false,
    intercept: false,
    requirePlanApproval: false,
    ...overrides,
  };
}
