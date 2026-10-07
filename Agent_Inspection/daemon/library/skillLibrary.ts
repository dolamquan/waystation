import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import {
  invalidateSkillCache, listSkills, parseSkillFrontmatter, skillIdFor, type SkillInfo, type SkillRoot,
} from '../actions/skills.ts';
import type { ManagedLaunch } from '../managed/types.ts';
import type { LibraryDeps } from './deps.ts';
import {
  LibraryInputError, type LaunchLoadout, type LibrarySkill, type LibrarySkillDetail, type LoadoutContribution,
  type LoadoutProvider, type SkillInput,
} from './types.ts';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 300;
const MAX_BODY_BYTES = 100_000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const LOADOUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PLUGIN_NAME = 'waystation-skills';
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Copy filter: no dependency/VCS folders, and no symlinks (a plugin skill could point one at ~/.ssh). */
const copyable = (src: string): boolean => {
  if (/[\\/](node_modules|\.git)$/.test(src)) return false;
  try {
    return !lstatSync(src).isSymbolicLink();
  } catch {
    return false;
  }
};

/** "Code Review!" -> "code-review". Empty when nothing usable is left. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, MAX_NAME).replace(/-+$/, '');
}

export function skillMarkdown(name: string, description: string, body: string): string {
  // JSON strings are valid YAML double-quoted scalars, so quotes, colons and '#' stay safe.
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.replace(/^\s*\n/, '')}`;
}

export function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, '').replace(/^\r?\n/, '');
}

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw);

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new LibraryInputError(`${key} must be text`);
  return value;
}

function parseDescription(body: Record<string, unknown>): string {
  const description = requireString(body, 'description').trim();
  if (!description) throw new LibraryInputError('description is required: it tells the agent when to use the skill');
  if (description.length > MAX_DESCRIPTION) throw new LibraryInputError(`description must be at most ${MAX_DESCRIPTION} characters`);
  if (CONTROL_CHARS.test(description)) throw new LibraryInputError('description must be a single line');
  return description;
}

function parseBody(body: Record<string, unknown>): string {
  const text = requireString(body, 'body');
  if (!text.trim()) throw new LibraryInputError('body is required: write the instructions the agent should follow');
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new LibraryInputError('body must be at most 100 KB');
  return text;
}

export function parseSkillInput(raw: unknown): SkillInput {
  if (!isRecord(raw)) throw new LibraryInputError('expected a skill object');
  const name = requireString(raw, 'name').trim();
  if (!name || name.length > MAX_NAME) throw new LibraryInputError(`name must be 1 to ${MAX_NAME} characters`);
  if (!SLUG.test(slugify(name))) throw new LibraryInputError('name needs at least one letter or digit');
  return { name, description: parseDescription(raw), body: parseBody(raw) };
}

export function parseSkillUpdate(raw: unknown): Omit<SkillInput, 'name'> {
  if (!isRecord(raw)) throw new LibraryInputError('expected a skill object');
  return { description: parseDescription(raw), body: parseBody(raw) };
}

/** Agent ids look like "managed:abc"; keep them filesystem-safe. */
const folderFor = (agentId: string): string => agentId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'agent';

/** A skill name as it may appear in a system prompt: one short line. */
const promptName = (name: string): string => name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_NAME);

const posix = (path: string): string => path.replace(/\\/g, '/');

/** Removes per-agent loadout folders older than a week. Best effort: never throws. */
export function pruneLoadouts(loadoutsDir: string, now = Date.now()): void {
  try {
    if (!existsSync(loadoutsDir)) return;
    readdirSync(loadoutsDir).forEach((entry) => {
      try {
        const full = join(loadoutsDir, entry);
        if (now - statSync(full).mtimeMs > LOADOUT_MAX_AGE_MS) rmSync(full, { recursive: true, force: true });
      } catch {
        // A folder in use or already gone: try again next start.
      }
    });
  } catch {
    // Unreadable loadouts folder: nothing to prune.
  }
}

/** The operator's skill library: Waystation skills (editable) plus ~/.claude skills and plugin skills (read-only). */
export class SkillLibrary implements LoadoutProvider {
  constructor(private readonly deps: LibraryDeps) {
    pruneLoadouts(deps.paths.loadoutsDir);
  }

  private get libraryDir(): string {
    return this.deps.paths.skillsLibraryDir;
  }

  private roots(): SkillRoot[] {
    return [
      { dir: this.libraryDir, kind: 'waystation' },
      { dir: join(this.deps.paths.claudeHome, 'skills'), kind: 'user' },
      { dir: join(this.deps.paths.claudeHome, 'plugins'), kind: 'plugins' },
    ];
  }

  private all(): SkillInfo[] {
    return listSkills(this.roots());
  }

  private find(id: unknown): SkillInfo {
    const skill = typeof id === 'string' ? this.all().find((candidate) => candidate.id === id) : undefined;
    if (!skill) throw new LibraryInputError('Unknown skill.');
    return skill;
  }

  /** Editable means: created here and still inside the library folder. */
  private isEditable(skill: SkillInfo): boolean {
    const rel = relative(resolve(this.libraryDir), resolve(skill.dir));
    return skill.source === 'waystation' && !!rel && !rel.startsWith('..') && !/[\\/]/.test(rel);
  }

  private findEditable(id: unknown): SkillInfo {
    const skill = this.find(id);
    if (!this.isEditable(skill)) throw new LibraryInputError('Only skills created in Waystation can be changed. Duplicate it to edit a copy.');
    return skill;
  }

  private view(skill: SkillInfo): LibrarySkill {
    const { id, name, description, source } = skill;
    return { id, name, description, source, editable: this.isEditable(skill) };
  }

  private detailOf(dir: string): LibrarySkillDetail {
    invalidateSkillCache();
    return this.get(skillIdFor(dir));
  }

  list(): LibrarySkill[] {
    return this.all().map((skill) => this.view(skill));
  }

  get(id: unknown): LibrarySkillDetail {
    const skill = this.find(id);
    let text = '';
    try {
      text = readFileSync(join(skill.dir, 'SKILL.md'), 'utf8');
    } catch {
      throw new LibraryInputError('This skill can no longer be read from disk.');
    }
    return { ...this.view(skill), body: stripFrontmatter(text).slice(0, MAX_BODY_BYTES) };
  }

  create(raw: unknown): LibrarySkillDetail {
    const input = parseSkillInput(raw);
    const slug = slugify(input.name);
    const dir = join(this.libraryDir, slug);
    if (existsSync(dir)) throw new LibraryInputError(`A skill named "${slug}" already exists.`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skillMarkdown(slug, input.description, input.body), { flag: 'wx' });
    this.deps.audit('skill_create', slug, { description: input.description });
    return this.detailOf(dir);
  }

  update(id: unknown, raw: unknown): LibrarySkillDetail {
    const skill = this.findEditable(id);
    const input = parseSkillUpdate(raw);
    const name = basename(skill.dir);
    writeFileSync(join(skill.dir, 'SKILL.md'), skillMarkdown(name, input.description, input.body));
    this.deps.audit('skill_update', name, { description: input.description });
    return this.detailOf(skill.dir);
  }

  remove(id: unknown): void {
    const skill = this.findEditable(id);
    rmSync(skill.dir, { recursive: true, force: true });
    invalidateSkillCache();
    this.deps.audit('skill_delete', basename(skill.dir), { id: skill.id });
  }

  /** Copies any skill (user, plugin or Waystation) into the library as a new, editable skill. */
  duplicate(id: unknown): LibrarySkillDetail {
    const skill = this.find(id);
    const slug = this.freeSlug(`${slugify(skill.name) || 'skill'}`);
    const dir = join(this.libraryDir, slug);
    mkdirSync(this.libraryDir, { recursive: true });
    cpSync(skill.dir, dir, { recursive: true, errorOnExist: true, filter: copyable });
    const original = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const parsed = parseSkillFrontmatter(original).description ?? '';
    // A YAML block scalar (">" or "|") is not parsed here: leave the description for the operator to fill in.
    const description = (/^[>|][-+]?$/.test(parsed) ? '' : parsed).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, MAX_DESCRIPTION);
    writeFileSync(join(dir, 'SKILL.md'), skillMarkdown(slug, description, stripFrontmatter(original)));
    this.deps.audit('skill_duplicate', slug, { from: skill.id, source: skill.source });
    return this.detailOf(dir);
  }

  /** "<base>-copy", then "<base>-copy-2", … always within the slug length limit. */
  private freeSlug(base: string): string {
    for (let n = 1; n < 1000; n += 1) {
      const suffix = n === 1 ? '-copy' : `-copy-${n}`;
      const slug = `${base.slice(0, MAX_NAME - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!existsSync(join(this.libraryDir, slug))) return slug;
    }
    throw new LibraryInputError('Too many copies of this skill already.');
  }

  contribute(loadout: LaunchLoadout, launch: ManagedLaunch): LoadoutContribution {
    if (!loadout.skillIds?.length) return {};
    const skills = loadout.skillIds.map((id) => this.find(id));
    const pluginDir = join(this.deps.paths.loadoutsDir, folderFor(launch.agentId ?? 'agent'), 'skills-plugin');
    const folders = this.snapshot(skills, pluginDir);
    const names = skills.map((skill) => promptName(skill.name));
    if (launch.vendor === 'claude') {
      return {
        plugins: [pluginDir],
        appendSystemPrompt: `Skills given to you for this task: ${names.join(', ')} (from the ${PLUGIN_NAME} plugin). Use them where relevant.`,
      };
    }
    const lines = folders.map((folder, index) => `- ${names[index]}: ${posix(join(pluginDir, 'skills', folder, 'SKILL.md'))}`);
    return {
      appendSystemPrompt: [
        'Skills given to you for this task. When one is relevant, read its SKILL.md first and follow it:',
        ...lines,
      ].join('\n'),
      notes: ['Codex has no plugin support: its skills are listed in its instructions for it to read when relevant.'],
    };
  }

  /** Copies the chosen skills into a fresh local Claude Code plugin. Returns each skill's folder name. */
  private snapshot(skills: readonly SkillInfo[], pluginDir: string): string[] {
    rmSync(pluginDir, { recursive: true, force: true });
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: PLUGIN_NAME,
      version: '1.0.0',
      description: 'Skills the operator gave this agent in Waystation.',
    }, null, 2));
    return skills.reduce<string[]>((used, skill) => {
      const base = basename(skill.dir).replace(/[^A-Za-z0-9._-]/g, '-') || 'skill';
      const folder = used.includes(base) ? `${base}-${used.length + 1}` : base;
      cpSync(skill.dir, join(pluginDir, 'skills', folder), { recursive: true, filter: copyable });
      return [...used, folder];
    }, []);
  }
}
