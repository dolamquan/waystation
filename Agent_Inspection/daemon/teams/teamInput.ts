import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { EVERYONE, OPERATOR, SYSTEM, type TeamRole, type TeamVendor } from './types.ts';
import { isValidModelName } from '../managed/modelName.ts';
import { parseLoadout } from '../library/loadout.ts';
import { LibraryInputError, type LaunchLoadout } from '../library/types.ts';

export class TeamInputError extends Error {}

export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 6;
const MAX_GOAL_CHARS = 8000;
export const MAX_FOCUS_CHARS = 2000;
const DEFAULT_MAX_WAKES = 40;
const MAX_WAKES_LIMIT = 300;
const DEFAULT_MAX_MINUTES = 60;
const MAX_MINUTES_LIMIT = 8 * 60;
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;
const RESERVED_NAMES = new Set([EVERYONE, OPERATOR, SYSTEM]);

export interface MemberInput {
  readonly name: string;
  readonly role: TeamRole;
  readonly vendor: TeamVendor;
  readonly model?: string;
  /** What the member is responsible for, in the operator's words. */
  readonly focus?: string;
  readonly loadout?: LaunchLoadout;
}

export interface TeamInput {
  readonly name: string;
  readonly goal: string;
  readonly cwd: string;
  readonly initGit: boolean;
  readonly intercept: boolean;
  readonly maxWakes: number;
  readonly maxMinutes: number;
  /** Default true: the lead's plan waits for the operator before workers are woken. */
  readonly requirePlanApproval: boolean;
  readonly members: readonly MemberInput[];
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

function boundedInt(value: unknown, fallback: number, max: number, label: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new TeamInputError(`${label} must be a whole number from 1 to ${max}`);
  return n;
}

function parseMember(raw: unknown, index: number): MemberInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const name = text(body.name).toLowerCase() || `member-${index + 1}`;
  if (!NAME_PATTERN.test(name)) throw new TeamInputError(`member name "${name}" must start with a letter and use only a-z, 0-9 and dashes (max 24)`);
  if (RESERVED_NAMES.has(name)) throw new TeamInputError(`"${name}" is a reserved name`);
  const role = body.role === 'lead' ? 'lead' : body.role === 'worker' || body.role === undefined ? 'worker' : undefined;
  if (!role) throw new TeamInputError(`member "${name}": role must be lead or worker`);
  const vendor = body.vendor === 'codex' ? 'codex' : body.vendor === 'claude' ? 'claude' : undefined;
  if (!vendor) throw new TeamInputError(`member "${name}": vendor must be claude or codex`);
  const model = text(body.model) || undefined;
  if (model && !isValidModelName(model)) throw new TeamInputError(`member "${name}": model name looks invalid`);
  const focus = parseFocus(body.focus, name);
  const loadout = memberLoadout(body.loadout, name);
  return { name, role, vendor, model, ...(focus ? { focus } : {}), ...(loadout ? { loadout } : {}) };
}

function parseFocus(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new TeamInputError(`member "${name}": focus must be text`);
  const focus = value.trim();
  if (focus.length > MAX_FOCUS_CHARS) throw new TeamInputError(`member "${name}": focus must be at most ${MAX_FOCUS_CHARS} characters`);
  return focus || undefined;
}

function memberLoadout(value: unknown, name: string): LaunchLoadout | undefined {
  try {
    return parseLoadout(value);
  } catch (error) {
    if (error instanceof LibraryInputError) throw new TeamInputError(`member "${name}": ${error.message}`);
    throw error;
  }
}

function parseFlag(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new TeamInputError(`${label} must be true or false`);
  return value;
}

export function parseTeamInput(raw: unknown): TeamInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const goal = text(body.goal);
  if (!goal) throw new TeamInputError('Describe the team goal.');
  if (goal.length > MAX_GOAL_CHARS) throw new TeamInputError('The goal is too long.');
  const cwd = text(body.cwd);
  if (!cwd || !isAbsolute(cwd)) throw new TeamInputError('Project folder must be an absolute path.');
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new TeamInputError(`Folder not found: ${cwd}`);
  if (!Array.isArray(body.members)) throw new TeamInputError('members must be a list');
  if (body.members.length < MIN_MEMBERS || body.members.length > MAX_MEMBERS) {
    throw new TeamInputError(`A team needs ${MIN_MEMBERS} to ${MAX_MEMBERS} members.`);
  }
  const members = body.members.map(parseMember);
  if (members.filter((m) => m.role === 'lead').length !== 1) throw new TeamInputError('A team needs exactly one lead.');
  if (new Set(members.map((m) => m.name)).size !== members.length) throw new TeamInputError('Member names must be unique.');
  return {
    name: (text(body.name) || 'Team').slice(0, 60),
    goal,
    cwd,
    initGit: body.initGit === true,
    intercept: body.intercept === true,
    maxWakes: boundedInt(body.maxWakes, DEFAULT_MAX_WAKES, MAX_WAKES_LIMIT, 'Wake-up budget'),
    maxMinutes: boundedInt(body.maxMinutes, DEFAULT_MAX_MINUTES, MAX_MINUTES_LIMIT, 'Time limit'),
    requirePlanApproval: parseFlag(body.requirePlanApproval, true, 'requirePlanApproval'),
    members,
  };
}

export const slug = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'team';
