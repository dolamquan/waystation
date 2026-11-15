import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANNEL_CLI_SCRIPT, CHANNEL_SKILL_DIR, channelSkillTargets, installChannelSkill, channelSkillStatus, uninstallChannelSkill } from '../daemon/channels/skillInstall.ts';
import { tempDir } from './helpers.ts';

const targets = () => {
  const home = tempDir('skill-home-');
  return channelSkillTargets(home, join(home, '.claude'));
};

describe('channel skill files', () => {
  it('ships a SKILL.md with frontmatter and the CLI next to it', () => {
    const skill = readFileSync(join(CHANNEL_SKILL_DIR, 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\r?\nname: agent-channel\r?\ndescription: ".+"\r?\n---/);
    expect(existsSync(CHANNEL_CLI_SCRIPT)).toBe(true);
  });
});

describe('installChannelSkill', () => {
  it('installs into the Claude and the shared .agents skill folders', () => {
    const list = targets();
    expect(list.map((t) => t.dir.replace(/\\/g, '/'))).toEqual([expect.stringMatching(/\.claude\/skills$/), expect.stringMatching(/\.agents\/skills$/)]);
    expect(channelSkillStatus(list).every((t) => !t.installed)).toBe(true);
    const status = installChannelSkill(list);
    expect(status.every((t) => t.installed && t.current)).toBe(true);
    for (const target of list) expect(existsSync(join(target.dir, 'agent-channel', 'scripts', 'ws-channel.mjs'))).toBe(true);
  });

  it('notices an outdated copy and refreshes it', () => {
    const list = targets();
    installChannelSkill(list);
    writeFileSync(join(list[0].dir, 'agent-channel', 'SKILL.md'), '---\nname: agent-channel\n---\n# Waystation agent channels (old)\n');
    expect(channelSkillStatus(list)[0]).toMatchObject({ installed: true, current: false });
    expect(installChannelSkill(list)[0].current).toBe(true);
  });

  it('never overwrites or removes a different skill with the same folder name', () => {
    const list = targets();
    const foreign = join(list[1].dir, 'agent-channel');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'SKILL.md'), '---\nname: agent-channel\n---\nsomeone else');
    expect(() => installChannelSkill(list)).toThrow(/not Waystation's/);
    expect(readFileSync(join(foreign, 'SKILL.md'), 'utf8')).toContain('someone else');
    expect(() => uninstallChannelSkill(list)).toThrow(/not Waystation's/);
  });

  it('uninstalls its own copies', () => {
    const list = targets();
    installChannelSkill(list);
    expect(uninstallChannelSkill(list).every((t) => !t.installed)).toBe(true);
  });
});
