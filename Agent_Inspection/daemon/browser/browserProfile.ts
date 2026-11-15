import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BrowserContext } from 'playwright-core';

/** Cookies and site storage shared by every browser tile, so a sign-in survives tiles and restarts. */
export type ProfileState = Awaited<ReturnType<BrowserContext['storageState']>>;
type Cookie = ProfileState['cookies'][number];

const MAX_PROFILE_BYTES = 20 * 1024 * 1024;
export const EMPTY_PROFILE: ProfileState = { cookies: [], origins: [] };

const cookieKey = (cookie: Cookie): string => `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;
const sameCookie = (a: Cookie, b: Cookie): boolean =>
  a.value === b.value && a.expires === b.expires && a.httpOnly === b.httpOnly && a.secure === b.secure && a.sameSite === b.sameSite;

function isProfile(value: unknown): value is ProfileState {
  if (!value || typeof value !== 'object') return false;
  const { cookies, origins } = value as Partial<ProfileState>;
  return Array.isArray(cookies) && Array.isArray(origins)
    && cookies.every(cookie => cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string'
      && typeof cookie.domain === 'string' && typeof cookie.path === 'string' && typeof cookie.expires === 'number')
    && origins.every(origin => origin && typeof origin.origin === 'string' && Array.isArray(origin.localStorage));
}

/** Changes one tile made since it loaded `baseline`: cookies it set or changed, and cookies it removed. */
export interface ProfileChanges {
  readonly changed: readonly Cookie[];
  readonly removed: readonly Cookie[];
  readonly origins: ProfileState['origins'];
}

export function profileChanges(baseline: ProfileState, current: ProfileState): ProfileChanges {
  const before = new Map(baseline.cookies.map(cookie => [cookieKey(cookie), cookie]));
  const now = new Map(current.cookies.map(cookie => [cookieKey(cookie), cookie]));
  return {
    changed: current.cookies.filter(cookie => { const old = before.get(cookieKey(cookie)); return !old || !sameCookie(old, cookie); }),
    removed: baseline.cookies.filter(cookie => !now.has(cookieKey(cookie))),
    origins: current.origins,
  };
}

/** Applies one tile's changes to the shared profile without undoing another tile's sign-in or sign-out. */
export function mergeProfile(shared: ProfileState, changes: ProfileChanges): ProfileState {
  const cookies = new Map(shared.cookies.map(cookie => [cookieKey(cookie), cookie]));
  for (const cookie of changes.removed) cookies.delete(cookieKey(cookie));
  for (const cookie of changes.changed) cookies.set(cookieKey(cookie), cookie);
  const origins = new Map(shared.origins.map(origin => [origin.origin, origin]));
  for (const origin of changes.origins) origins.set(origin.origin, origin);
  return { cookies: [...cookies.values()], origins: [...origins.values()] };
}

/** Reads the saved profile; a missing, oversized or malformed file starts signed out. */
export async function readProfile(file: string): Promise<ProfileState> {
  try {
    if ((await stat(file)).size > MAX_PROFILE_BYTES) return EMPTY_PROFILE;
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return isProfile(parsed) ? parsed : EMPTY_PROFILE;
  } catch {
    return EMPTY_PROFILE;
  }
}

/** Atomic write, readable only by the operator where the platform supports file modes (it holds sign-in cookies). */
export async function writeProfile(file: string, profile: ProfileState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(profile), { mode: 0o600 });
  await rename(temporary, file);
}
