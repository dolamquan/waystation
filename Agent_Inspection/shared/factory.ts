import type { ManagedVendor } from './agentProviders.ts';

export type FactoryRoleName = 'planner' | 'builder' | 'reviewer';
export interface FactoryRole { vendor: ManagedVendor; model: string; instructions: string }
export interface FactoryCheck { id: string; name: string; command: string }
export interface FactoryDefinition {
  id: string; name: string; repository: string; revision: number;
  roles: Record<FactoryRoleName, FactoryRole>;
  workflow: { name: string; requirePlan: boolean; review: boolean; maxRepairs: number; maxMinutes: number; checks: FactoryCheck[] };
  context: string; createdAt: number; updatedAt: number;
}
/**
 * Factory v2 pipeline: an ordered list of stages plus one bounded repair loop.
 * Phase 0 derives it from a v1 definition (`pipelineOf`); later phases make it configurable.
 */
export type FactoryStageKind = 'plan' | 'build' | 'checks' | 'review' | 'deliver';
/** `manual` stages wait for the operator after producing their output. */
export type FactoryStageMode = 'auto' | 'manual';
export interface FactoryStage {
  id: string; kind: FactoryStageKind; name: string; mode: FactoryStageMode;
  /** Empty for checks and delivery stages. */
  agents: FactoryRole[];
  /** A read-only stage after checks must not change the validated candidate. */
  readOnly: boolean;
  maxMinutes: number; checks: FactoryCheck[];
}
export interface FactoryRepairLoop { fromStage: string; toStage: string; max: number }
export interface FactoryPipeline { name: string; stages: FactoryStage[]; repair: FactoryRepairLoop | null }
export type FactoryStatus ='queued' | 'planning' | 'plan_review' | 'building' | 'validating' | 'reviewing' | 'acceptance' | 'accepted' | 'delivered' | 'blocked' | 'paused' | 'cancelled';
export interface FactoryEvidence {
  id: string; name: string; command: string; revision: string; outcome: 'passed' | 'failed' | 'timed_out';
  output: string; startedAt: number; finishedAt: number;
}
export type FactoryFindingSeverity = 'blocker' | 'major' | 'minor';
export interface FactoryFinding { severity: FactoryFindingSeverity; text: string; file?: string }
/** Structured stage output an agent submits through the factory bridge. Advisory: it never approves anything. */
export interface FactorySubmission { tool: string; summary: string; body: string; findings: FactoryFinding[]; submittedAt: number }
export interface FactoryAttempt {
  id: string; stage: FactoryRoleName; agentId?: string; startedAt: number; finishedAt?: number;
  outcome: 'running' | 'finished' | 'failed' | 'interrupted'; output?: string;
  /** Present when the agent used the factory bridge; otherwise `output` was taken from its replies. */
  submission?: FactorySubmission;
}
export interface FactoryActivity { id: string; at: number; message: string }
export interface FactoryValidationState {
  revision: string; startedAt: number; finishedAt?: number;
  outcome: 'running' | 'passed' | 'failed' | 'interrupted' | 'invalidated';
  currentCheck?: { id: string; name: string; startedAt: number };
}
export interface FactoryItem {
  id: string; factoryId: string; title: string; request: string; criteria: string; status: FactoryStatus;
  definition: FactoryDefinition; createdAt: number; updatedAt: number;
  workspace?: string; branch?: string; baseBranch?: string; baseCommit?: string; candidate?: string;
  plan?: string; planApprovedAt?: number; acceptedRevision?: string; acceptedAt?: number;
  /** The stage actually interrupted, including approval gates; older records may omit it. */
  suspendedStage?: FactoryStatus;
  validation?: FactoryValidationState;
  /** A stage held back by the spend cap or a nearly full plan window; it launches on its own when that clears. */
  waiting?: { stageId: string; feedback: string; reason: string; since: number };
  repairs: number; attempts: FactoryAttempt[]; evidence: FactoryEvidence[]; validationHistory?: FactoryEvidence[][]; activity: FactoryActivity[]; reason?: string;
}
export interface FactorySnapshot { factories: FactoryDefinition[]; items: FactoryItem[] }
export const FACTORY_STATUS_LABELS: Record<FactoryStatus, string> = {
  queued: 'Queued', planning: 'Planning', plan_review: 'Approve plan', building: 'Building', validating: 'Validating',
  reviewing: 'Reviewing', acceptance: 'Ready for acceptance', accepted: 'Accepted', delivered: 'Delivered',
  blocked: 'Needs attention', paused: 'Paused', cancelled: 'Cancelled',
};
export const FACTORY_ACTIVE: FactoryStatus[] = ['planning', 'building', 'validating', 'reviewing'];
export const FACTORY_ATTENTION: FactoryStatus[] = ['plan_review', 'acceptance', 'blocked'];
