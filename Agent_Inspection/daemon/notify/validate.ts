import { LibraryInputError, type NotifyLevel, type NotifyMessage } from '../library/types.ts';
import { CHANNEL_SPECS, isExternalKind } from './channels/index.ts';
import { clip } from './channels/http.ts';
import type { ChannelSpec, CleanMessage, ExternalKind } from './channels/types.ts';

export const LABEL_MAX = 60;
export const CONFIG_VALUE_MAX = 500;
export const SECRET_VALUE_MAX = 2000;
export const TITLE_MAX = 200;
export const BODY_MAX = 8000;
const SOURCE_MAX = 120;
const LEVELS: readonly NotifyLevel[] = ['info', 'success', 'warning', 'error'];
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A channel as stored in 'notify_channels' (secrets live in the SecretStore). */
export interface ChannelRecord {
  readonly id: string;
  readonly kind: ExternalKind;
  readonly label: string;
  readonly config: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly lastSentAt?: number;
  readonly lastError?: string;
}

/** A validated create/update request. `secrets`: "" deletes that secret, omitted keeps it. */
export interface ChannelChange {
  readonly kind: ExternalKind;
  readonly label?: string;
  readonly config?: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly enabled?: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!label || label.length > LABEL_MAX || CONTROL.test(label)) throw new LibraryInputError(`label must be 1-${LABEL_MAX} characters on one line`);
  return label;
}

function parseStrings(value: unknown, allowed: readonly string[], what: string, max: number): Record<string, string> {
  if (value === undefined) return {};
  if (!isObject(value)) throw new LibraryInputError(`${what} must be an object`);
  return Object.fromEntries(Object.entries(value).map(([key, raw]) => {
    if (!allowed.includes(key)) throw new LibraryInputError(`unknown ${what} "${clip(key, 40)}"`);
    if (typeof raw !== 'string') throw new LibraryInputError(`${what} "${key}" must be text`);
    const text = raw.trim();
    if (text.length > max) throw new LibraryInputError(`${what} "${key}" is longer than ${max} characters`);
    return [key, text];
  }));
}

const parseConfig = (spec: ChannelSpec, value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(parseStrings(value, spec.configKeys, 'setting', CONFIG_VALUE_MAX)).filter(([, text]) => text !== ''));

function parseEnabled(value: unknown): boolean | undefined {
  if (value === undefined || typeof value === 'boolean') return value;
  throw new LibraryInputError('enabled must be true or false');
}

export function parseChannelCreate(raw: unknown): ChannelChange & { readonly label: string } {
  const body = isObject(raw) ? raw : {};
  if (body.kind === 'inbox') throw new LibraryInputError('the Updates inbox always exists and cannot be added');
  if (!isExternalKind(body.kind)) throw new LibraryInputError(`kind must be one of: ${Object.keys(CHANNEL_SPECS).join(', ')}`);
  const spec = CHANNEL_SPECS[body.kind];
  return {
    kind: body.kind,
    label: parseLabel(body.label),
    config: parseConfig(spec, body.config),
    secrets: parseStrings(body.secrets, spec.secretNames, 'secret', SECRET_VALUE_MAX),
    enabled: parseEnabled(body.enabled) ?? true,
  };
}

export function parseChannelUpdate(raw: unknown, kind: ExternalKind): ChannelChange {
  const body = isObject(raw) ? raw : {};
  if (body.kind !== undefined && body.kind !== kind) throw new LibraryInputError('a channel’s kind cannot change; add a new channel instead');
  const spec = CHANNEL_SPECS[kind];
  return {
    kind,
    label: body.label === undefined ? undefined : parseLabel(body.label),
    config: body.config === undefined ? undefined : parseConfig(spec, body.config),
    secrets: parseStrings(body.secrets, spec.secretNames, 'secret', SECRET_VALUE_MAX),
    enabled: parseEnabled(body.enabled),
  };
}

/** Checks the settings a channel would end up with. */
export function validateChannel(kind: ExternalKind, config: Readonly<Record<string, string>>, secrets: Readonly<Record<string, string | undefined>>): void {
  const spec = CHANNEL_SPECS[kind];
  const missingConfig = spec.requiredConfig.filter((key) => !config[key]);
  if (missingConfig.length > 0) throw new LibraryInputError(`missing setting: ${missingConfig.join(', ')}`);
  const missingSecrets = spec.requiredSecrets.filter((name) => !secrets[name]);
  if (missingSecrets.length > 0) throw new LibraryInputError(`missing secret: ${missingSecrets.join(', ')}`);
  spec.validate(config, secrets);
}

const text = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));

/** Never throws: whatever arrives becomes a deliverable message. */
export function cleanMessage(message: NotifyMessage, ts: number): CleanMessage {
  const title = clip(text(message?.title).replace(/\s+/g, ' ').trim(), TITLE_MAX) || 'Update';
  const level = LEVELS.includes(message?.level as NotifyLevel) ? message.level as NotifyLevel : 'info';
  const source = clip(text(message?.source).replace(/\s+/g, ' ').trim(), SOURCE_MAX) || 'waystation';
  const agentId = typeof message?.agentId === 'string' && message.agentId ? clip(message.agentId, 200) : undefined;
  return { title, body: clip(text(message?.body).trim(), BODY_MAX), level, source, ...(agentId ? { agentId } : {}), ts };
}

/** What an agent (or the operator's manual send) may post: title required, body and level optional. */
export function parsePostedMessage(raw: unknown): Pick<NotifyMessage, 'title' | 'body' | 'level'> {
  const body = isObject(raw) ? raw : {};
  if (typeof body.title !== 'string' || !body.title.trim()) throw new LibraryInputError('title is required');
  if (body.body !== undefined && typeof body.body !== 'string') throw new LibraryInputError('body must be text');
  if (body.level !== undefined && !LEVELS.includes(body.level as NotifyLevel)) throw new LibraryInputError(`level must be one of: ${LEVELS.join(', ')}`);
  return { title: body.title, body: typeof body.body === 'string' ? body.body : '', level: body.level as NotifyLevel | undefined };
}
