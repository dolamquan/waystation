import { randomBytes, randomUUID } from 'node:crypto';
import type { ProcInfo } from '../collectors/processScanner.ts';
import type { Agent } from '../domain/types.ts';
import type { TowerStore } from '../store/db.ts';
import {
  ChannelError, addMember, createChannel, historyFor, isFor, markRead, memberByAgent, postMessage, removeMember, takeWake, unreadFor,
} from './board.ts';
import { CallerResolver, parseClaim } from './callerIdentity.ts';
import { fieldsOf, parseAddMember, parseChannelRef, parseCreate, parseSend, parseWait } from './channelInput.ts';
import { joinText, wakeText } from './prompts.ts';
import { CHANNEL_OPERATOR, type ChannelMember, type ChannelMessage, type ChannelState, type Delivery } from './types.ts';

/**
 * Channels between running agent sessions of any vendor. The operator decides membership; members
 * message each other through the CLI, and each message wakes its recipient through the tower's normal
 * instruct path (managed runner, Claude hook inbox or terminal), within the channel's loop guard.
 */

export interface ChannelHost {
  readonly agent: (agentId: string) => Agent | undefined;
  readonly agents: () => readonly Agent[];
  readonly processes: () => Promise<readonly ProcInfo[]>;
  /** Deliver text to a session; resolves with what happened, rejects when it cannot be delivered. */
  readonly instruct: (agentId: string, text: string) => Promise<string>;
  readonly audit: (action: string, target: string, detail: unknown) => void;
}

export type ChannelStore = Pick<TowerStore, 'loadRecords' | 'saveRecord' | 'deleteRecord'>;

export interface ChannelManagerOptions {
  /** Absolute path of ws-channel.mjs, quoted in the text agents receive. */
  readonly cliScript: string;
  readonly now?: () => number;
}

export interface ChannelMemberView extends ChannelMember {
  readonly agentName: string;
  readonly status: Agent['status'] | 'gone';
  readonly project?: string;
  readonly unread: number;
}

export interface ChannelView {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly createdAt: number;
  readonly members: readonly ChannelMemberView[];
  readonly messages: readonly ChannelMessage[];
}

/** A message as an agent sees it. */
export interface AgentMessage {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly at: string;
  readonly replyTo?: string;
}

export interface WaitResult {
  readonly channel: string;
  readonly messages: readonly AgentMessage[];
  readonly timedOut: boolean;
  readonly removed?: true;
}

interface Waiter {
  readonly channelId: string;
  readonly name: string;
  readonly from?: string;
  readonly finish: (result: WaitResult) => void;
}

const VIEW_MESSAGES = 100;
const INBOX_HISTORY = 20;

const toAgentMessage = (message: ChannelMessage): AgentMessage => ({
  id: message.id, from: message.from, to: message.to, text: message.text, at: new Date(message.ts).toISOString(),
  ...(message.replyTo ? { replyTo: message.replyTo } : {}),
});

export class ChannelManager {
  /** Required on every agent call (read from channels.json by the CLI): keeps other OS users' processes out. */
  readonly token = randomBytes(24).toString('hex');
  private channels = new Map<string, ChannelState>();
  private waiters: readonly Waiter[] = [];
  private readonly callers: CallerResolver;
  private readonly now: () => number;

  constructor(private readonly host: ChannelHost, private readonly store: ChannelStore, private readonly opts: ChannelManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.callers = new CallerResolver({ agent: host.agent, agents: host.agents, processes: host.processes, now: this.now });
    for (const channel of store.loadRecords<ChannelState>('channels')) this.channels.set(channel.id, channel);
  }

  // ── Operator ──────────────────────────────────────────────────────────

  list(): ChannelView[] {
    return [...this.channels.values()].sort((a, b) => b.createdAt - a.createdAt).map((channel) => this.view(channel));
  }

  create(raw: unknown): ChannelView {
    const { name, purpose } = parseCreate(raw);
    const channel = createChannel({ id: `ch_${randomUUID().slice(0, 8)}`, name, purpose, now: this.now() });
    if ([...this.channels.values()].some((other) => other.name === channel.name)) throw new ChannelError(`A channel named #${channel.name} already exists.`);
    this.commit(channel);
    this.host.audit('channel_create', channel.id, { name: channel.name });
    return this.view(channel);
  }

  remove(channelId: string): void {
    const channel = this.require(channelId);
    this.endWaits((waiter) => waiter.channelId === channelId);
    this.channels = new Map([...this.channels].filter(([id]) => id !== channelId));
    this.store.deleteRecord('channels', channelId);
    this.host.audit('channel_remove', channelId, { name: channel.name });
  }

  /** Adds a running session, then tells it about the channel (its notice also teaches agents without the skill). */
  async addMember(channelId: string, raw: unknown): Promise<{ member: ChannelMember; notice: string }> {
    const input = parseAddMember(raw);
    const agent = this.host.agent(input.agentId);
    if (!agent || agent.status === 'stopped') throw new ChannelError('That session is not running. Only running sessions can join a channel.');
    const next = addMember(this.require(channelId), { agentId: agent.id, vendor: agent.vendor, name: input.name ?? agent.name ?? agent.id }, this.now());
    const member = memberByAgent(next, agent.id)!;
    this.commit(next);
    this.host.audit('channel_member_add', channelId, { agentId: agent.id, name: member.name });
    const notice = await this.host.instruct(agent.id, joinText(next, member, this.opts.cliScript))
      .catch((error: Error) => `Added, but the session was not told: ${error.message}`);
    return { member, notice };
  }

  removeMember(channelId: string, name: string): void {
    this.commit(removeMember(this.require(channelId), name));
    this.endWaits((waiter) => waiter.channelId === channelId && waiter.name === name);
    this.host.audit('channel_member_remove', channelId, { name });
  }

  async postAsOperator(channelId: string, raw: unknown): Promise<Delivery[]> {
    const { to, text, replyTo } = parseSend(raw);
    const posted = postMessage(this.require(channelId), CHANNEL_OPERATOR, to, text, this.now(), replyTo);
    this.commit(posted.state);
    this.host.audit('channel_message', channelId, { from: CHANNEL_OPERATOR, to, chars: posted.message.text.length });
    return this.deliver(channelId, posted.message, true);
  }

  // ── Agents (through the CLI) ──────────────────────────────────────────

  async whoami(raw: unknown) {
    const agent = await this.callers.resolve(parseClaim(fieldsOf(raw).caller));
    const channels = this.membershipsOf(agent.id).map(({ channel, member }) => ({
      id: channel.id, name: channel.name, purpose: channel.purpose, you: member.name,
      peers: channel.members.filter((peer) => peer.name !== member.name)
        .map((peer) => ({ name: peer.name, vendor: peer.vendor, status: this.host.agent(peer.agentId)?.status ?? 'gone' })),
    }));
    return { agentId: agent.id, agentName: agent.name, channels };
  }

  async send(raw: unknown): Promise<{ channel: string; message: AgentMessage; deliveries: Delivery[] }> {
    const input = parseSend(raw);
    const { channel, member } = await this.callerIn(raw, input.channel);
    const posted = postMessage(channel, member.name, input.to, input.text, this.now(), input.replyTo);
    this.commit(posted.state);
    this.host.audit('channel_message', channel.id, { from: member.name, to: input.to, chars: posted.message.text.length });
    const deliveries = await this.deliver(channel.id, posted.message, input.wake);
    return { channel: channel.name, message: toAgentMessage(posted.message), deliveries };
  }

  /** Unread mail (now marked read); with `all`, the member's recent history instead. */
  async inbox(raw: unknown): Promise<{ channel: string; messages: AgentMessage[] }> {
    const fields = fieldsOf(raw);
    const { channel, member } = await this.callerIn(raw, parseChannelRef(fields));
    if (fields.all === true) return { channel: channel.name, messages: historyFor(channel, member.name, INBOX_HISTORY).map(toAgentMessage) };
    return { channel: channel.name, messages: this.takeUnread(channel.id, member.name) };
  }

  /** Waits for mail (optionally from one member), up to the timeout. A message handed to a waiter does not wake its session. */
  async wait(raw: unknown, signal?: AbortSignal): Promise<WaitResult> {
    const input = parseWait(raw);
    const { channel, member } = await this.callerIn(raw, input.channel);
    const unread = unreadFor(channel, member.name);
    if (unread.some((message) => !input.from || message.from === input.from)) {
      return { channel: channel.name, messages: this.takeUnread(channel.id, member.name), timedOut: false };
    }
    return new Promise<WaitResult>((resolve) => {
      const empty = { channel: channel.name, messages: [] as AgentMessage[] };
      const finish = (result: WaitResult) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.waiters = this.waiters.filter((other) => other !== waiter);
        resolve(result);
      };
      const onAbort = () => finish({ ...empty, timedOut: false });
      const timer = setTimeout(() => finish({ ...empty, timedOut: true }), input.timeoutSeconds * 1000);
      const waiter: Waiter = { channelId: channel.id, name: member.name, from: input.from, finish };
      this.waiters = [...this.waiters, waiter];
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ── Delivery ──────────────────────────────────────────────────────────

  private async deliver(channelId: string, message: ChannelMessage, wake: boolean): Promise<Delivery[]> {
    const recipients = this.require(channelId).members.filter((member) => isFor(message, member.name));
    const deliveries: Delivery[] = [];
    // One at a time: each wake reads the channel as the previous one left it.
    for (const member of recipients) deliveries.push(await this.deliverTo(channelId, member, message, wake));
    return deliveries;
  }

  private async deliverTo(channelId: string, member: ChannelMember, message: ChannelMessage, wake: boolean): Promise<Delivery> {
    const waiter = this.waiters.find((w) => w.channelId === channelId && w.name === member.name && (!w.from || w.from === message.from));
    if (waiter) {
      waiter.finish({ channel: this.require(channelId).name, messages: this.takeUnread(channelId, member.name), timedOut: false });
      return { to: member.name, via: 'waiting' };
    }
    if (!wake) return { to: member.name, via: 'inbox' };
    const taken = takeWake(this.require(channelId), this.now());
    this.commit(taken.state);
    if (!taken.allowed) return { to: member.name, via: 'inbox', note: 'The channel reached its wake-up limit; the message waits in the inbox.' };
    const unread = unreadFor(taken.state, member.name);
    if (unread.length === 0) return { to: member.name, via: 'inbox' };
    try {
      const note = await this.host.instruct(member.agentId, wakeText(taken.state, unread, this.opts.cliScript));
      const current = this.channels.get(channelId);
      if (current) this.commit(markRead(current, member.name, unread[unread.length - 1].seq));
      return { to: member.name, via: 'woken', note };
    } catch (error) {
      return { to: member.name, via: 'inbox', note: (error as Error).message };
    }
  }

  private takeUnread(channelId: string, name: string): AgentMessage[] {
    const channel = this.require(channelId);
    const unread = unreadFor(channel, name);
    if (unread.length > 0) this.commit(markRead(channel, name, unread[unread.length - 1].seq));
    return unread.map(toAgentMessage);
  }

  private endWaits(match: (waiter: Waiter) => boolean): void {
    for (const waiter of this.waiters.filter(match)) {
      waiter.finish({ channel: this.channels.get(waiter.channelId)?.name ?? '', messages: [], timedOut: false, removed: true });
    }
  }

  // ── State ─────────────────────────────────────────────────────────────

  private async callerIn(raw: unknown, channelRef: string | undefined): Promise<{ channel: ChannelState; member: ChannelMember }> {
    const agent = await this.callers.resolve(parseClaim(fieldsOf(raw).caller));
    const memberships = this.membershipsOf(agent.id);
    if (channelRef) {
      const found = memberships.find(({ channel }) => channel.name === channelRef || channel.id === channelRef);
      if (!found) throw new ChannelError(`This session is not a member of #${channelRef}.`);
      return found;
    }
    if (memberships.length === 1) return memberships[0];
    if (memberships.length === 0) throw new ChannelError('This session is not a member of any channel. Only the operator can add sessions to a channel.');
    const names = memberships.map(({ channel }) => `#${channel.name}`).join(', ');
    throw new ChannelError(`This session is in several channels (${names}): add --channel <name>.`);
  }

  private membershipsOf(agentId: string): Array<{ channel: ChannelState; member: ChannelMember }> {
    return [...this.channels.values()].sort((a, b) => a.createdAt - b.createdAt).flatMap((channel) => {
      const member = memberByAgent(channel, agentId);
      return member ? [{ channel, member }] : [];
    });
  }

  private require(channelId: string): ChannelState {
    const channel = this.channels.get(channelId);
    if (!channel) throw new ChannelError('Channel not found.');
    return channel;
  }

  private commit(channel: ChannelState): void {
    this.channels = new Map([...this.channels, [channel.id, channel]]);
    this.store.saveRecord('channels', channel);
  }

  private view(channel: ChannelState): ChannelView {
    return {
      id: channel.id, name: channel.name, purpose: channel.purpose, createdAt: channel.createdAt,
      members: channel.members.map((member) => {
        const agent = this.host.agent(member.agentId);
        return {
          ...member, agentName: agent?.name ?? member.name, status: agent?.status ?? 'gone',
          ...(agent?.project ? { project: agent.project } : {}), unread: unreadFor(channel, member.name).length,
        };
      }),
      messages: channel.messages.slice(-VIEW_MESSAGES),
    };
  }
}
