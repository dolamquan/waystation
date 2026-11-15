import { timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { ChannelError } from '../../channels/board.ts';
import { ChannelAuthError } from '../../channels/callerIdentity.ts';
import { channelSkillStatus, channelSkillTargets, installChannelSkill, uninstallChannelSkill } from '../../channels/skillInstall.ts';
import { paths } from '../../config.ts';
import type { Tower } from '../../tower.ts';
import { UserError } from '../../userError.ts';
import { bodyOf, headerOf, r, type Route } from './route.ts';

export const CHANNEL_TOKEN_HEADER = 'x-channel-token';

/** Expected channel failures become 400s with their message. */
async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ChannelError) throw new UserError(error.message);
    throw error;
  }
}

function requireConfirm(body: unknown, action: string): void {
  if (bodyOf(body).confirm !== true) throw new UserError(`${action} requires confirm: true.`);
}

/** Operator routes under /api/channels (operator token already checked): channels, membership, and the agent skill. */
export function channelRoutes(tower: Tower): Route[] {
  const channels = tower.channels;
  const targets = () => channelSkillTargets(homedir(), paths.claudeHome);
  return [
    r('GET', '/api/channels', () => ({ channels: channels.list() })),
    r('POST', '/api/channels', ({ body }) => guarded(() => ({ ok: true, channel: channels.create(body) }))),
    r('GET', '/api/channels/skill', () => ({ targets: channelSkillStatus(targets()) })),
    r('POST', '/api/channels/skill/install', ({ body }) => guarded(() => {
      requireConfirm(body, 'Installing the channel skill');
      const status = installChannelSkill(targets());
      tower.store.audit('channel_skill_install', 'agent-channel', { targets: status.map((t) => t.path) });
      return { ok: true, targets: status };
    })),
    r('POST', '/api/channels/skill/uninstall', ({ body }) => guarded(() => {
      requireConfirm(body, 'Removing the channel skill');
      const status = uninstallChannelSkill(targets());
      tower.store.audit('channel_skill_uninstall', 'agent-channel', {});
      return { ok: true, targets: status };
    })),
    r('POST', '/api/channels/:id/members', ({ params, body }) => guarded(async () => ({ ok: true, ...(await channels.addMember(params[0], body)) }))),
    r('POST', '/api/channels/:id/members/:name/remove', ({ params }) => guarded(() => {
      channels.removeMember(params[0], params[1]);
      return { ok: true };
    })),
    r('POST', '/api/channels/:id/message', ({ params, body }) => guarded(async () => ({ ok: true, deliveries: await channels.postAsOperator(params[0], body) }))),
    r('POST', '/api/channels/:id/remove', ({ params, body }) => guarded(() => {
      requireConfirm(body, 'Removing a channel');
      channels.remove(params[0]);
      return { ok: true };
    })),
  ];
}

const sameToken = (given: string | undefined, expected: string): boolean => {
  if (!given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
};

/**
 * Agent routes under /agent/channel/ for the ws-channel CLI. The operator token is not used: each call
 * carries the channel token (from the user-only channels.json) and the caller is identified per call.
 */
export function channelAgentRoutes(tower: Tower): Route[] {
  const channels = tower.channels;
  const authed = <T>(req: Parameters<Route['handler']>[0]['req'], fn: () => T | Promise<T>): Promise<T> => {
    if (!sameToken(headerOf(req, CHANNEL_TOKEN_HEADER), channels.token)) throw new ChannelAuthError('missing or invalid channel token');
    return guarded(fn);
  };
  return [
    r('POST', '/agent/channel/whoami', ({ req, body }) => authed(req, () => channels.whoami(body))),
    r('POST', '/agent/channel/send', ({ req, body }) => authed(req, () => channels.send(body))),
    r('POST', '/agent/channel/inbox', ({ req, body }) => authed(req, () => channels.inbox(body))),
    r('POST', '/agent/channel/wait', ({ req, res, body }) => authed(req, () => {
      // A CLI that gives up (Ctrl+C, tool timeout) must not leave a waiter that swallows the next message.
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      return channels.wait(body, abort.signal);
    })),
  ];
}
