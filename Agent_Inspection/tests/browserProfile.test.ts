import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_PROFILE, mergeProfile, profileChanges, readProfile, writeProfile, type ProfileState } from '../daemon/browser/browserProfile.ts';

const cookie = (name: string, value: string) =>
  ({ name, value, domain: '.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' as const });
const profile = (...cookies: ReturnType<typeof cookie>[]): ProfileState => ({ cookies, origins: [] });

describe('shared browser profile', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('keeps a sign-in from one tile when another tile saves unrelated changes', () => {
    const signedIn = mergeProfile(EMPTY_PROFILE, profileChanges(EMPTY_PROFILE, profile(cookie('SID', 'abc'))));
    const otherTile = profileChanges(EMPTY_PROFILE, profile(cookie('PREF', 'dark')));
    expect(mergeProfile(signedIn, otherTile).cookies.map(c => c.name).sort()).toEqual(['PREF', 'SID']);
  });

  it('applies a sign-out and does not let a stale tile restore it', () => {
    const shared = profile(cookie('SID', 'abc'), cookie('PREF', 'dark'));
    const signedOut = mergeProfile(shared, profileChanges(shared, profile(cookie('PREF', 'dark'))));
    expect(signedOut.cookies.map(c => c.name)).toEqual(['PREF']);
    // A tile that still holds the unchanged SID cookie did not change it, so it writes nothing back.
    expect(mergeProfile(signedOut, profileChanges(shared, shared)).cookies.map(c => c.name)).toEqual(['PREF']);
  });

  it('records changed cookie values', () => {
    const changes = profileChanges(profile(cookie('SID', 'old')), profile(cookie('SID', 'new')));
    expect(changes.changed).toEqual([cookie('SID', 'new')]);
    expect(changes.removed).toEqual([]);
  });

  it('round-trips through disk and starts signed out from missing or malformed files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'browser-profile-')); dirs.push(dir);
    const file = join(dir, 'nested', 'profile.json');
    expect(await readProfile(file)).toEqual(EMPTY_PROFILE);
    const saved = profile(cookie('SID', 'abc'));
    await writeProfile(file, saved);
    expect(await readProfile(file)).toEqual(saved);
    writeFileSync(file, '{"cookies":[{"name":1}],"origins":[]}');
    expect(await readProfile(file)).toEqual(EMPTY_PROFILE);
  });
});
