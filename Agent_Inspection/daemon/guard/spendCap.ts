import { OpsInputError } from '../ops/templates.ts';
import type { VendorWindows } from '../usage/windowTypes.ts';

/**
 * Fleet-wide spend and quota policy, side-effect free. AgentOps reads today's spend and the plan
 * windows, asks these functions what the state is, and carries out the result (defer automated
 * launches, constrain running agents through the runaway guard).
 */
export interface SpendCapConfig {
  /** Whole fleet, per local calendar day (list-price estimate). Undefined: no cap. */
  readonly dailyUsd?: number;
  /** Project folder name → daily cap in USD. */
  readonly projects: Readonly<Record<string, number>>;
  /** Defer schedules and factory stages while a vendor plan window is at or above this percentage. */
  readonly quotaPausePercent?: number;
  /** When a cap is exceeded, turn on approvals for running agents launched here (via the runaway guard). */
  readonly constrainRunning: boolean;
}

export const DEFAULT_SPEND_CAP: SpendCapConfig = { projects: {}, constrainRunning: true };

export type SpendState = 'ok' | 'near' | 'over';

export interface SpendScope {
  readonly scope: 'fleet' | 'project';
  readonly project?: string;
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly state: SpendState;
}

export interface SpendStatus {
  readonly day: string;
  readonly totalUsd: number;
  readonly scopes: readonly SpendScope[];
}

export interface ProjectSpend {
  readonly project: string;
  readonly costUsd: number;
}

export interface QuotaPressure {
  readonly vendor: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt?: number;
}

/** A scope is "near" from this fraction of its cap. */
export const NEAR_FRACTION = 0.8;
const MIN_QUOTA_PERCENT = 50;
const MAX_QUOTA_PERCENT = 100;
const MAX_CAP_USD = 100_000;
const MAX_PROJECTS = 100;
const MAX_PROJECT_NAME = 200;

const numberOf = (raw: unknown): unknown => (typeof raw === 'string' ? Number(raw.trim()) : raw);
const isBlank = (raw: unknown): boolean => raw === undefined || raw === null || raw === '';

/** Blank, zero or missing → undefined (no cap). Anything else must be a positive amount. */
function optionalAmount(raw: unknown, label: string): number | undefined {
  if (isBlank(raw)) return undefined;
  const value = numberOf(raw);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_CAP_USD) {
    throw new OpsInputError(`The ${label} must be an amount in US dollars between 0 and ${MAX_CAP_USD}.`);
  }
  return value === 0 ? undefined : value;
}

function validateProjects(raw: unknown): Record<string, number> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new OpsInputError('Project caps must map a project name to an amount.');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_PROJECTS) throw new OpsInputError(`At most ${MAX_PROJECTS} project caps.`);
  return Object.fromEntries(entries.flatMap(([rawName, rawAmount]) => {
    const name = rawName.trim();
    if (!name || name.length > MAX_PROJECT_NAME) throw new OpsInputError('Each project cap needs a project name.');
    const amount = optionalAmount(rawAmount, `cap for ${name}`);
    return amount === undefined ? [] : [[name, amount] as const];
  }));
}

function validateQuotaPercent(raw: unknown): number | undefined {
  if (isBlank(raw)) return undefined;
  const value = numberOf(raw);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_QUOTA_PERCENT || value > MAX_QUOTA_PERCENT) {
    throw new OpsInputError(`The quota threshold must be between ${MIN_QUOTA_PERCENT} and ${MAX_QUOTA_PERCENT} percent.`);
  }
  return Math.round(value);
}

export function validateSpendCap(raw: unknown): SpendCapConfig {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const dailyUsd = optionalAmount(body.dailyUsd, 'daily cap');
  const quotaPausePercent = validateQuotaPercent(body.quotaPausePercent);
  return {
    ...(dailyUsd !== undefined ? { dailyUsd } : {}),
    projects: validateProjects(body.projects),
    ...(quotaPausePercent !== undefined ? { quotaPausePercent } : {}),
    constrainRunning: body.constrainRunning !== false,
  };
}

function stateOf(spent: number, limit: number): SpendState {
  if (spent >= limit) return 'over';
  return spent >= limit * NEAR_FRACTION ? 'near' : 'ok';
}

export function evaluateSpend(config: SpendCapConfig, spend: readonly ProjectSpend[], day: string): SpendStatus {
  const totalUsd = spend.reduce((sum, row) => sum + row.costUsd, 0);
  const byProject = new Map(spend.map((row) => [row.project, row.costUsd]));
  const fleet: SpendScope[] = config.dailyUsd === undefined ? []
    : [{ scope: 'fleet', spentUsd: totalUsd, limitUsd: config.dailyUsd, state: stateOf(totalUsd, config.dailyUsd) }];
  const projects = Object.entries(config.projects)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([project, limitUsd]): SpendScope => {
      const spentUsd = byProject.get(project) ?? 0;
      return { scope: 'project', project, spentUsd, limitUsd, state: stateOf(spentUsd, limitUsd) };
    });
  return { day, totalUsd, scopes: [...fleet, ...projects] };
}

/** The fullest plan window the vendor reported, when it is at or above the threshold. */
export function quotaPressure(vendors: readonly VendorWindows[], vendor: string, threshold: number | undefined): QuotaPressure | undefined {
  if (threshold === undefined) return undefined;
  const limits = vendors.find((entry) => entry.vendor === vendor)?.limits ?? [];
  const readings = limits.flatMap((limit): QuotaPressure[] => {
    const usedPercent = limit.status === 'rejected' ? MAX_QUOTA_PERCENT : limit.usedPercent;
    if (usedPercent === undefined) return [];
    return [{ vendor, label: limit.label, usedPercent, ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}) }];
  });
  const fullest = [...readings].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  return fullest && fullest.usedPercent >= threshold ? fullest : undefined;
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;
const vendorName = (vendor: string): string => vendor.charAt(0).toUpperCase() + vendor.slice(1);

function resetText(resetsAt: number | undefined): string {
  if (resetsAt === undefined) return '';
  const time = new Date(resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return ` It resets at ${time}.`;
}

export function scopeLabel(scope: SpendScope): string {
  return scope.scope === 'fleet' ? 'All agents' : `Project ${scope.project}`;
}

export function overReason(scope: SpendScope): string {
  return `Spend cap: ${scopeLabel(scope)} spent about ${money(scope.spentUsd)} today, over the ${money(scope.limitUsd)} daily cap`;
}

/** The exceeded scopes that cover an agent in `project`. */
export function exceededFor(status: SpendStatus, project: string): SpendScope | undefined {
  return status.scopes.find((scope) => scope.state === 'over' && (scope.scope === 'fleet' || scope.project === project));
}

/**
 * Why a schedule run or factory stage should wait instead of launching now, or undefined when it may go.
 * Manual launches by the operator are never blocked; they only see the warning.
 */
export function automatedLaunchBlock(status: SpendStatus, pressure: QuotaPressure | undefined, project: string): string | undefined {
  const over = exceededFor(status, project);
  if (over) return `${overReason(over)}.`;
  if (pressure) return `${vendorName(pressure.vendor)} ${pressure.label} window is at ${Math.round(pressure.usedPercent)}%.${resetText(pressure.resetsAt)}`;
  return undefined;
}
