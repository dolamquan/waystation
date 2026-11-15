import { describe, expect, test } from 'vitest';
import type { TeamView } from '../web/src/api.ts';
import { activeTeamCount, managedTeamFrames } from '../web/src/components/consoles/managedTeams.ts';

const member = (id: string, agentId?: string) => ({ id, name: id, role: 'worker', vendor: 'claude', agentId, worktree: '', branch: '', merged: false });

function team(id: string, overrides: Partial<TeamView> = {}): TeamView {
  return {
    id, name: `Team ${id}`, goal: 'ship', repoRoot: '/repo', baseBranch: 'main', status: 'running', createdAt: 1,
    members: [], tasks: [], budget: {}, requirePlanApproval: false, pending: {}, pendingIds: {},
    resumeGrant: { wakes: 0, minutes: 0 }, spend: {},
    ...overrides,
  } as unknown as TeamView;
}

describe('managedTeamFrames', () => {
  test('frames only the members whose tiles are on this canvas', () => {
    const teams = [team('a', { members: [member('lead', 'ag1'), member('worker', 'ag2'), member('later')] as never })];
    const frames = managedTeamFrames(teams, ['agent:ag1', 'console:c1']);
    expect(frames).toHaveLength(1);
    expect(frames[0].memberKeys).toEqual(['agent:ag1']);
  });

  test('leaves out teams with no member on the canvas, and archived teams', () => {
    const teams = [
      team('none', { members: [member('lead', 'elsewhere')] as never }),
      team('gone', { status: 'disbanded', members: [member('lead', 'ag1')] as never }),
      team('shelved', { archivedAt: 5, members: [member('lead', 'ag1')] as never }),
    ];
    expect(managedTeamFrames(teams, ['agent:ag1'])).toEqual([]);
  });

  test('orders oldest first and reports progress and whether the operator is needed', () => {
    const teams = [
      team('new', { createdAt: 9, members: [member('m', 'ag2')] as never, status: 'plan_review' }),
      team('old', {
        createdAt: 2, members: [member('m', 'ag1')] as never,
        tasks: [{ status: 'done' }, { status: 'open' }] as never,
      }),
    ];
    const frames = managedTeamFrames(teams, ['agent:ag1', 'agent:ag2']);
    expect(frames.map((frame) => frame.id)).toEqual(['old', 'new']);
    expect(frames[0]).toMatchObject({ tasksDone: 1, taskCount: 2, needsYou: false, statusLabel: 'Running' });
    expect(frames[1]).toMatchObject({ needsYou: true, statusLabel: 'Plan ready for review' });
  });

  test('a blocked task means the team needs you', () => {
    const teams = [team('t', { members: [member('m', 'ag1')] as never, tasks: [{ status: 'blocked' }] as never })];
    expect(managedTeamFrames(teams, ['agent:ag1'])[0].needsYou).toBe(true);
  });
});

test('activeTeamCount skips archived teams', () => {
  expect(activeTeamCount([team('a'), team('b', { status: 'disbanded' }), team('c', { archivedAt: 3 })])).toBe(1);
});
