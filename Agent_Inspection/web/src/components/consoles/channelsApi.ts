import { request } from '../../api.ts';
import type { ChannelMemberView, ChannelView } from '../../../../daemon/channels/channelManager.ts';
import type { SkillTargetStatus } from '../../../../daemon/channels/skillInstall.ts';
import type { ChannelMember, ChannelMessage, Delivery } from '../../../../daemon/channels/types.ts';

/** Typed wrappers over the /api/channels routes. api.ts has none, and it is not edited for this panel. */
export type { ChannelMemberView, ChannelMessage, ChannelView, Delivery, SkillTargetStatus };

/** api.ts keeps its own `enc` private; ids and names go into the path, so encode them here. */
const enc = encodeURIComponent;

export interface NewChannel {
  readonly name: string;
  readonly purpose?: string;
}

export interface AddedMember {
  readonly member: ChannelMember;
  /** What happened when the session was told about the team (or why it was not). */
  readonly notice: string;
}

export const listChannels = async (): Promise<readonly ChannelView[]> =>
  (await request<{ channels: ChannelView[] }>('GET', '/api/channels')).channels;

export const createChannel = async (input: NewChannel): Promise<ChannelView> =>
  (await request<{ channel: ChannelView }>('POST', '/api/channels', input)).channel;

/** `name` is only a suggested handle; the daemon makes it unique. */
export const addMember = (channelId: string, agentId: string, name?: string): Promise<AddedMember> =>
  request<AddedMember>('POST', `/api/channels/${enc(channelId)}/members`, { agentId, ...(name ? { name } : {}) });

export const removeMember = async (channelId: string, name: string): Promise<void> => {
  await request('POST', `/api/channels/${enc(channelId)}/members/${enc(name)}/remove`, {});
};

/** From the operator, to "all" or one member name; the recipients are woken. */
export const postMessage = async (channelId: string, to: string, text: string): Promise<readonly Delivery[]> =>
  (await request<{ deliveries: Delivery[] }>('POST', `/api/channels/${enc(channelId)}/message`, { to, text })).deliveries;

/** The daemon refuses unless `confirm` is true, so the caller must have asked the operator. */
export const removeChannel = async (channelId: string): Promise<void> => {
  await request('POST', `/api/channels/${enc(channelId)}/remove`, { confirm: true });
};

export const skillStatus = async (): Promise<readonly SkillTargetStatus[]> =>
  (await request<{ targets: SkillTargetStatus[] }>('GET', '/api/channels/skill')).targets;

export const installSkill = async (): Promise<readonly SkillTargetStatus[]> =>
  (await request<{ targets: SkillTargetStatus[] }>('POST', '/api/channels/skill/install', { confirm: true })).targets;
