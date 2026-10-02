import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { claudePaths } from '../config.ts';

export interface SkillInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly dir: string;
}

const MAX_DEPTH = 7;
const CACHE_MS = 60_000;
const SAFE_SKILL_NAME = /^[A-Za-z0-9._-]+$/;

export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const field = (key: string) => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(match[1]);
    return line ? line[1].trim().replace(/^["']|["']$/g, '') : undefined;
  };
  return { name: field('name'), description: field('description') };
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

function sourceLabel(skillFile: string): string {
  const fromPlugins = relative(claudePaths.plugins, skillFile);
  if (!fromPlugins.startsWith('..')) {
    const parts = fromPlugins.split(/[\\/]/);
    const skillsIdx = parts.lastIndexOf('skills');
    return `plugin:${parts[Math.max(0, skillsIdx - 2)] ?? 'unknown'}`;
  }
  return 'user';
}

let cache: { at: number; skills: SkillInfo[] } | undefined;

export function listSkills(roots: readonly string[] = [claudePaths.skills, claudePaths.plugins]): SkillInfo[] {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.skills;
  const seen = new Set<string>();
  const skills = roots.flatMap(findSkillFiles).flatMap((file): SkillInfo[] => {
    const dir = dirname(file);
    let meta: { name?: string; description?: string } = {};
    try {
      meta = parseSkillFrontmatter(readFileSync(file, 'utf8').slice(0, 8000));
    } catch {
      return [];
    }
    const id = createHash('sha1').update(dir).digest('hex').slice(0, 12);
    if (seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      name: meta.name ?? basename(dir),
      description: (meta.description ?? '').slice(0, 300),
      source: sourceLabel(file),
      dir,
    }];
  }).sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: Date.now(), skills };
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
