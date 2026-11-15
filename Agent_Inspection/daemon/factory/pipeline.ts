import type { FactoryDefinition, FactoryEvidence, FactoryPipeline, FactoryRole, FactoryRoleName, FactoryStage, FactoryStageKind, FactoryStatus } from '../../shared/factory.ts';

/**
 * Pure factory lifecycle rules. No I/O: the engine gathers facts (agent output, check results,
 * whether the candidate is unchanged), asks `nextStep` what to do, and carries the step out.
 */

const AGENT_STAGES = {
  plan: { role: 'planner', status: 'planning', name: 'Planner' },
  build: { role: 'builder', status: 'building', name: 'Builder' },
  review: { role: 'reviewer', status: 'reviewing', name: 'Reviewer' },
} as const satisfies Partial<Record<FactoryStageKind, { role: FactoryRoleName; status: FactoryStatus; name: string }>>;
type AgentStageKind = keyof typeof AGENT_STAGES;

const isAgentKind = (kind: FactoryStageKind): kind is AgentStageKind => kind in AGENT_STAGES;

export type FactoryStep =
  | { type: 'launch'; stage: FactoryStage; feedback?: string; repair?: true }
  | { type: 'validate' }
  | { type: 'gate'; status: 'plan_review' | 'acceptance'; message: string; plan?: string }
  | { type: 'block'; message: string; invalidate?: true };

export type FactoryEvent =
  | { kind: 'start' }
  | { kind: 'plan_approved' }
  /** `candidateUnchanged` matters only for stages where `guardsCandidate` is true. */
  | { kind: 'agent_finished'; stage: FactoryStage; output: string; candidateUnchanged: boolean }
  | { kind: 'checks_finished'; failed: readonly FactoryEvidence[]; repairs: number }
  | { kind: 'resume'; hasPlan: boolean; planApproved: boolean; reason: string };

/** Migrates a v1 definition to the equivalent v2 pipeline. The result shares no objects with the input. */
export function pipelineOf(definition: FactoryDefinition): FactoryPipeline {
  const { roles, workflow } = definition;
  const base = { maxMinutes: workflow.maxMinutes, checks: [] };
  const agent = (kind: AgentStageKind, mode: FactoryStage['mode'], readOnly: boolean): FactoryStage => {
    const role: FactoryRole = roles[AGENT_STAGES[kind].role];
    return { ...base, id: kind, kind, name: AGENT_STAGES[kind].name, mode, readOnly, agents: [{ ...role }] };
  };
  const stages: FactoryStage[] = [
    ...(workflow.requirePlan ? [agent('plan', 'manual', true)] : []),
    agent('build', 'auto', false),
    { ...base, id: 'checks', kind: 'checks', name: 'Checks', mode: 'auto', readOnly: false, agents: [], checks: workflow.checks.map(check => ({ ...check })) },
    ...(workflow.review ? [agent('review', 'auto', true)] : []),
    { ...base, id: 'deliver', kind: 'deliver', name: 'Delivery', mode: 'manual', readOnly: false, agents: [] },
  ];
  return { name: workflow.name, stages, repair: { fromStage: 'checks', toStage: 'build', max: workflow.maxRepairs } };
}

export function stageRole(stage: FactoryStage): FactoryRoleName {
  if (!isAgentKind(stage.kind)) throw new Error(`${stage.name} is not an agent stage.`);
  return AGENT_STAGES[stage.kind].role;
}

export function stageStatus(stage: FactoryStage): FactoryStatus {
  if (!isAgentKind(stage.kind)) throw new Error(`${stage.name} is not an agent stage.`);
  return AGENT_STAGES[stage.kind].status;
}

function stageWhere(pipeline: FactoryPipeline, match: (stage: FactoryStage) => boolean, label: string): FactoryStage {
  const stage = pipeline.stages.find(match);
  if (!stage) throw new Error(`The workflow has no ${label} stage.`);
  return stage;
}

export const stageForRole = (pipeline: FactoryPipeline, role: FactoryRoleName): FactoryStage =>
  stageWhere(pipeline, stage => isAgentKind(stage.kind) && AGENT_STAGES[stage.kind].role === role, role);

const stageOfKind = (pipeline: FactoryPipeline, kind: FactoryStageKind) => stageWhere(pipeline, stage => stage.kind === kind, kind);
const stageById = (pipeline: FactoryPipeline, id: string) => stageWhere(pipeline, stage => stage.id === id, id);
const indexOf = (pipeline: FactoryPipeline, stage: FactoryStage) => pipeline.stages.findIndex(entry => entry.id === stage.id);

function following(pipeline: FactoryPipeline, stage: FactoryStage): FactoryStage {
  const next = pipeline.stages[indexOf(pipeline, stage) + 1];
  if (!next) throw new Error(`The workflow ends after ${stage.name} without a delivery stage.`);
  return next;
}

/** True when a stage runs after validation and must leave the validated candidate untouched. */
export function guardsCandidate(pipeline: FactoryPipeline, stage: FactoryStage): boolean {
  const checks = pipeline.stages.findIndex(entry => entry.kind === 'checks');
  return stage.readOnly && checks >= 0 && indexOf(pipeline, stage) > checks;
}

const failureFeedback = (failed: readonly FactoryEvidence[]) => failed.map(check => `${check.name}: ${check.outcome}\n${check.output}`).join('\n\n');

function enter(stage: FactoryStage, previous?: FactoryStage, feedback?: string): FactoryStep {
  if (stage.kind === 'checks') return { type: 'validate' };
  if (stage.kind === 'deliver') {
    const message = previous && previous.kind !== 'checks' && previous.agents.length
      ? `Checks passed and the ${previous.name.toLowerCase()} finished. Review its findings before accepting.`
      : 'Required checks passed. Review the change and acceptance criteria.';
    return { type: 'gate', status: 'acceptance', message };
  }
  return feedback === undefined ? { type: 'launch', stage } : { type: 'launch', stage, feedback };
}

function afterAgent(pipeline: FactoryPipeline, event: Extract<FactoryEvent, { kind: 'agent_finished' }>): FactoryStep {
  const { stage, output } = event;
  if (stage.kind === 'plan' && !output.trim()) return { type: 'block', message: 'The planner returned no plan. Resume to try again.' };
  if (guardsCandidate(pipeline, stage) && !event.candidateUnchanged) {
    return { type: 'block', message: `The ${stage.name.toLowerCase()} changed the candidate. Validate the new revision before acceptance.`, invalidate: true };
  }
  if (stage.mode === 'manual') {
    if (stage.kind !== 'plan') throw new Error(`Approval gates after ${stage.name} are not supported yet.`);
    return { type: 'gate', status: 'plan_review', message: 'The plan is ready. Building waits for your approval.', plan: output };
  }
  return enter(following(pipeline, stage), stage);
}

function afterChecks(pipeline: FactoryPipeline, event: Extract<FactoryEvent, { kind: 'checks_finished' }>): FactoryStep {
  const checks = stageOfKind(pipeline, 'checks');
  if (!event.failed.length) return enter(following(pipeline, checks), checks);
  const repair = pipeline.repair;
  if (repair && repair.fromStage === checks.id && event.repairs < repair.max) {
    return { type: 'launch', stage: stageById(pipeline, repair.toStage), feedback: failureFeedback(event.failed), repair: true };
  }
  return { type: 'block', message: 'Required checks failed. The automatic repair budget is exhausted. Review the evidence before resuming.' };
}

function afterResume(pipeline: FactoryPipeline, event: Extract<FactoryEvent, { kind: 'resume' }>): FactoryStep {
  const plan = pipeline.stages.find(stage => stage.kind === 'plan');
  if (plan && event.hasPlan && !event.planApproved) return { type: 'gate', status: 'plan_review', message: 'Review the saved plan before building.' };
  return { type: 'launch', stage: plan && !event.planApproved ? plan : stageOfKind(pipeline, 'build'), feedback: event.reason };
}

export function nextStep(pipeline: FactoryPipeline, event: FactoryEvent): FactoryStep {
  switch (event.kind) {
    case 'start': return enter(pipeline.stages[0]);
    case 'plan_approved': return enter(following(pipeline, stageOfKind(pipeline, 'plan')));
    case 'agent_finished': return afterAgent(pipeline, event);
    case 'checks_finished': return afterChecks(pipeline, event);
    case 'resume': return afterResume(pipeline, event);
  }
}
