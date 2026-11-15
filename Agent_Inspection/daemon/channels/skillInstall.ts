import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelError } from './board.ts';

/**
 * Installs the agent-channel skill where every supported CLI looks for personal skills:
 * ~/.claude/skills (Claude Code, Copilot CLI) and ~/.agents/skills (Codex, Gemini CLI, Copilot CLI).
 * Only folders Waystation wrote are ever replaced or removed.
 */

export const CHANNEL_SKILL_NAME = 'agent-channel';
export const CHANNEL_SKILL_DIR = fileURLToPath(new URL(`./skill/${CHANNEL_SKILL_NAME}/`, import.meta.url));
export const CHANNEL_CLI_SCRIPT = join(CHANNEL_SKILL_DIR, 'scripts', 'ws-channel.mjs');
/** Present in our SKILL.md: how an existing folder is recognised as Waystation's own. */
const OWNER_MARK = '# Waystation agent channels';
const FILES = ['SKILL.md', join('scripts', 'ws-channel.mjs')];

export interface SkillTarget {
  /** Which agent CLIs read this folder. */
  readonly label: string;
  /** The skills root; the skill lives in `<dir>/agent-channel`. */
  readonly dir: string;
}

export interface SkillTargetStatus extends SkillTarget {
  readonly path: string;
  readonly installed: boolean;
  /** Installed and identical to the copy this Waystation ships. */
  readonly current: boolean;
}

export function channelSkillTargets(home: string, claudeHome: string): SkillTarget[] {
  return [
    { label: 'Claude Code, Copilot CLI', dir: join(claudeHome, 'skills') },
    { label: 'Codex, Gemini CLI, Copilot CLI', dir: join(home, '.agents', 'skills') },
  ];
}

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

function statusOf(target: SkillTarget): SkillTargetStatus {
  const path = join(target.dir, CHANNEL_SKILL_NAME);
  const installed = existsSync(join(path, 'SKILL.md'));
  const current = installed && FILES.every((file) => read(join(path, file)) === read(join(CHANNEL_SKILL_DIR, file)));
  return { ...target, path, installed, current };
}

/** A folder we may replace: absent, or holding our own SKILL.md. */
function assertOurs(status: SkillTargetStatus): void {
  if (!existsSync(status.path)) return;
  if (!read(join(status.path, 'SKILL.md'))?.includes(OWNER_MARK)) {
    throw new ChannelError(`${status.path} holds a skill that is not Waystation's. Rename or remove it first.`);
  }
}

export const channelSkillStatus = (targets: readonly SkillTarget[]): SkillTargetStatus[] => targets.map(statusOf);

export function installChannelSkill(targets: readonly SkillTarget[]): SkillTargetStatus[] {
  const before = channelSkillStatus(targets);
  // Check every target before touching any, so a refusal leaves nothing half-installed.
  before.forEach(assertOurs);
  for (const status of before) {
    rmSync(status.path, { recursive: true, force: true });
    cpSync(CHANNEL_SKILL_DIR, status.path, { recursive: true });
  }
  return channelSkillStatus(targets);
}

export function uninstallChannelSkill(targets: readonly SkillTarget[]): SkillTargetStatus[] {
  const before = channelSkillStatus(targets);
  before.forEach(assertOurs);
  for (const status of before) rmSync(status.path, { recursive: true, force: true });
  return channelSkillStatus(targets);
}
