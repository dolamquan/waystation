import { ChannelError } from './board.ts';

/** Validation of request bodies (operator UI and agent CLI) at the channel boundary. */

const MAX_NAME = 64;
const MAX_PURPOSE = 500;
const MAX_ID = 64;
export const DEFAULT_WAIT_SECONDS = 60;
/** Below undici's 300s response timeout, so a CLI on fetch never sees a wait cut off. */
export const MAX_WAIT_SECONDS = 240;

export const fieldsOf = (raw: unknown): Record<string, unknown> =>
  (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;

export function requiredText(fields: Record<string, unknown>, key: string, max: number): string {
  const value = fields[key];
  if (typeof value !== 'string' || !value.trim()) throw new ChannelError(`${key} is required.`);
  if (value.length > max) throw new ChannelError(`${key} is too long (at most ${max} characters).`);
  return value;
}

export function optionalText(fields: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = fields[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ChannelError(`${key} must be text.`);
  if (value.length > max) throw new ChannelError(`${key} is too long (at most ${max} characters).`);
  return value.trim() || undefined;
}

export function parseCreate(raw: unknown): { name: string; purpose: string } {
  const fields = fieldsOf(raw);
  return { name: requiredText(fields, 'name', MAX_NAME), purpose: optionalText(fields, 'purpose', MAX_PURPOSE) ?? '' };
}

export function parseAddMember(raw: unknown): { agentId: string; name?: string } {
  const fields = fieldsOf(raw);
  return { agentId: requiredText(fields, 'agentId', 200), name: optionalText(fields, 'name', MAX_NAME) };
}

/** `text` length is checked by the board (one limit for every sender). */
export function parseSend(raw: unknown): { to: string; text: string; wake: boolean; replyTo?: string; channel?: string } {
  const fields = fieldsOf(raw);
  if (typeof fields.text !== 'string') throw new ChannelError('text is required.');
  return {
    to: requiredText(fields, 'to', MAX_NAME).trim().toLowerCase(),
    text: fields.text,
    wake: fields.wake !== false,
    replyTo: optionalText(fields, 'replyTo', MAX_ID),
    channel: parseChannelRef(fields),
  };
}

export function parseWait(raw: unknown): { from?: string; timeoutSeconds: number; channel?: string } {
  const fields = fieldsOf(raw);
  const seconds = typeof fields.timeoutSeconds === 'number' && Number.isFinite(fields.timeoutSeconds)
    ? Math.round(fields.timeoutSeconds) : DEFAULT_WAIT_SECONDS;
  return {
    from: optionalText(fields, 'from', MAX_NAME)?.toLowerCase(),
    timeoutSeconds: Math.min(Math.max(seconds, 1), MAX_WAIT_SECONDS),
    channel: parseChannelRef(fields),
  };
}

export const parseChannelRef = (fields: Record<string, unknown>): string | undefined =>
  optionalText(fields, 'channel', MAX_NAME)?.replace(/^#/, '').toLowerCase();
