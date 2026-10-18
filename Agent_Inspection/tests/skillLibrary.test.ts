import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { invalidateSkillCache, listSkills, parseSkillFrontmatter } from '../daemon/actions/skills.ts';
import type { LibraryDeps } from '../daemon/library/deps.ts';
import { SecretStore } from '../daemon/library/secretStore.ts';
import { pruneLoadouts, SkillLibrary, skillMarkdown, slugify, stripFrontmatter } from '../daemon/library/skillLibrary.ts';
import { LibraryInputError } from '../daemon/library/types.ts';
import type { ManagedLaunch } from '../daemon/managed/types.ts';
import { TowerStore } from '../daemon/store/db.ts';

interface Fixture {
  readonly library: SkillLibrary;
  readonly deps: LibraryDeps;
  readonly audits: Array<{ action: string; target: string }>;
}

function writeSkill(dir: string, name: string, description: string, body = 'Do the thing.'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

function setup(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'skill-library-'));
  const claudeHome = join(root, 'claude');
  writeSkill(join(claudeHome, 'skills', 'tidy-up'), 'tidy-up', 'Keep things tidy');
  writeSkill(join(claudeHome, 'plugins', 'cache', 'market', 'shiny', '1.0.0', 'skills', 'polish'), 'polish', 'Polish code');
  const audits: Array<{ action: string; target: string }> = [];
  const deps: LibraryDeps = {
    store: new TowerStore(':memory:'),
    secrets: new SecretStore(':memory:'),
    paths: {
      skillsLibraryDir: join(root, 'library', 'skills'),
      docsDir: join(root, 'library', 'docs'),
      loadoutsDir: join(root, 'loadouts'),
      claudeHome,
    },
    audit: (action, target) => { audits.push({ action, target }); },
  };
  return { library: new SkillLibrary(deps), deps, audits };
}

const launchFor = (vendor: 'claude' | 'codex'): ManagedLaunch => ({ vendor, cwd: 'C:/work', prompt: 'go', agentId: 'managed:42' });

const input = { name: 'Code Review', description: 'Review code: "carefully" # always', body: '# Steps\n\n1. Read the diff.' };

describe('helpers', () => {
  it('slugifies names', () => {
    expect(slugify('Code Review!')).toBe('code-review');
    expect(slugify('  --Hello__World--  ')).toBe('hello-world');
    expect(slugify('!!!')).toBe('');
  });

  it('round-trips quoted descriptions through the frontmatter', () => {
    const text = skillMarkdown('code-review', input.description, input.body);
    expect(parseSkillFrontmatter(text)).toEqual({ name: 'code-review', description: input.description });
    expect(stripFrontmatter(text)).toBe(input.body);
    expect(parseSkillFrontmatter("---\nname: x\ndescription: 'it''s'\n---\n").description).toBe("it's");
  });
});

describe('SkillLibrary', () => {
  let fx: Fixture;
  beforeEach(() => {
    invalidateSkillCache();
    fx = setup();
  });

  it('lists user and plugin skills as read-only', () => {
    const skills = fx.library.list();
    expect(skills.map((s) => [s.name, s.source, s.editable])).toEqual([
      ['polish', 'plugin:shiny', false],
      ['tidy-up', 'user', false],
    ]);
  });

  it('creates, reads, updates and deletes a Waystation skill', () => {
    const created = fx.library.create(input);
    expect(created).toMatchObject({ name: 'code-review', source: 'waystation', editable: true, description: input.description, body: input.body });
    expect(existsSync(join(fx.deps.paths.skillsLibraryDir, 'code-review', 'SKILL.md'))).toBe(true);
    expect(fx.library.list().find((s) => s.id === created.id)?.editable).toBe(true);

    const updated = fx.library.update(created.id, { description: 'New text', body: 'New body' });
    expect(updated).toMatchObject({ id: created.id, description: 'New text', body: 'New body' });

    fx.library.remove(created.id);
    expect(fx.library.list().some((s) => s.id === created.id)).toBe(false);
    expect(fx.audits.map((a) => a.action)).toEqual(['skill_create', 'skill_update', 'skill_delete']);
  });

  it('keeps ids in the same scheme as listSkills', () => {
    const created = fx.library.create(input);
    const legacy = listSkills([{ dir: fx.deps.paths.skillsLibraryDir, kind: 'waystation' }]);
    expect(legacy.find((s) => s.name === 'code-review')?.id).toBe(created.id);
  });

  it('validates input', () => {
    expect(() => fx.library.create(null)).toThrow(LibraryInputError);
    expect(() => fx.library.create({ ...input, name: '!!!' })).toThrow(/letter or digit/);
    expect(() => fx.library.create({ ...input, name: 'x'.repeat(65) })).toThrow(/1 to 64/);
    expect(() => fx.library.create({ ...input, description: 'two\nlines' })).toThrow(/single line/);
    expect(() => fx.library.create({ ...input, description: ' ' })).toThrow(/description is required/);
    expect(() => fx.library.create({ ...input, description: 'x'.repeat(301) })).toThrow(/300/);
    expect(() => fx.library.create({ ...input, body: 'x'.repeat(100_001) })).toThrow(/100 KB/);
    expect(() => fx.library.create({ ...input, body: '  ' })).toThrow(/body is required/);
    expect(() => fx.library.create({ ...input, body: 5 })).toThrow(/body must be text/);
  });

  it('rejects duplicates, unknown ids and edits to read-only skills', () => {
    fx.library.create(input);
    expect(() => fx.library.create({ ...input, name: 'code review' })).toThrow(/already exists/);
    expect(() => fx.library.get('nope')).toThrow(/Unknown skill/);
    expect(() => fx.library.remove(42)).toThrow(/Unknown skill/);
    const userSkill = fx.library.list().find((s) => s.name === 'tidy-up')!;
    expect(() => fx.library.update(userSkill.id, { description: 'x', body: 'y' })).toThrow(/Duplicate it/);
    expect(() => fx.library.remove(userSkill.id)).toThrow(/Duplicate it/);
  });

  it('duplicates any skill into an editable copy with a unique name', () => {
    const userSkill = fx.library.list().find((s) => s.name === 'tidy-up')!;
    const first = fx.library.duplicate(userSkill.id);
    const second = fx.library.duplicate(userSkill.id);
    expect(first).toMatchObject({ name: 'tidy-up-copy', editable: true, description: 'Keep things tidy', body: 'Do the thing.\n' });
    expect(second.name).toBe('tidy-up-copy-2');
    expect(fx.audits.filter((a) => a.action === 'skill_duplicate')).toHaveLength(2);
  });

  it('gives Claude agents the chosen skills as a local plugin', () => {
    const tidy = fx.library.list().find((s) => s.name === 'tidy-up')!;
    const created = fx.library.create(input);
    const part = fx.library.contribute({ skillIds: [tidy.id, created.id] }, launchFor('claude'));
    const pluginDir = join(fx.deps.paths.loadoutsDir, 'managed_42', 'skills-plugin');
    expect(part.plugins).toEqual([pluginDir]);
    expect(part.appendSystemPrompt).toBe('Skills given to you for this task: tidy-up, code-review (from the waystation-skills plugin). Use them where relevant.');
    const manifest = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'waystation-skills', version: '1.0.0' });
    expect(existsSync(join(pluginDir, 'skills', 'tidy-up', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(pluginDir, 'skills', 'code-review', 'SKILL.md'))).toBe(true);
  });

  it('lists skill paths for Codex agents instead of a plugin', () => {
    const tidy = fx.library.list().find((s) => s.name === 'tidy-up')!;
    const part = fx.library.contribute({ skillIds: [tidy.id] }, launchFor('codex'));
    expect(part.plugins).toBeUndefined();
    expect(part.appendSystemPrompt).toMatch(/- tidy-up: .*\/skills-plugin\/skills\/tidy-up\/SKILL\.md/);
    expect(part.notes?.[0]).toMatch(/Codex/);
  });

  it('ignores loadouts without skills and rejects unknown skill ids', () => {
    expect(fx.library.contribute({ docIds: ['d1'] }, launchFor('claude'))).toEqual({});
    expect(() => fx.library.contribute({ skillIds: ['missing'] }, launchFor('claude'))).toThrow(LibraryInputError);
  });
});

describe('pruneLoadouts', () => {
  it('removes week-old loadout folders and keeps fresh ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loadouts-'));
    mkdirSync(join(dir, 'old'));
    mkdirSync(join(dir, 'fresh'));
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(join(dir, 'old'), eightDaysAgo, eightDaysAgo);
    pruneLoadouts(dir);
    expect(existsSync(join(dir, 'old'))).toBe(false);
    expect(existsSync(join(dir, 'fresh'))).toBe(true);
    expect(() => pruneLoadouts(join(dir, 'missing'))).not.toThrow();
  });
});
