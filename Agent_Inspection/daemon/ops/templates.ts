import { randomUUID } from 'node:crypto';
import { parseLoadout } from '../library/loadout.ts';
import { LibraryInputError, type LaunchLoadout } from '../library/types.ts';
import { isValidModelName } from '../managed/modelName.ts';

export class OpsInputError extends Error {}

/** A saved starting point for New agent. Using one only fills in the form; a person still launches. */
export interface AgentTemplate {
  readonly id: string;
  /** What the template is called in the picker, e.g. "Reviewer on Haiku". */
  readonly label: string;
  readonly vendor: 'claude' | 'codex';
  readonly model?: string;
  /** Name given to agents launched from it. */
  readonly agentName?: string;
  /** Standing role instructions (appended to the system prompt; Codex gets them ahead of the first turn). */
  readonly instructions?: string;
  /** A default first task. */
  readonly prompt?: string;
  readonly intercept: boolean;
  /** Skills, context docs, MCP servers, plugins and notify channels to launch with (library ids). */
  readonly loadout?: LaunchLoadout;
  readonly createdAt: number;
}

export const MAX_INSTRUCTIONS_CHARS = 8000;
const MAX_LABEL_CHARS = 60;
const MAX_NAME_CHARS = 80;
const MAX_PROMPT_CHARS = 20_000;

export const optionalText = (value: unknown, field: string, max: number): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new OpsInputError(`${field} must be text`);
  const text = value.trim();
  if (text.length > max) throw new OpsInputError(`${field} is too long (max ${max} characters)`);
  return text || undefined;
};

export function optionalModel(value: unknown): string | undefined {
  const model = optionalText(value, 'model', 64);
  if (model && !isValidModelName(model)) throw new OpsInputError('model name looks invalid');
  return model;
}

/** parseLoadout, but reporting bad input the way the rest of ops does. */
function templateLoadout(raw: unknown): LaunchLoadout | undefined {
  try {
    return parseLoadout(raw);
  } catch (error) {
    if (error instanceof LibraryInputError) throw new OpsInputError(error.message);
    throw error;
  }
}

export function validateTemplate(raw: unknown, now = Date.now()): AgentTemplate {
  const body = (raw ?? {}) as Record<string, unknown>;
  const label = optionalText(body.label, 'label', MAX_LABEL_CHARS);
  if (!label) throw new OpsInputError('label is required');
  if (body.vendor !== 'claude' && body.vendor !== 'codex') throw new OpsInputError('vendor must be "claude" or "codex"');
  return {
    id: `tpl_${randomUUID().slice(0, 8)}`,
    label,
    vendor: body.vendor,
    model: optionalModel(body.model),
    agentName: optionalText(body.agentName, 'agentName', MAX_NAME_CHARS),
    instructions: optionalText(body.instructions, 'instructions', MAX_INSTRUCTIONS_CHARS),
    prompt: optionalText(body.prompt, 'prompt', MAX_PROMPT_CHARS),
    intercept: body.vendor === 'claude' && body.intercept === true,
    loadout: templateLoadout(body.loadout),
    createdAt: now,
  };
}
