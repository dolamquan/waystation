import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FactoryFinding, FactoryFindingSeverity, FactoryRoleName, FactorySubmission } from '../../shared/factory.ts';
import { tokensMatch } from '../api/security.ts';
import type { ManagedLaunch } from '../managed/types.ts';
import { UserError } from '../userError.ts';
import { fields } from './definition.ts';

/**
 * The factory bridge: a stdio MCP server each factory agent launches. It lets the agent hand its
 * stage result back as structured data instead of the engine scraping its replies. A token is
 * scoped to one attempt, so an agent can only ever submit for the stage it is running.
 */
export const FACTORY_MCP_SCRIPT = fileURLToPath(new URL('./factory-mcp.mjs', import.meta.url));
export const FACTORY_TOKEN_ENV = 'WAYSTATION_FACTORY_TOKEN';
export const FACTORY_URL_ENV = 'WAYSTATION_FACTORY_URL';

const TOKEN_BYTES = 24;
const MAX_SUMMARY = 400;
const MAX_BODY = 16_000;
const MAX_FINDINGS = 20;
const MAX_FINDING_TEXT = 500;
const MAX_FINDING_FILE = 200;
const SEVERITIES: readonly FactoryFindingSeverity[] = ['blocker', 'major', 'minor'];

/** A missing, forged, revoked or stale bridge token. Routes answer it with 401. */
export class FactoryBridgeAuthError extends Error {
  constructor() { super('missing or invalid factory token'); this.name = 'FactoryBridgeAuthError'; }
}

export interface FactoryGrant { readonly token: string; readonly itemId: string; readonly attemptId: string; readonly role: FactoryRoleName }

/** One live token per attempt. */
export class FactoryGrants {
  private grants: ReadonlyMap<string, FactoryGrant> = new Map();

  issue(scope: Omit<FactoryGrant, 'token'>): string {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    this.grants = new Map([...this.grants, [scope.attemptId, { ...scope, token }]]);
    return token;
  }

  /** Constant-time comparison against every live token. */
  find(token: string | undefined): FactoryGrant | undefined {
    if (!token) return undefined;
    return [...this.grants.values()].find(grant => tokensMatch(token, grant.token));
  }

  revoke(attemptId: string): void {
    if (!this.grants.has(attemptId)) return;
    this.grants = new Map([...this.grants].filter(([id]) => id !== attemptId));
  }
}

export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown> }

const text = (description: string, maxLength: number) => ({ type: 'string', description, maxLength });
const SUMMARY = text('One or two sentences: the outcome at a glance.', MAX_SUMMARY);
const FINDINGS = {
  type: 'array', maxItems: MAX_FINDINGS, description: `Up to ${MAX_FINDINGS} specific issues, most severe first.`,
  items: { type: 'object', required: ['severity', 'text'], additionalProperties: false, properties: {
    severity: { type: 'string', enum: SEVERITIES }, text: text('What is wrong and why it matters.', MAX_FINDING_TEXT), file: text('Relevant file path, if any.', MAX_FINDING_FILE),
  } },
};

/** Per role: the tool, and the argument that carries the main body. */
const ROLE_TOOLS: Record<FactoryRoleName, { tool: McpTool; bodyField: string; bodyLabel: string; bodyRequired: boolean }> = {
  planner: { bodyField: 'plan', bodyLabel: 'Plan', bodyRequired: true, tool: {
    name: 'submit_plan', description: 'Submit your implementation plan for the operator to approve. Call once when the plan is complete, then end your turn.',
    inputSchema: { type: 'object', required: ['summary', 'plan'], additionalProperties: false, properties: { summary: SUMMARY, plan: text('The plan in markdown: steps, validation and acceptance criteria.', MAX_BODY) } },
  } },
  builder: { bodyField: 'details', bodyLabel: 'Details', bodyRequired: false, tool: {
    name: 'submit_result', description: 'Report what you implemented. The factory runs its own checks afterwards; this report does not count as evidence. Call once at the end, then end your turn.',
    inputSchema: { type: 'object', required: ['summary'], additionalProperties: false, properties: { summary: SUMMARY, details: text('Changes made, tests added, and known limitations, in markdown.', MAX_BODY) } },
  } },
  reviewer: { bodyField: 'details', bodyLabel: 'Details', bodyRequired: false, tool: {
    name: 'submit_review', description: 'Submit your review of the candidate. Findings are advisory for the operator. Call once at the end, then end your turn.',
    inputSchema: { type: 'object', required: ['summary'], additionalProperties: false, properties: { summary: SUMMARY, findings: FINDINGS, details: text('Further notes in markdown.', MAX_BODY) } },
  } },
};

export const toolsFor = (role: FactoryRoleName): McpTool[] => [ROLE_TOOLS[role].tool];

export const bridgeInstructions = (role: FactoryRoleName): string =>
  `When you finish, call the \`${ROLE_TOOLS[role].tool.name}\` tool from the \`factory\` server with your result, then end your turn.`;

function boundedText(value: unknown, label: string, max: number, required: boolean): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new UserError(`${label} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new UserError(`${label} is required.`);
  if (trimmed.length > max) throw new UserError(`${label} must be at most ${max} characters.`);
  return trimmed;
}

function parseFindings(value: unknown): FactoryFinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new UserError('Findings must be a list.');
  if (value.length > MAX_FINDINGS) throw new UserError(`Submit at most ${MAX_FINDINGS} findings.`);
  return value.map(raw => {
    const entry = fields(raw);
    if (!SEVERITIES.includes(entry.severity as FactoryFindingSeverity)) throw new UserError(`Finding severity must be one of ${SEVERITIES.join(', ')}.`);
    const file = boundedText(entry.file, 'Finding file', MAX_FINDING_FILE, false);
    return { severity: entry.severity as FactoryFindingSeverity, text: boundedText(entry.text, 'Finding text', MAX_FINDING_TEXT, true), ...(file ? { file } : {}) };
  });
}

/** Validates a tool call from an agent in `role`. Throws a UserError the agent can read and correct. */
export function parseSubmission(role: FactoryRoleName, tool: unknown, rawArgs: unknown): FactorySubmission {
  const spec = ROLE_TOOLS[role];
  if (tool !== spec.tool.name) throw new UserError(`Tool ${String(tool)} is not available in this stage. Use ${spec.tool.name}.`);
  const args = fields(rawArgs);
  return {
    tool: spec.tool.name,
    summary: boundedText(args.summary, 'Summary', MAX_SUMMARY, true),
    body: boundedText(args[spec.bodyField], spec.bodyLabel, MAX_BODY, spec.bodyRequired),
    findings: role === 'reviewer' ? parseFindings(args.findings) : [],
    submittedAt: Date.now(),
  };
}

/** Markdown used wherever the factory shows an attempt's result (plan, runs, repair feedback). */
export function renderSubmission(submission: FactorySubmission): string {
  const findings = submission.findings.length
    ? `Findings:\n${submission.findings.map(finding => `- [${finding.severity}] ${finding.text}${finding.file ? ` (${finding.file})` : ''}`).join('\n')}`
    : '';
  return [submission.summary, submission.body, findings].filter(Boolean).join('\n\n');
}

/** Launch additions that attach the bridge. The token travels in the environment, never argv. */
export function bridgeLaunch(endpoint: string, token: string): Pick<ManagedLaunch, 'mcpServers' | 'env'> {
  return {
    mcpServers: { factory: { command: process.execPath, args: [FACTORY_MCP_SCRIPT], env: { [FACTORY_URL_ENV]: endpoint }, inheritEnv: [FACTORY_TOKEN_ENV] } },
    env: { [FACTORY_TOKEN_ENV]: token },
  };
}
