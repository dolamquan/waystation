import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  composeLaunch, composeLoadout, composePrompt, decodeUpload, MAX_UPLOAD_BYTES, normalizeGithub, pruneUploads,
  removeScheduleResources, sanitizeFilename, saveUpload, scheduleResourceDir, validateNotify, validateResource, validateResources,
} from '../daemon/ops/scheduleResources.ts';
import { DEFAULT_OPTIONS, newSchedule, normalizeSchedule, validateMaxMinutes, type Schedule } from '../daemon/ops/schedules.ts';
import { OpsInputError } from '../daemon/ops/templates.ts';
import { tempDir } from './helpers.ts';

const yes = { exists: () => true };
const no = { exists: () => false };
const ABS = process.platform === 'win32' ? 'C:\\data\\report.csv' : '/data/report.csv';

describe('resource validation', () => {
  it('normalizes GitHub repos in every accepted form', () => {
    expect(normalizeGithub('octo/hello')).toBe('octo/hello');
    expect(normalizeGithub(' octo/hello@main ')).toBe('octo/hello@main');
    expect(normalizeGithub('https://github.com/octo/hello.git')).toBe('octo/hello');
    expect(normalizeGithub('github.com/octo/hello/tree/release/v2')).toBe('octo/hello@release/v2');
    expect(() => normalizeGithub('octo')).toThrow(OpsInputError);
    expect(() => normalizeGithub('a/b/c')).toThrow(/owner\/repo/);
    expect(() => normalizeGithub('octo/hello@../x')).toThrow(/branch/);
  });

  it('accepts only http(s) URLs, absolute existing paths and short notes', () => {
    expect(validateResource({ kind: 'url', value: 'https://example.com/a' }, yes).value).toBe('https://example.com/a');
    expect(() => validateResource({ kind: 'url', value: 'ftp://x.org' }, yes)).toThrow(/http/);
    expect(() => validateResource({ kind: 'url', value: 'not a url' }, yes)).toThrow(/valid URL/);
    expect(validateResource({ kind: 'file', value: ABS }, yes).value).toBe(ABS);
    expect(() => validateResource({ kind: 'file', value: 'rel/path.txt' }, yes)).toThrow(/absolute/);
    expect(() => validateResource({ kind: 'folder', value: ABS }, no)).toThrow(/Folder not found/);
    expect(() => validateResource({ kind: 'note', value: 'x'.repeat(4001) }, yes)).toThrow(/4000/);
    expect(() => validateResource({ kind: 'note', value: '  ' }, yes)).toThrow(/needs a value/);
    expect(() => validateResource({ kind: 'blob', value: 'x' }, yes)).toThrow(/kind/);
    expect(() => validateResource({ kind: 'note', value: 'x', label: 'l'.repeat(81) }, yes)).toThrow(/80/);
  });

  it('keeps valid ids, mints new ones otherwise, and caps the list at 30', () => {
    const [kept, minted, dup] = validateResources([
      { id: 'res_0123abcd', kind: 'note', value: 'a', label: ' Tip ' },
      { id: '../evil', kind: 'note', value: 'b' },
      { id: 'res_0123abcd', kind: 'note', value: 'c' },
    ], yes);
    expect(kept).toEqual({ id: 'res_0123abcd', kind: 'note', label: 'Tip', value: 'a' });
    expect(minted.id).toMatch(/^res_[0-9a-f]{8}$/);
    expect(dup.id).not.toBe('res_0123abcd');
    expect(validateResources(undefined)).toEqual([]);
    expect(() => validateResources('x')).toThrow(/list/);
    expect(() => validateResources(Array.from({ length: 31 }, () => ({ kind: 'note', value: 'n' })))).toThrow(/30/);
  });

  it('validates notify settings and max minutes', () => {
    expect(validateNotify(undefined)).toBeUndefined();
    expect(validateNotify({ channelIds: ['slack1', 'slack1'] })).toEqual({ channelIds: ['slack1'], when: 'always' });
    expect(() => validateNotify({ when: 'sometimes' })).toThrow(/when/);
    expect(() => validateNotify({ channelIds: ['bad id!'] })).toThrow(/channelIds/);
    expect(() => validateNotify([])).toThrow(/object/);
    expect(validateMaxMinutes(undefined)).toBe(60);
    expect(validateMaxMinutes(600)).toBe(600);
    expect(() => validateMaxMinutes(0)).toThrow(/1 to 600/);
    expect(() => validateMaxMinutes(1.5)).toThrow(OpsInputError);
  });
});

describe('backward compatibility', () => {
  it('fills defaults into records saved before resources existed', () => {
    const old = { id: 'sch_00000001', label: 'Old', enabled: true, days: [1], time: '09:00', launch: { vendor: 'claude', cwd: 'C:\\w', prompt: 'p' }, createdAt: 1 };
    expect(normalizeSchedule(old as unknown as Schedule)).toMatchObject({ resources: [], stopWhenDone: true, maxMinutes: 60 });
    expect(normalizeSchedule({ ...old, stopWhenDone: false, maxMinutes: 5 } as unknown as Schedule)).toMatchObject({ stopWhenDone: false, maxMinutes: 5 });
  });
});

describe('prompt composition', () => {
  const base = newSchedule({ label: 'Sync', enabled: true, days: [1], time: '09:00' }, { vendor: 'claude', cwd: 'C:\\w', prompt: 'Summarize changes.' }, 1, DEFAULT_OPTIONS);

  it('leaves a schedule without resources or notifications unchanged', () => {
    expect(composePrompt(base, yes)).toBe('Summarize changes.');
    expect(composeLaunch(base, yes)).toEqual({ ...base.launch, name: 'Sync' });
  });

  it('lists every resource by kind and flags missing paths', () => {
    const schedule: Schedule = {
      ...base,
      resources: [
        { id: 'res_00000001', kind: 'github', value: 'octo/hello@dev', label: 'Main repo' },
        { id: 'res_00000002', kind: 'github', value: 'octo/other' },
        { id: 'res_00000003', kind: 'url', value: 'https://example.com/' },
        { id: 'res_00000004', kind: 'file', value: ABS },
        { id: 'res_00000005', kind: 'folder', value: ABS },
        { id: 'res_00000006', kind: 'note', value: 'Only the last week.' },
      ],
    };
    const prompt = composePrompt(schedule, no);
    expect(prompt.startsWith('Summarize changes.\n\n## Resources for this task\n')).toBe(true);
    expect(prompt).toContain('**Main repo**: GitHub repo `octo/hello` (at `dev`)');
    expect(prompt).toContain('`git clone https://github.com/octo/hello`');
    expect(prompt).toContain('`git pull`');
    expect(prompt).toContain('check out `dev`');
    expect(prompt).toContain('Web page https://example.com/: fetch and read it');
    expect(prompt).toContain(`File \`${ABS}\` (WARNING: this file was not found`);
    expect(prompt).toContain('this folder was not found');
    expect(prompt).toContain('Note: Only the last week.');
    expect(composePrompt(schedule, yes)).not.toContain('WARNING');
    expect(prompt).not.toContain('concise summary');
  });

  it('gives the agent the inbox (not the schedule channels, which the watcher uses) and asks for a summary', () => {
    const schedule: Schedule = { ...base, launch: { ...base.launch, loadout: { skillIds: ['s1'], notifyChannelIds: ['x'] } }, notify: { channelIds: ['slack1'], when: 'failure' } };
    const launch = composeLaunch(schedule, yes);
    expect(launch.loadout).toEqual({ skillIds: ['s1'], notifyChannelIds: ['x', 'inbox'] });
    expect(launch.prompt).toMatch(/concise summary of what you found or changed\.$/);
    expect(composeLoadout(base.launch, { channelIds: ['slack1'], when: 'never' })).toBeUndefined();
  });
});

describe('uploads', () => {
  const b64 = (text: string) => Buffer.from(text).toString('base64');

  it('sanitizes names to a basename and refuses empty or dot names', () => {
    expect(sanitizeFilename('C:\\x\\..\\notes.md')).toBe('notes.md');
    expect(sanitizeFilename('../../etc/pa$$wd')).toBe('pa__wd');
    expect(sanitizeFilename('ok name-1.txt')).toBe('ok name-1.txt');
    expect(() => sanitizeFilename('..')).toThrow(/invalid/);
    expect(() => sanitizeFilename('dir/')).toThrow(/invalid/);
    expect(() => sanitizeFilename(3)).toThrow(/required/);
    expect(sanitizeFilename('a'.repeat(200))).toHaveLength(120);
  });

  it('enforces the 512 KB limit and base64 shape', () => {
    expect(decodeUpload(b64('hi')).toString()).toBe('hi');
    expect(() => decodeUpload(Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString('base64'))).toThrow(/512 KB/);
    expect(decodeUpload(Buffer.alloc(MAX_UPLOAD_BYTES).toString('base64'))).toHaveLength(MAX_UPLOAD_BYTES);
    expect(() => decodeUpload('not base64!')).toThrow(/base64/);
    expect(() => decodeUpload(undefined)).toThrow(/base64/);
  });

  it('stores files inside the schedule folder without overwriting, and cleans up', () => {
    const root = tempDir('res-');
    const first = saveUpload(root, 'sch_0000abcd', 'feed.json', b64('one'));
    const second = saveUpload(root, 'sch_0000abcd', 'feed.json', b64('two'));
    expect(first).toBe(join(root, 'sch_0000abcd', 'feed.json'));
    expect(second).toBe(join(root, 'sch_0000abcd', 'feed (2).json'));
    expect(readFileSync(first, 'utf8')).toBe('one');
    expect(() => saveUpload(root, '..', 'x.txt', b64('x'))).toThrow(/schedule id/);
    expect(() => scheduleResourceDir(root, 'sch_../../x')).toThrow(/schedule id/);

    pruneUploads(root, 'sch_0000abcd', [{ id: 'res_00000001', kind: 'file', value: first }]);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(false);
    pruneUploads(root, 'sch_0000ffff', []); // no folder: nothing happens
    pruneUploads(root, 'bad', []); // invalid id: swallowed

    const other = join(root, 'keep.txt');
    writeFileSync(other, 'x');
    removeScheduleResources(root, 'sch_0000abcd');
    removeScheduleResources(root, '..');
    expect(existsSync(join(root, 'sch_0000abcd'))).toBe(false);
    expect(existsSync(other)).toBe(true);
  });
});
