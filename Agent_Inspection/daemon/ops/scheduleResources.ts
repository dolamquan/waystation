import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { INBOX_CHANNEL_ID, type LaunchLoadout, type ResourceKind, type ScheduleNotify, type ScheduleResource } from '../library/types.ts';
import type { Schedule, ScheduledLaunch } from './schedules.ts';
import { OpsInputError } from './templates.ts';

export const MAX_RESOURCES = 30;
export const MAX_NOTE_CHARS = 4000;
export const MAX_RESOURCE_LABEL_CHARS = 80;
export const MAX_UPLOAD_BYTES = 512 * 1024;
const MAX_VALUE_CHARS = 2000;
const MAX_FILENAME_CHARS = 120;
const MAX_CHANNELS = 20;
const KINDS: readonly ResourceKind[] = ['url', 'github', 'file', 'folder', 'note'];
const RESOURCE_ID = /^res_[0-9a-f]{8}$/;
const SCHEDULE_ID = /^sch_[0-9a-f]{8}$/;
const CHANNEL_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const GITHUB_REF = /^[A-Za-z0-9._/-]{1,200}$/;
const BASE64 = /^[A-Za-z0-9+/\r\n]*={0,2}\s*$/;
const NOT_FILENAME_CHAR = /[^A-Za-z0-9._ -]/g;

export const newResourceId = (): string => `res_${randomBytes(4).toString('hex')}`;

export interface ResourceCheck {
  /** Whether an absolute path exists. Injected so tests and run-time re-checks share the logic. */
  readonly exists: (path: string) => boolean;
}

const fsCheck: ResourceCheck = { exists: (path) => existsSync(path) };

/** "owner/repo", "owner/repo@ref" or a github.com URL, as "owner/repo[@ref]". */
export function normalizeGithub(raw: string): string {
  let text = raw.trim();
  let ref: string | undefined;
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/tree\/([^\s#?]+))?\/?(?:[#?].*)?$/i.exec(text);
  if (url) {
    text = `${url[1]}/${url[2].replace(/\.git$/i, '')}`;
    ref = url[3]?.replace(/\/+$/, '');
  } else {
    const at = text.indexOf('@');
    if (at >= 0) {
      ref = text.slice(at + 1).trim();
      text = text.slice(0, at).trim();
    }
  }
  const [owner, repo, ...rest] = text.split('/');
  if (rest.length || !owner || !repo || !GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) {
    throw new OpsInputError('GitHub resources must be "owner/repo", "owner/repo@branch" or a github.com link');
  }
  if (ref !== undefined && (!GITHUB_REF.test(ref) || ref.includes('..'))) throw new OpsInputError('GitHub branch or tag looks invalid');
  return ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;
}

function validateUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OpsInputError(`"${raw.slice(0, 80)}" is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OpsInputError('URL resources must start with http:// or https://');
  return url.toString();
}

function validatePath(raw: string, kind: 'file' | 'folder', check: ResourceCheck): string {
  const path = raw.trim();
  if (!isAbsolute(path)) throw new OpsInputError(`${kind} resources need an absolute path (got "${path.slice(0, 80)}")`);
  if (!check.exists(path)) throw new OpsInputError(`${kind === 'file' ? 'File' : 'Folder'} not found: ${path}`);
  return path;
}

function validateValue(kind: ResourceKind, raw: unknown, check: ResourceCheck): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new OpsInputError(`a ${kind} resource needs a value`);
  if (kind === 'note') {
    if (raw.trim().length > MAX_NOTE_CHARS) throw new OpsInputError(`notes are limited to ${MAX_NOTE_CHARS} characters`);
    return raw.trim();
  }
  if (raw.length > MAX_VALUE_CHARS) throw new OpsInputError(`a ${kind} resource is too long`);
  if (kind === 'url') return validateUrl(raw);
  if (kind === 'github') return normalizeGithub(raw);
  return validatePath(raw, kind, check);
}

export function validateResource(raw: unknown, check: ResourceCheck = fsCheck): ScheduleResource {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = body.kind as ResourceKind;
  if (!KINDS.includes(kind)) throw new OpsInputError(`resource kind must be one of ${KINDS.join(', ')}`);
  if (body.label !== undefined && body.label !== null && typeof body.label !== 'string') throw new OpsInputError('resource label must be text');
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (label.length > MAX_RESOURCE_LABEL_CHARS) throw new OpsInputError(`resource labels are limited to ${MAX_RESOURCE_LABEL_CHARS} characters`);
  const id = typeof body.id === 'string' && RESOURCE_ID.test(body.id) ? body.id : newResourceId();
  return { id, kind, ...(label ? { label } : {}), value: validateValue(kind, body.value, check) };
}

export function validateResources(raw: unknown, check: ResourceCheck = fsCheck): ScheduleResource[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new OpsInputError('resources must be a list');
  if (raw.length > MAX_RESOURCES) throw new OpsInputError(`a schedule can have at most ${MAX_RESOURCES} resources`);
  const resources = raw.map((item) => validateResource(item, check));
  const seen = new Set<string>();
  return resources.map((resource) => {
    const unique = seen.has(resource.id) ? { ...resource, id: newResourceId() } : resource;
    seen.add(unique.id);
    return unique;
  });
}

export function validateNotify(raw: unknown): ScheduleNotify | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new OpsInputError('notify must be an object');
  const body = raw as Record<string, unknown>;
  const when = body.when ?? 'always';
  if (when !== 'always' && when !== 'failure' && when !== 'never') throw new OpsInputError('notify.when must be "always", "failure" or "never"');
  const ids = body.channelIds ?? [];
  if (!Array.isArray(ids) || ids.length > MAX_CHANNELS || !ids.every((id): id is string => typeof id === 'string' && CHANNEL_ID.test(id))) {
    throw new OpsInputError('notify.channelIds must be a list of channel ids');
  }
  return { channelIds: [...new Set(ids)], when };
}

// ---- prompt composition -------------------------------------------------------------------------

const DONE_LINE = 'When you finish, end with a concise summary of what you found or changed.';

function githubLine(value: string): string {
  const [repo, ref] = value.split('@');
  const clone = `git clone https://github.com/${repo}`;
  const at = ref ? ` Then check out \`${ref}\`.` : '';
  return `GitHub repo \`${repo}\`${ref ? ` (at \`${ref}\`)` : ''}: if it is not already checked out in the working folder, clone it with \`${clone}\`; otherwise run \`git pull\` in the existing checkout.${at}`;
}

export function describeResource(resource: ScheduleResource, check: ResourceCheck = fsCheck): string {
  const prefix = resource.label ? `**${resource.label}**: ` : '';
  const missing = (kind: string) => (check.exists(resource.value) ? '' : ` (WARNING: this ${kind} was not found when the run started; say so in your summary)`);
  switch (resource.kind) {
    case 'github': return `- ${prefix}${githubLine(resource.value)}`;
    case 'url': return `- ${prefix}Web page ${resource.value}: fetch and read it (scrape it if the task asks for data from it).`;
    case 'file': return `- ${prefix}File \`${resource.value}\`${missing('file')}`;
    case 'folder': return `- ${prefix}Folder \`${resource.value}\`${missing('folder')}`;
    case 'note': return `- ${prefix}Note: ${resource.value}`;
  }
}

/** True when the schedule's outcome may be sent somewhere. */
export const notifies = (notify: ScheduleNotify | undefined): notify is ScheduleNotify => !!notify && notify.when !== 'never';

/** The task prompt with the resources and the closing summary request appended. */
export function composePrompt(schedule: Pick<Schedule, 'launch' | 'resources' | 'notify'>, check: ResourceCheck = fsCheck): string {
  const parts = [schedule.launch.prompt];
  if (schedule.resources.length) {
    parts.push(`## Resources for this task\n${schedule.resources.map((resource) => describeResource(resource, check)).join('\n')}`);
  }
  if (notifies(schedule.notify)) parts.push(DONE_LINE);
  return parts.join('\n\n');
}

/** The loadout with the schedule's notify channels added, so the agent gets the notify tool. */
export function composeLoadout(launch: ScheduledLaunch, notify: ScheduleNotify | undefined): LaunchLoadout | undefined {
  if (!notifies(notify)) return launch.loadout;
  // The agent posts progress to the inbox only; the run watcher delivers the outcome to the schedule's
  // channels per `notify.when`. Granting those channels to the agent would double-post and ignore 'failure'.
  const channels = [...new Set([...(launch.loadout?.notifyChannelIds ?? []), INBOX_CHANNEL_ID])];
  return { ...launch.loadout, notifyChannelIds: channels };
}

/** What `deps.launch` receives when the schedule fires. */
export function composeLaunch(schedule: Schedule, check: ResourceCheck = fsCheck): ScheduledLaunch & { readonly name: string } {
  const loadout = composeLoadout(schedule.launch, schedule.notify);
  return {
    ...schedule.launch,
    prompt: composePrompt(schedule, check),
    name: schedule.launch.name ?? schedule.label,
    ...(loadout ? { loadout } : {}),
  };
}

// ---- uploaded files -----------------------------------------------------------------------------

/** The folder holding a schedule's uploads, refusing anything that would land outside `root`. */
export function scheduleResourceDir(root: string, scheduleId: string): string {
  if (!SCHEDULE_ID.test(scheduleId)) throw new OpsInputError('invalid schedule id');
  const base = resolve(root);
  const dir = resolve(base, scheduleId);
  const rel = relative(base, dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new OpsInputError('invalid schedule id');
  return dir;
}

export function sanitizeFilename(raw: unknown): string {
  if (typeof raw !== 'string') throw new OpsInputError('filename is required');
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(NOT_FILENAME_CHAR, '_').trim().slice(0, MAX_FILENAME_CHARS).trim();
  if (!cleaned || /^\.+$/.test(cleaned)) throw new OpsInputError('filename is invalid');
  // Windows device names (CON, NUL, COM1…) and trailing dots don't name a real file.
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned) || /[. ]$/.test(cleaned)) throw new OpsInputError('filename is invalid');
  return cleaned;
}

export function decodeUpload(raw: unknown): Buffer {
  if (typeof raw !== 'string' || !BASE64.test(raw)) throw new OpsInputError('contentBase64 must be base64 text');
  // Base64 is 4 chars per 3 bytes: refuse before decoding anything clearly too big.
  if (raw.replace(/\s/g, '').length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4) throw new OpsInputError('files are limited to 512 KB');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new OpsInputError('files are limited to 512 KB');
  return bytes;
}

function freeName(dir: string, filename: string): string {
  if (!existsSync(join(dir, filename))) return filename;
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  throw new OpsInputError('too many files with that name');
}

/** Saves an upload into the schedule's folder (never overwriting) and returns its absolute path. */
export function saveUpload(root: string, scheduleId: string, rawName: unknown, rawContent: unknown): string {
  const bytes = decodeUpload(rawContent);
  const dir = scheduleResourceDir(root, scheduleId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, freeName(dir, sanitizeFilename(rawName)));
  writeFileSync(path, bytes, { flag: 'wx' });
  return path;
}

/** Deletes uploads no resource refers to any more. Best-effort. */
export function pruneUploads(root: string, scheduleId: string, resources: readonly ScheduleResource[]): void {
  try {
    const dir = scheduleResourceDir(root, scheduleId);
    if (!existsSync(dir)) return;
    const kept = new Set(resources.filter((resource) => resource.kind === 'file').map((resource) => resolve(resource.value).toLowerCase()));
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (!kept.has(resolve(path).toLowerCase())) rmSync(path, { force: true, recursive: true });
    }
  } catch {
    // A leftover upload costs only disk space.
  }
}

/** Removes the schedule's uploads folder. Best-effort. */
export function removeScheduleResources(root: string, scheduleId: string): void {
  try {
    rmSync(scheduleResourceDir(root, scheduleId), { recursive: true, force: true });
  } catch {
    // A leftover folder costs only disk space.
  }
}
