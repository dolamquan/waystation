import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { LibraryDeps } from '../library/deps.ts';
import {
  INBOX_CHANNEL_ID, LibraryInputError,
  type LaunchLoadout, type LoadoutContribution, type LoadoutProvider, type NotificationEntry,
  type NotifyChannelView, type NotifyMessage, type NotifyResult, type NotifySender,
} from '../library/types.ts';
import type { ManagedLaunch } from '../managed/types.ts';
import { AgentTokens, RateLimiter, type AgentGrant } from './agentTokens.ts';
import { ChannelStore } from './channelStore.ts';
import { CHANNEL_SPECS } from './channels/index.ts';
import type { CleanMessage, DeliveryIo } from './channels/types.ts';
import { DELIVERY_TIMEOUT_MS, deliverOnce } from './delivery.ts';
import { Inbox } from './inbox.ts';
import { defaultIo } from './io.ts';
import { cleanMessage, parsePostedMessage } from './validate.ts';

export const NOTIFY_MCP_SCRIPT = fileURLToPath(new URL('./notify-mcp.mjs', import.meta.url));
export const NOTIFY_URL_ENV = 'AGENT_TOWER_NOTIFY_URL';
export const NOTIFY_TOKEN_ENV = 'AGENT_TOWER_NOTIFY_TOKEN';
export const NOTIFY_PROMPT = 'You can message the operator with the notify tool (title, body, level). Use it for important progress and to send a short final summary when you finish.';
const MINUTE_MS = 60_000;
const CHANNEL_RATE_PER_MINUTE = 30;
const AGENT_RATE_PER_MINUTE = 20;

export interface NotifierOptions {
  readonly io?: Partial<DeliveryIo>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly channelRatePerMinute?: number;
  readonly agentRatePerMinute?: number;
}

/**
 * Emits 'notification' (NotificationEntry) whenever something lands in the in-app inbox;
 * the server broadcasts it to the UI.
 */
export class Notifier extends EventEmitter implements NotifySender, LoadoutProvider {
  private endpoint: string | undefined;
  private readonly channels: ChannelStore;
  private readonly inbox: Inbox;
  private readonly tokens = new AgentTokens();
  private readonly io: DeliveryIo;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly channelLimiter: RateLimiter;
  private readonly agentLimiter: RateLimiter;

  constructor(private readonly deps: LibraryDeps, options: NotifierOptions = {}) {
    super();
    this.channels = new ChannelStore(deps);
    this.inbox = new Inbox(deps);
    this.io = { ...defaultIo, ...options.io };
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DELIVERY_TIMEOUT_MS;
    this.channelLimiter = new RateLimiter(options.channelRatePerMinute ?? CHANNEL_RATE_PER_MINUTE, MINUTE_MS, this.now);
    this.agentLimiter = new RateLimiter(options.agentRatePerMinute ?? AGENT_RATE_PER_MINUTE, MINUTE_MS, this.now);
  }

  /** The daemon's own URL, for the agents' notify bridge. Set by the server once it listens. */
  setEndpoint(url: string): void {
    this.endpoint = url;
  }

  // ---- channels -------------------------------------------------------------------------------

  /** The Updates inbox first, then the operator's channels in the order they were added. */
  listChannels(): NotifyChannelView[] {
    const inbox: NotifyChannelView = {
      id: INBOX_CHANNEL_ID, kind: 'inbox', label: 'Updates (in-app)', config: {}, secretNames: [], enabled: true, createdAt: 0,
      ...(this.inbox.latestTs() === undefined ? {} : { lastSentAt: this.inbox.latestTs() }),
    };
    return [inbox, ...this.channels.records().map((record) => this.channels.view(record))];
  }

  createChannel(raw: unknown): NotifyChannelView {
    const channel = this.channels.create(raw, this.now());
    this.deps.audit('notify_channel_create', channel.id, { kind: channel.kind, label: channel.label, secretNames: channel.secretNames });
    return channel;
  }

  updateChannel(id: string, raw: unknown): NotifyChannelView {
    const channel = this.channels.update(id, raw);
    this.deps.audit('notify_channel_update', id, { label: channel.label, enabled: channel.enabled, secretNames: channel.secretNames });
    return channel;
  }

  deleteChannel(id: string, raw: unknown): void {
    const confirmed = Boolean(raw && typeof raw === 'object' && (raw as Record<string, unknown>).confirm === true);
    if (!confirmed) throw new LibraryInputError('deleting a channel needs { "confirm": true }');
    const removed = this.channels.remove(id);
    this.deps.audit('notify_channel_delete', id, { kind: removed.kind, label: removed.label });
  }

  /** Sends a test message to one channel (and the inbox), even if the channel is paused. */
  async test(id: string): Promise<NotifyResult> {
    const label = id === INBOX_CHANNEL_ID ? 'Updates' : this.channels.require(id).label;
    this.deps.audit('notify_channel_test', id, {});
    const [result] = await this.dispatch([id], {
      title: `Test from WayStation: ${label}`,
      body: 'If you can read this, the channel works.',
      level: 'info',
      source: 'test',
    }, true);
    return result;
  }

  // ---- sending --------------------------------------------------------------------------------

  /** Always records to the inbox, then delivers to each listed channel in parallel. Never throws. */
  async send(channelIds: readonly string[], message: NotifyMessage): Promise<NotifyResult[]> {
    return this.dispatch(channelIds, message, false);
  }

  private async dispatch(channelIds: readonly string[], message: NotifyMessage, force: boolean): Promise<NotifyResult[]> {
    const ids = [...new Set(Array.isArray(channelIds) ? channelIds.filter((id): id is string => typeof id === 'string') : [])];
    try {
      const clean = cleanMessage(message, this.now());
      const entry = this.inbox.add(clean);
      this.emit('notification', entry);
      const results = await Promise.all(ids.map((id) => this.deliverTo(id, clean, force)));
      const deliveries = results.filter((result) => result.channelId !== INBOX_CHANNEL_ID);
      if (deliveries.length > 0) this.inbox.setDeliveries(entry, deliveries);
      return results;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return ids.map((channelId) => ({ channelId, ok: false, error: `notification failed: ${reason.slice(0, 200)}` }));
    }
  }

  private async deliverTo(id: string, message: CleanMessage, force: boolean): Promise<NotifyResult> {
    if (id === INBOX_CHANNEL_ID) return { channelId: id, ok: true };
    const channel = this.channels.find(id);
    if (!channel) return { channelId: id, ok: false, error: 'unknown channel' };
    if (!channel.enabled && !force) return { channelId: id, ok: false, error: 'channel is paused' };
    if (!this.channelLimiter.take(id)) return this.noted(id, { ok: false, error: 'rate limited: too many messages this minute' });
    const outcome = await deliverOnce({
      spec: CHANNEL_SPECS[channel.kind],
      config: channel.config,
      secrets: this.channels.secretsOf(id),
      message,
      io: this.io,
      timeoutMs: this.timeoutMs,
    });
    return this.noted(id, outcome);
  }

  private noted(channelId: string, outcome: { readonly ok: boolean; readonly error?: string }): NotifyResult {
    this.channels.noteDelivery(channelId, outcome.ok, outcome.error, this.now());
    return outcome.ok ? { channelId, ok: true } : { channelId, ok: false, error: outcome.error };
  }

  // ---- inbox ----------------------------------------------------------------------------------

  notifications(limit?: unknown): { notifications: NotificationEntry[]; unread: number } {
    return this.inbox.list(limit);
  }

  markRead(raw: unknown): number {
    return this.inbox.markRead(raw);
  }

  /** The operator's manual send from the UI. */
  async sendManual(raw: unknown): Promise<NotifyResult[]> {
    const body = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const channelIds = body.channelIds ?? [];
    if (!Array.isArray(channelIds) || !channelIds.every((id) => typeof id === 'string')) throw new LibraryInputError('channelIds must be a list');
    channelIds.forEach((id) => { if (id !== INBOX_CHANNEL_ID) this.channels.require(id); });
    const posted = parsePostedMessage(body);
    this.deps.audit('notify_send', channelIds.join(',') || INBOX_CHANNEL_ID, { title: posted.title });
    return this.send(channelIds, { ...posted, source: 'operator' });
  }

  // ---- the agents' notify tool ----------------------------------------------------------------

  contribute(loadout: LaunchLoadout, launch: ManagedLaunch): LoadoutContribution {
    const channelIds = [...new Set(loadout.notifyChannelIds ?? [])];
    if (channelIds.length === 0) return {};
    channelIds.forEach((id) => { if (id !== INBOX_CHANNEL_ID) this.channels.require(id); });
    if (!this.endpoint) throw new LibraryInputError('notifications endpoint not ready');
    const agentId = launch.agentId ?? '';
    if (!agentId) throw new LibraryInputError('the launch has no agent id');
    const token = this.tokens.issue(agentId, launch.name, channelIds);
    return {
      mcpServers: {
        notify: { command: process.execPath, args: [NOTIFY_MCP_SCRIPT], env: { [NOTIFY_URL_ENV]: this.endpoint }, inheritEnv: [NOTIFY_TOKEN_ENV] },
      },
      env: { [NOTIFY_TOKEN_ENV]: token },
      appendSystemPrompt: NOTIFY_PROMPT,
    };
  }

  /** The grant behind an agent's token, compared in constant time. */
  authenticate(token: string | undefined): AgentGrant | undefined {
    return this.tokens.find(token);
  }

  /** A post from an agent's notify tool. `name` is the agent's current display name, if known. */
  async postFromAgent(grant: AgentGrant, raw: unknown, name?: string): Promise<NotifyResult[]> {
    const posted = parsePostedMessage(raw);
    if (!this.agentLimiter.take(grant.agentId)) throw new LibraryInputError('too many updates this minute; send fewer, more meaningful ones');
    return this.send(grant.channelIds, { ...posted, source: `agent:${name || grant.name || grant.agentId}`, agentId: grant.agentId });
  }

  revoke(agentId: string): void {
    this.tokens.revoke(agentId);
  }
}
