import { describe, expect, it } from 'vitest';
import type { FactoryDefinition, FactoryItem, FactoryStatus } from '../shared/factory.ts';
import { factoryAssignments, factoryCurrentActivity, factoryDuration, preferredWorkItem, workflowProgress, workflowStages } from '../web/src/components/factory/workflowState.ts';
import { makeAgent } from './helpers.ts';

const definition: FactoryDefinition = {
  id: 'factory', name: 'Portal', repository: 'C:/Projects/portal', revision: 4, context: '', createdAt: 1, updatedAt: 1,
  roles: { planner: { vendor: 'claude', model: '', instructions: '' }, builder: { vendor: 'codex', model: '', instructions: '' }, reviewer: { vendor: 'claude', model: '', instructions: '' } },
  workflow: { name: 'Scoped change', requirePlan: true, review: true, maxRepairs: 2, maxMinutes: 20, checks: [{ id: 'tests', name: 'Tests', command: 'npm test' }] },
};
function item(status: FactoryStatus, overrides: Partial<FactoryItem> = {}): FactoryItem {
  return { id: 'work', factoryId: 'factory', title: 'Fix the portal', request: 'Fix', criteria: 'Behavior correct', status, definition: structuredClone(definition),
    createdAt: 1, updatedAt: 1, repairs: 0, attempts: [], evidence: [], activity: [], ...overrides };
}
function validated(status: FactoryStatus = 'acceptance'): FactoryItem {
  return item(status, { plan: 'Plan', planApprovedAt: 5, candidate: 'sha', validation: { revision: 'sha', startedAt: 30, finishedAt: 40, outcome: 'passed' },
    attempts: [{ id: 'build', stage: 'builder', agentId: 'builder', startedAt: 10, finishedAt: 20, outcome: 'finished' }, { id: 'review', stage: 'reviewer', startedAt: 45, finishedAt: 50, outcome: 'finished' }],
    evidence: [{ id: 'evidence', name: 'Tests', command: 'npm test', revision: 'sha', outcome: 'passed', output: 'Pass', startedAt: 30, finishedAt: 40 }] });
}
describe('factory workflow architecture and progress', () => {
  it('includes both approval gates and only the configured agent stages', () => {
    expect(workflowStages(definition).map(stage => stage.id)).toEqual(['plan', 'approval', 'build', 'checks', 'review', 'accept', 'deliver']);
    const simple = structuredClone(definition); simple.workflow.requirePlan = false; simple.workflow.review = false;
    expect(workflowStages(simple).map(stage => stage.id)).toEqual(['build', 'checks', 'accept', 'deliver']);
  });
  it('uses a work item’s saved definition even when current settings change', () => {
    const saved = item('queued'); definition.workflow.review = false;
    expect(workflowProgress(saved).total).toBe(7); definition.workflow.review = true;
  });
  it('does not fabricate progress for queued work', () => {
    const progress = workflowProgress(item('queued')); expect(progress.completed).toBe(0); expect(progress.currentId).toBeUndefined();
    expect(progress.stages.every(stage => stage.state === 'pending')).toBe(true);
  });
  it.each([
    ['planning', 'plan', 'active'], ['plan_review', 'approval', 'waiting'], ['building', 'build', 'active'],
    ['validating', 'checks', 'active'], ['reviewing', 'review', 'active'], ['acceptance', 'accept', 'waiting'], ['accepted', 'deliver', 'waiting'],
  ] as const)('maps %s to its actual stage and state', (status, stage, state) => {
    const progress = workflowProgress(item(status)); expect(progress.currentId).toBe(stage); expect(progress.stages.find(entry => entry.id === stage)?.state).toBe(state);
  });
  it('does not mark plan approval complete just because the planner finished', () => {
    const progress = workflowProgress(item('plan_review', { plan: 'A proposal' }));
    expect(progress.completed).toBe(1); expect(progress.stages.find(stage => stage.id === 'approval')?.state).toBe('waiting');
  });
  it('shows only recorded completion before acceptance, with delivery still pending', () => {
    const progress = workflowProgress(validated()); expect(progress.completed).toBe(5);
    expect(progress.stages.find(stage => stage.id === 'accept')?.state).toBe('waiting'); expect(progress.stages.at(-1)?.state).toBe('pending');
  });
  it('distinguishes acceptance from delivery', () => {
    const candidate = validated('accepted'); candidate.acceptedRevision = 'sha'; candidate.acceptedAt = 55;
    expect(workflowProgress(candidate).completed).toBe(6); expect(workflowProgress(candidate).stages.at(-1)?.state).toBe('waiting');
    candidate.status = 'delivered'; expect(workflowProgress(candidate).completed).toBe(7);
  });
  it.each(['paused', 'blocked', 'cancelled'] as const)('keeps the actual interrupted stage for %s work', status => {
    const progress = workflowProgress(item(status, { suspendedStage: 'validating', plan: 'Plan', planApprovedAt: 5, candidate: 'sha', attempts: [{ id: 'build', stage: 'builder', startedAt: 10, finishedAt: 20, outcome: 'finished' }] }));
    expect(progress.currentId).toBe('checks'); expect(progress.stages.find(stage => stage.id === 'checks')?.state).toBe(status); expect(progress.completed).toBe(3);
  });
  it('supports saved records that predate interruption metadata', () => {
    expect(workflowProgress(item('paused', { plan: 'Plan', attempts: [{ id: 'p', stage: 'planner', startedAt: 1, finishedAt: 3, outcome: 'finished' }] })).currentId).toBe('approval');
    expect(workflowProgress(item('blocked', { candidate: 'sha', attempts: [{ id: 'b', stage: 'builder', startedAt: 1, finishedAt: 3, outcome: 'finished' }] })).currentId).toBe('checks');
  });
  it('does not show previous validation as current progress during repair', () => {
    const repairing = validated('building'); repairing.attempts.push({ id: 'repair', stage: 'builder', startedAt: 60, outcome: 'running' });
    const progress = workflowProgress(repairing); expect(progress.completed).toBe(2); expect(progress.checksRecorded).toBe(0); expect(progress.stages.find(stage => stage.id === 'checks')?.state).toBe('pending');
  });
  it('rejects check evidence from another candidate or missing required commands', () => {
    const candidate = validated(); candidate.evidence[0].revision = 'old'; expect(workflowProgress(candidate).stages.find(stage => stage.id === 'checks')?.state).toBe('pending');
    candidate.evidence[0].revision = 'sha'; candidate.evidence[0].command = 'echo pretend'; expect(workflowProgress(candidate).stages.find(stage => stage.id === 'checks')?.state).toBe('pending');
  });
  it('does not mark invalidated results as a completed validation stage', () => {
    const candidate = validated('blocked'); candidate.suspendedStage = 'acceptance'; candidate.validation!.outcome = 'invalidated';
    expect(workflowProgress(candidate).stages.find(stage => stage.id === 'checks')?.state).toBe('pending');
    expect(workflowProgress(candidate).stages.find(stage => stage.id === 'review')?.state).toBe('pending');
  });
  it('does not count a mismatched accepted revision as acceptance', () => {
    const candidate = validated('accepted'); candidate.acceptedRevision = 'old'; expect(workflowProgress(candidate).stages.find(stage => stage.id === 'accept')?.state).toBe('pending');
  });
});
describe('factory agent visibility', () => {
  const running = () => item('building', { attempts: [{ id: 'attempt', stage: 'builder', agentId: 'agent', startedAt: 1, outcome: 'running' }] });
  it('joins active assignments to the actual session, excluding unrelated agents', () => {
    const rows = factoryAssignments([running()], [makeAgent({ id: 'agent', status: 'busy' }), makeAgent({ id: 'unrelated' })]);
    expect(rows).toHaveLength(1); expect(rows[0].working).toBe(true); expect(rows[0].agent?.id).toBe('agent');
  });
  it('shows permission waits separately from working', () => {
    const row = factoryAssignments([running()], [makeAgent({ id: 'agent', status: 'waiting' })])[0];
    expect(row.label).toBe('Needs your input'); expect(row.waiting).toBe(true); expect(row.working).toBe(false);
  });
  it('does not pretend a missing session is working', () => {
    const row = factoryAssignments([running()], [])[0]; expect(row.label).toBe('Awaiting session update'); expect(row.working).toBe(false);
  });
  it('shows idle sessions as finishing and stopped sessions as stopped', () => {
    expect(factoryAssignments([running()], [makeAgent({ id: 'agent', status: 'idle' })])[0].label).toBe('Finishing stage');
    expect(factoryAssignments([running()], [makeAgent({ id: 'agent', status: 'stopped' })])[0].label).toBe('Stopped');
  });
  it('excludes historical attempts and approval gates with no running assignment', () => {
    const completed = running(); completed.attempts[0].outcome = 'finished'; completed.status = 'plan_review';
    expect(factoryAssignments([completed], [makeAgent({ id: 'agent' })])).toEqual([]);
  });
  it('never reports a paused assignment as actively working', () => {
    const paused = running(); paused.status = 'paused'; expect(factoryAssignments([paused], [makeAgent({ id: 'agent', status: 'busy' })])[0].working).toBe(false);
  });
  it('prioritizes active work before gates and queued items', () => {
    expect(preferredWorkItem([item('queued'), item('plan_review'), running()])?.status).toBe('building');
    expect(preferredWorkItem([item('delivered'), item('queued')])?.status).toBe('queued');
    expect(preferredWorkItem([item('delivered')])).toBeUndefined();
  });
  it('formats measured elapsed time without negative durations', () => {
    expect(factoryDuration(1000, 62000)).toBe('1m 1s'); expect(factoryDuration(1000, 1000)).toBe('0s'); expect(factoryDuration(5000, 1000)).toBe('0s');
  });
  it('uses real activity instead of a stale assignment-wait message', () => {
    const work = running(); work.reason = 'Builder assigned. Waiting for the managed agent.';
    expect(factoryCurrentActivity(work, [makeAgent({ id: 'agent', status: 'busy', currentActivity: 'Editing the checkout calculation' })])).toBe('Editing the checkout calculation');
    expect(factoryCurrentActivity(work, [makeAgent({ id: 'agent', status: 'busy', currentActivity: undefined })])).toBe('Builder is working.');
    expect(factoryCurrentActivity(work, [makeAgent({ id: 'agent', status: 'idle', currentActivity: 'Old activity' })])).toContain('processing its result');
    expect(factoryCurrentActivity(work, [makeAgent({ id: 'agent', status: 'stopped', currentActivity: 'Old activity' })])).toContain('session stopped');
  });
  it('preserves blocked and paused explanations instead of overriding them with old activity', () => {
    const work = running(); work.status = 'blocked'; work.reason = 'Required checks failed.';
    expect(factoryCurrentActivity(work, [makeAgent({ id: 'agent', currentActivity: 'Old activity' })])).toBe('Required checks failed.');
    work.status = 'paused'; work.reason = 'Paused by you.'; expect(factoryCurrentActivity(work, [])).toBe('Paused by you.');
  });
  it('reports actual check progress and permission waits', () => {
    const work = validated('validating'); work.validation = { revision: 'sha', startedAt: 60, outcome: 'running', currentCheck: { id: 'check', name: 'Integration', startedAt: 60 } };
    expect(factoryCurrentActivity(work, [])).toBe('Running Integration. 1 of 1 required checks recorded.');
    expect(factoryCurrentActivity(running(), [makeAgent({ id: 'agent', status: 'waiting', currentActivity: undefined })])).toContain('needs your input');
  });
});
