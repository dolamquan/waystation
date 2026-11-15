import { describe, expect, it } from 'vitest';
import { factoryDefaults } from '../daemon/factory/definition.ts';
import { guardsCandidate, nextStep, pipelineOf, stageForRole, stageRole, stageStatus } from '../daemon/factory/pipeline.ts';
import type { FactoryDefinition, FactoryEvidence } from '../shared/factory.ts';

function definition(workflow: Partial<FactoryDefinition['workflow']> = {}): FactoryDefinition {
  const defaults = factoryDefaults();
  return { id: 'f1', name: 'Factory', repository: '/repo', revision: 1, roles: defaults.roles, context: '', createdAt: 0, updatedAt: 0,
    workflow: { ...defaults.workflow, checks: [{ id: 'c1', name: 'Tests', command: 'npm test' }], ...workflow } };
}
const failure = (name: string): FactoryEvidence => ({ id: name, name, command: 'npm test', revision: 'abc', outcome: 'failed', output: `${name} broke`, startedAt: 0, finishedAt: 1 });

describe('pipelineOf (v1 → v2 migration)', () => {
  it.each([
    [{ requirePlan: true, review: true }, ['plan', 'build', 'checks', 'review', 'deliver']],
    [{ requirePlan: true, review: false }, ['plan', 'build', 'checks', 'deliver']],
    [{ requirePlan: false, review: true }, ['build', 'checks', 'review', 'deliver']],
    [{ requirePlan: false, review: false }, ['build', 'checks', 'deliver']],
  ])('maps %o to the stages %o', (workflow, kinds) => {
    expect(pipelineOf(definition(workflow)).stages.map(stage => stage.kind)).toEqual(kinds);
  });
  it('carries roles, checks, limits and the repair loop over unchanged', () => {
    const source = definition({ maxRepairs: 3, maxMinutes: 45 }); const pipeline = pipelineOf(source);
    expect(stageForRole(pipeline, 'builder').agents).toEqual([source.roles.builder]);
    expect(pipeline.stages.find(stage => stage.kind === 'checks')?.checks).toEqual(source.workflow.checks);
    expect(pipeline.stages.every(stage => stage.maxMinutes === 45)).toBe(true);
    expect(pipeline.repair).toEqual({ fromStage: 'checks', toStage: 'build', max: 3 });
    expect(pipeline.stages.find(stage => stage.kind === 'plan')?.mode).toBe('manual');
    expect(pipeline.stages.at(-1)?.mode).toBe('manual');
  });
  it('does not share mutable state with the source definition', () => {
    const source = definition(); const pipeline = pipelineOf(source);
    pipeline.stages[0].agents[0].instructions = 'changed';
    expect(source.roles.planner.instructions).not.toBe('changed');
  });
  it('maps agent stages to their v1 roles and statuses', () => {
    const pipeline = pipelineOf(definition({ review: true }));
    expect(pipeline.stages.filter(stage => stage.agents.length).map(stage => [stageRole(stage), stageStatus(stage)]))
      .toEqual([['planner', 'planning'], ['builder', 'building'], ['reviewer', 'reviewing']]);
    expect(() => stageRole(pipeline.stages.find(stage => stage.kind === 'checks')!)).toThrow(/not an agent stage/);
  });
  it('guards the candidate only for read-only stages after checks', () => {
    const pipeline = pipelineOf(definition({ review: true }));
    expect(pipeline.stages.filter(stage => guardsCandidate(pipeline, stage)).map(stage => stage.kind)).toEqual(['review']);
  });
});

describe('nextStep', () => {
  const planned = pipelineOf(definition({ requirePlan: true, review: true, maxRepairs: 1 }));
  const direct = pipelineOf(definition({ requirePlan: false, review: false }));
  const stage = (kind: string, pipeline = planned) => pipeline.stages.find(entry => entry.kind === kind)!;

  it('starts with the planner when planning is required, otherwise the builder', () => {
    expect(nextStep(planned, { kind: 'start' })).toMatchObject({ type: 'launch', stage: { kind: 'plan' } });
    expect(nextStep(direct, { kind: 'start' })).toMatchObject({ type: 'launch', stage: { kind: 'build' } });
  });
  it('gates a finished plan for approval and records it', () => {
    expect(nextStep(planned, { kind: 'agent_finished', stage: stage('plan'), output: 'Step 1', candidateUnchanged: true }))
      .toEqual({ type: 'gate', status: 'plan_review', message: 'The plan is ready. Building waits for your approval.', plan: 'Step 1' });
  });
  it('blocks an empty plan instead of building', () => {
    expect(nextStep(planned, { kind: 'agent_finished', stage: stage('plan'), output: '  ', candidateUnchanged: true }))
      .toEqual({ type: 'block', message: 'The planner returned no plan. Resume to try again.' });
  });
  it('builds after plan approval and validates after building', () => {
    expect(nextStep(planned, { kind: 'plan_approved' })).toMatchObject({ type: 'launch', stage: { kind: 'build' } });
    expect(nextStep(planned, { kind: 'agent_finished', stage: stage('build'), output: '', candidateUnchanged: true })).toEqual({ type: 'validate' });
  });
  it('repairs failed checks within budget, then blocks', () => {
    const failed = [failure('Unit'), failure('Lint')];
    expect(nextStep(planned, { kind: 'checks_finished', failed, repairs: 0 })).toEqual({ type: 'launch', stage: stage('build'), repair: true, feedback: 'Unit: failed\nUnit broke\n\nLint: failed\nLint broke' });
    expect(nextStep(planned, { kind: 'checks_finished', failed, repairs: 1 }))
      .toEqual({ type: 'block', message: 'Required checks failed. The automatic repair budget is exhausted. Review the evidence before resuming.' });
  });
  it('sends passing checks to the reviewer, or straight to acceptance without one', () => {
    expect(nextStep(planned, { kind: 'checks_finished', failed: [], repairs: 0 })).toMatchObject({ type: 'launch', stage: { kind: 'review' } });
    expect(nextStep(direct, { kind: 'checks_finished', failed: [], repairs: 0 }))
      .toEqual({ type: 'gate', status: 'acceptance', message: 'Required checks passed. Review the change and acceptance criteria.' });
  });
  it('accepts a review only when the candidate is unchanged', () => {
    expect(nextStep(planned, { kind: 'agent_finished', stage: stage('review'), output: 'Looks fine', candidateUnchanged: true }))
      .toEqual({ type: 'gate', status: 'acceptance', message: 'Checks passed and the reviewer finished. Review its findings before accepting.' });
    expect(nextStep(planned, { kind: 'agent_finished', stage: stage('review'), output: 'Edited', candidateUnchanged: false }))
      .toEqual({ type: 'block', message: 'The reviewer changed the candidate. Validate the new revision before acceptance.', invalidate: true });
  });
  it('resumes without bypassing an unapproved plan', () => {
    expect(nextStep(planned, { kind: 'resume', hasPlan: true, planApproved: false, reason: 'Paused' }))
      .toEqual({ type: 'gate', status: 'plan_review', message: 'Review the saved plan before building.' });
    expect(nextStep(planned, { kind: 'resume', hasPlan: false, planApproved: false, reason: 'Launch failed' })).toMatchObject({ type: 'launch', stage: { kind: 'plan' }, feedback: 'Launch failed' });
    expect(nextStep(planned, { kind: 'resume', hasPlan: true, planApproved: true, reason: 'Paused' })).toMatchObject({ type: 'launch', stage: { kind: 'build' } });
    expect(nextStep(direct, { kind: 'resume', hasPlan: false, planApproved: false, reason: '' })).toMatchObject({ type: 'launch', stage: { kind: 'build' } });
  });
});
