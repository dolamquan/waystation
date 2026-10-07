import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { claudePaths, paths } from '../config.ts';

export interface SkillInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** "waystation", "user" or "plugin:<name>". */
  readonly source: string;
  readonly dir: string;
}

/** Where skills are looked for. "plugins" roots label each skill with the plugin it came from. */
export interface SkillRoot {
  readonly dir: string;
  readonly kind: 'waystation' | 'user' | 'plugins';
}

const MAX_DEPTH = 7;
const CACHE_MS = 60_000;
const SAFE_SKILL_NAME = /^[A-Za-z0-9._-]+$/;

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const field = (key: string) => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(match[1]);
    return line ? unquote(line[1].trim()) : undefined;
  };
  return { name: field('name'), description: field('description') };
}

/** The id scheme every skill API shares: stable for as long as the skill folder stays put. */
export function skillIdFor(dir: string): string {
  return createHash('sha1').update(dir).digest('hex').slice(0, 12);
}

/** The default places skills come from: Waystation's own library, ~/.claude/skills and installed plugins. */
export function defaultSkillRoots(): SkillRoot[] {
  return [
    { dir: paths.skillsLibraryDir, kind: 'waystation' },
    { dir: claudePaths.skills, kind: 'user' },
    { dir: claudePaths.plugins, kind: 'plugins' },
  ];
}

function toRoot(root: string | SkillRoot): SkillRoot {
  if (typeof root !== 'string') return root;
  const full = resolve(root);
  if (full === resolve(paths.skillsLibraryDir)) return { dir: root, kind: 'waystation' };
  if (full === resolve(claudePaths.plugins)) return { dir: root, kind: 'plugins' };
  return { dir: root, kind: 'user' };
}

function findSkillFiles(root: string, depth = 0): string[] {
  if (depth > MAX_DEPTH || !existsSync(root)) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) return [];
    const full = join(root, entry.name);
    if (entry.isFile() && entry.name === 'SKILL.md') return [full];
    return entry.isDirectory() ? findSkillFiles(full, depth + 1) : [];
  });
}

function sourceLabel(skillFile: string, root: SkillRoot): string {
  if (root.kind !== 'plugins') return root.kind;
  const parts = relative(root.dir, skillFile).split(/[\\/]/);
  const skillsIdx = parts.lastIndexOf('skills');
  return `plugin:${parts[Math.max(0, skillsIdx - 2)] ?? 'unknown'}`;
}

function readSkill(file: string, root: SkillRoot): SkillInfo | undefined {
  const dir = dirname(file);
  let meta: { name?: string; description?: string };
  try {
    meta = parseSkillFrontmatter(readFileSync(file, 'utf8').slice(0, 8000));
  } catch {
    return undefined;
  }
  return {
    id: skillIdFor(dir),
    name: meta.name || basename(dir),
    description: (meta.description ?? '').slice(0, 300),
    source: sourceLabel(file, root),
    dir,
  };
}

const cache = new Map<string, { at: number; skills: SkillInfo[] }>();

/** Drops cached listings, e.g. after a skill was created, edited or deleted. */
export function invalidateSkillCache(): void {
  cache.clear();
}

export function listSkills(rootsIn: readonly (string | SkillRoot)[] = defaultSkillRoots()): SkillInfo[] {
  const roots = rootsIn.map(toRoot);
  const key = JSON.stringify(roots);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.skills;
  const seen = new Set<string>();
  const skills = roots
    .flatMap((root) => findSkillFiles(root.dir).map((file) => readSkill(file, root)))
    .filter((skill): skill is SkillInfo => {
      if (!skill || seen.has(skill.id)) return false;
      seen.add(skill.id);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  cache.set(key, { at: Date.now(), skills });
  return skills;
}

/** Copy a skill folder into <cwd>/.claude/skills/<name> so Claude Code discovers it for that project. */
export function attachSkillToProject(skill: SkillInfo, cwd: string): string {
  const folderName = basename(skill.dir);
  if (!SAFE_SKILL_NAME.test(folderName)) throw new Error(`unsafe skill folder name: ${folderName}`);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`project folder not found: ${cwd}`);
  const target = join(cwd, '.claude', 'skills', folderName);
  if (existsSync(target)) throw new Error(`skill already present at ${target}`);
  cpSync(skill.dir, target, { recursive: true, errorOnExist: true });
  return target;
}

export function skillInstruction(skill: SkillInfo, target: string): string {
  // Name + path only: the SKILL.md description is third-party text and must not ride on the user's voice.
  return `I attached the skill "${skill.name}" to this project at ${target.replace(/\\/g, '/')}/SKILL.md. Read it and use it where it is relevant.`;
}
