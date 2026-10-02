import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { EVERYONE, OPERATOR, SYSTEM, type TeamRole, type TeamVendor } from './types.ts';

export class TeamInputError extends Error {}

export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 6;
const MAX_GOAL_CHARS = 8000;
const DEFAULT_MAX_WAKES = 40;
const MAX_WAKES_LIMIT = 300;
const DEFAULT_MAX_MINUTES = 60;
const MAX_MINUTES_LIMIT = 8 * 60;
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
const RESERVED_NAMES = new Set([EVERYONE, OPERATOR, SYSTEM]);

export interface MemberInput {
  readonly name: string;
  readonly role: TeamRole;
  readonly vendor: TeamVendor;
  readonly model?: string;
}

export interface TeamInput {
  readonly name: string;
  readonly goal: string;
  readonly cwd: string;
  readonly initGit: boolean;
  readonly intercept: boolean;
  readonly maxWakes: number;
  readonly maxMinutes: number;
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
  if (model && !MODEL_PATTERN.test(model)) throw new TeamInputError(`member "${name}": model name looks invalid`);
  return { name, role, vendor, model };
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
    members,
  };
}

export const slug = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'team';
