import type { Agent } from '../../../../daemon/domain/types.ts';
import type { FactoryAttempt, FactoryDefinition, FactoryItem, FactoryRoleName, FactoryStatus } from '../../../../shared/factory.ts';

export type WorkflowStageId = 'plan' | 'approval' | 'build' | 'checks' | 'review' | 'accept' | 'deliver';
export type WorkflowStageState = 'pending' | 'active' | 'waiting' | 'complete' | 'blocked' | 'paused' | 'cancelled' | 'awaiting' | 'finishing';
export interface WorkflowStage {
  id: WorkflowStageId; label: string; owner: string; role?: FactoryRoleName; description: string;
}
const STAGES: WorkflowStage[] = [
  { id: 'plan', label: 'Plan', owner: 'Planner', role: 'planner', description: 'Investigate the request and propose an implementation plan.' },
  { id: 'approval', label: 'Approve plan', owner: 'You', description: 'Implementation waits for your explicit plan approval.' },
  { id: 'build', label: 'Build', owner: 'Builder', role: 'builder', description: 'Implement the approved request in an isolated Git worktree.' },
  { id: 'checks', label: 'Validate', owner: 'Check runner', description: 'Execute required commands against the candidate revision.' },
  { id: 'review', label: 'Review', owner: 'Reviewer', role: 'reviewer', description: 'Review the tested change and record advisory findings.' },
  { id: 'accept', label: 'Accept', owner: 'You', description: 'Inspect the change, criteria and evidence before accepting this revision.' },
  { id: 'deliver', label: 'Deliver', owner: 'Git', description: 'Merge the accepted commit after your confirmation.' },
];
const ROLE_STAGE: Record<FactoryRoleName, WorkflowStageId> = { planner: 'plan', builder: 'build', reviewer: 'review' };
const STATUS_STAGE: Partial<Record<FactoryStatus, WorkflowStageId>> = {
  planning: 'plan', plan_review: 'approval', building: 'build', validating: 'checks', reviewing: 'review', acceptance: 'accept', accepted: 'deliver', delivered: 'deliver',
};
export const STAGE_STATE_LABELS: Record<WorkflowStageState, string> = {
  pending: 'Pending', active: 'Working', waiting: 'Waiting for you', complete: 'Complete', blocked: 'Blocked', paused: 'Paused', cancelled: 'Cancelled',
  awaiting: 'Awaiting session update', finishing: 'Finishing stage',
};
export function workflowStages(definition: FactoryDefinition): WorkflowStage[] {
  return STAGES.filter(stage => (definition.workflow.requirePlan || !['plan', 'approval'].includes(stage.id)) && (definition.workflow.review || stage.id !== 'review'));
}
export function latestRoleAttempt(item: FactoryItem, role: FactoryRoleName): FactoryAttempt | undefined {
  return item.attempts.findLast(attempt => attempt.stage === role);
}
/** Interrupted legacy records have no persisted stage; infer conservatively from recorded evidence. */
function interruptedStage(item: FactoryItem): WorkflowStageId | undefined {
  if (item.suspendedStage) return STATUS_STAGE[item.suspendedStage];
  if (item.acceptedRevision) return 'deliver';
  const attempt = item.attempts.at(-1);
  if (attempt?.stage === 'planner' && item.plan && !item.planApprovedAt) return 'approval';
  if (attempt?.stage === 'builder' && attempt.outcome === 'finished' && item.candidate) return 'checks';
  return attempt ? ROLE_STAGE[attempt.stage] : undefined;
}
export function workflowProgress(item: FactoryItem) {
  const stages = workflowStages(item.definition);
  const suspended = ['blocked', 'paused', 'cancelled'].includes(item.status);
  const currentId = suspended ? interruptedStage(item) : STATUS_STAGE[item.status];
  const currentIndex = stages.findIndex(stage => stage.id === currentId);
  const latestBuilder = latestRoleAttempt(item, 'builder');
  const validationBelongsToBuild = !latestBuilder || (latestBuilder.outcome === 'finished' && (!item.validation || (latestBuilder.finishedAt !== undefined && latestBuilder.finishedAt <= item.validation.startedAt)));
  const evidence = validationBelongsToBuild ? item.evidence.filter(check => check.revision === item.candidate) : [];
  const checksPassed = item.definition.workflow.checks.length > 0 && item.definition.workflow.checks.every(check =>
    evidence.some(result => result.name === check.name && result.command === check.command && result.outcome === 'passed'));
  const confirmed: Record<WorkflowStageId, boolean> = {
    plan: !!item.plan, approval: !!item.planApprovedAt,
    build: latestBuilder?.outcome === 'finished' && !!item.candidate,
    checks: checksPassed && (!item.validation || item.validation.outcome === 'passed'),
    review: latestRoleAttempt(item, 'reviewer')?.outcome === 'finished' && item.validation?.outcome !== 'invalidated',
    accept: !!item.acceptedRevision && item.acceptedRevision === item.candidate, deliver: item.status === 'delivered',
  };
  const states = stages.map((stage, index): WorkflowStage & { state: WorkflowStageState } => {
    let state: WorkflowStageState = 'pending';
    if (item.status === 'delivered') state = 'complete';
    else if (index < currentIndex && confirmed[stage.id]) state = 'complete';
    else if (index === currentIndex) state = suspended ? item.status as 'blocked' | 'paused' | 'cancelled'
      : ['plan_review', 'acceptance', 'accepted'].includes(item.status) ? 'waiting' : 'active';
    return { ...stage, state };
  });
  return { stages: states, currentId, completed: states.filter(stage => stage.state === 'complete').length, total: stages.length,
    checksPassed: evidence.filter(check => check.outcome === 'passed').length, checksRecorded: evidence.length, checksTotal: item.definition.workflow.checks.length };
}
export interface FactoryAssignment { item: FactoryItem; attempt: FactoryAttempt; agent?: Agent; label: string; working: boolean; waiting: boolean }
export function factoryAssignments(items: FactoryItem[], agents: readonly Agent[]): FactoryAssignment[] {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  return items.flatMap(item => {
    const attempt = item.attempts.at(-1);
    if (!attempt || attempt.outcome !== 'running') return [];
    const agent = attempt.agentId ? byId.get(attempt.agentId) : undefined;
    const active = ['planning', 'building', 'reviewing'].includes(item.status);
    const label = !active ? 'Paused' : agent?.status === 'busy' ? 'Working' : agent?.status === 'waiting' ? 'Needs your input'
      : agent?.status === 'idle' ? 'Finishing stage' : agent?.status === 'stopped' ? 'Stopped' : 'Awaiting session update';
    return [{ item, attempt, agent, label, working: active && agent?.status === 'busy', waiting: active && agent?.status === 'waiting' }];
  });
}
/** Prefer session telemetry while a role is active; preserve actionable interruption explanations. */
export function factoryCurrentActivity(item: FactoryItem, agents: readonly Agent[]): string | undefined {
  if (item.status === 'validating' && item.validation?.outcome === 'running' && item.validation.currentCheck) {
    return `Running ${item.validation.currentCheck.name}. ${item.evidence.length} of ${item.definition.workflow.checks.length} required checks recorded.`;
  }
  if (!['planning', 'building', 'reviewing'].includes(item.status)) return item.reason;
  const assignment = factoryAssignments([item], agents)[0];
  if (assignment?.agent?.currentActivity && ['busy', 'waiting'].includes(assignment.agent.status)) return assignment.agent.currentActivity;
  if (assignment?.working) return `${assignment.attempt.stage[0].toUpperCase() + assignment.attempt.stage.slice(1)} is working.`;
  if (assignment?.waiting) return 'The assigned agent needs your input. Open its details to respond.';
  if (assignment?.agent?.status === 'idle') return 'The agent finished its turn. The factory is processing its result.';
  if (assignment?.agent?.status === 'stopped') return 'The assigned session stopped. Waiting for the factory to reconcile its result.';
  return item.reason;
}
export function factoryDuration(start: number, end = Date.now()): string {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
export function preferredWorkItem(items: FactoryItem[]): FactoryItem | undefined {
  return items.find(item => ['planning', 'building', 'validating', 'reviewing'].includes(item.status))
    ?? items.find(item => ['plan_review', 'acceptance', 'blocked', 'paused'].includes(item.status))
    ?? items.find(item => item.status === 'queued');
}
