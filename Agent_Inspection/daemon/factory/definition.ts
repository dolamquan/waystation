import { randomUUID } from 'node:crypto';
import { isManagedVendor } from '../../shared/agentProviders.ts';
import type { FactoryDefinition } from '../../shared/factory.ts';
import { isValidModelName } from '../managed/modelName.ts';
import { UserError } from '../userError.ts';

const MAX_CHECKS = 12;
const ROLE_NAMES = ['planner', 'builder', 'reviewer'] as const;

/** Narrows untrusted JSON to a plain object; anything else becomes an empty record. */
export const fields = (input: unknown): Record<string, unknown> => input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};

export function string(value: unknown, name: string, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new UserError(`${name} ${required ? 'is required and' : ''} must be at most ${max} characters.`);
  return value.trim();
}

export function number(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new UserError(`Choose a whole number between ${min} and ${max}.`);
  return value;
}

export const factoryDefaults = () => ({
  roles: {
    planner: { vendor: 'claude' as const, model: '', instructions: 'Investigate the repository and propose a concrete plan. Include validation and acceptance criteria. Do not modify files.' },
    builder: { vendor: 'codex' as const, model: '', instructions: 'Implement the approved request. Add meaningful tests. Keep changes scoped and report limitations.' },
    reviewer: { vendor: 'claude' as const, model: '', instructions: 'Review the candidate against the request and acceptance criteria. Report issues and limitations. Do not modify files.' },
  },
  workflow: { name: 'Scoped change', requirePlan: true, review: true, maxRepairs: 1, maxMinutes: 20, checks: [] }, context: '',
});

function parseRoles(raw: unknown): FactoryDefinition['roles'] {
  const roles = fields(raw);
  const parsed = {} as FactoryDefinition['roles'];
  for (const name of ROLE_NAMES) {
    const role = fields(roles[name]);
    if (!isManagedVendor(role.vendor)) throw new UserError(`Choose a connected provider for ${name}.`);
    const model = string(role.model ?? '', 'Model', 150, false);
    if (model && !isValidModelName(model)) throw new UserError('Model name looks invalid.');
    parsed[name] = { vendor: role.vendor, model, instructions: string(role.instructions ?? '', 'Role instructions', 6000, false) };
  }
  return parsed;
}

function parseWorkflow(raw: unknown): FactoryDefinition['workflow'] {
  const workflow = fields(raw);
  if (!Array.isArray(workflow.checks) || workflow.checks.length > MAX_CHECKS) throw new UserError(`Configure up to ${MAX_CHECKS} required checks.`);
  if (typeof workflow.requirePlan !== 'boolean' || typeof workflow.review !== 'boolean') throw new UserError('Plan approval and review settings must be true or false.');
  return {
    name: string(workflow.name, 'Workflow name', 100), requirePlan: workflow.requirePlan, review: workflow.review,
    maxRepairs: number(workflow.maxRepairs, 1, 0, 5), maxMinutes: number(workflow.maxMinutes, 20, 1, 120),
    checks: workflow.checks.map(entry => { const check = fields(entry); return { id: randomUUID(), name: string(check.name, 'Check name', 100), command: string(check.command, 'Check command', 2000) }; }),
  };
}

/**
 * Validates an operator-submitted definition. `previous` is the stored version when editing;
 * its revision must match the submitted one so concurrent edits are refused.
 */
export function parseFactoryDefinition(raw: unknown, previous?: FactoryDefinition): FactoryDefinition {
  const body = fields(raw);
  if (previous && body.revision !== previous.revision) throw new UserError('Factory settings changed elsewhere. Reload before saving.');
  const defaults = factoryDefaults();
  return {
    id: previous?.id ?? randomUUID(), name: string(body.name, 'Factory name', 100), repository: string(body.repository, 'Repository path', 2000),
    revision: (previous?.revision ?? 0) + 1,
    roles: parseRoles(body.roles ?? previous?.roles ?? defaults.roles),
    context: string(body.context ?? previous?.context ?? '', 'Project context', 6000, false),
    workflow: parseWorkflow(body.workflow ?? previous?.workflow ?? defaults.workflow),
    createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(),
  };
}
