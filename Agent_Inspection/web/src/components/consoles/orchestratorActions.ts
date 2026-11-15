/**
 * The orchestrator's two network actions, over the daemon's channel routes: wiring a plan into channels ("Connect"),
 * and sending one command through them. The channel client is passed in, so both are tested without a daemon.
 */
import type { AddedMember, ChannelView, Delivery, NewChannel } from './channelsApi.ts';
import {
  memberNotice, planPosts, wantedMembers, type ConnectPlan, type Mode, type Target, type Wiring,
} from './orchestration.ts';

export interface ChannelsClient {
  readonly list: () => Promise<readonly ChannelView[]>;
  readonly create: (input: NewChannel) => Promise<ChannelView>;
  readonly addMember: (channelId: string, agentId: string, name?: string) => Promise<AddedMember>;
  readonly removeMember: (channelId: string, name: string) => Promise<void>;
  readonly post: (channelId: string, to: string, text: string) => Promise<readonly Delivery[]>;
}

export interface ConnectResult {
  readonly wiring: Wiring;
  /** Problems worth showing (an agent that could not join, a full channel); empty when everything went in. */
  readonly notes: readonly string[];
  /** The updated record of which lead each team channel's members were told about. */
  readonly briefed: Readonly<Record<string, string>>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Makes the channels match the plan: creates missing ones, adds missing members, removes members that left their team.
 * Then tells each team's members who leads it, once per lead (again only when the lead changes or a member is new).
 */
export async function connect(plan: ConnectPlan, client: ChannelsClient, briefed: Readonly<Record<string, string>>): Promise<ConnectResult> {
  const notes: string[] = [];
  const existing = await client.list();
  const added = new Map<string, Set<string>>();

  for (const wanted of wantedMembers(plan)) {
    let channel = existing.find((candidate) => candidate.name === wanted.channel);
    if (!channel) {
      try { channel = await client.create({ name: wanted.channel, purpose: wanted.purpose }); } catch (error) {
        notes.push(`#${wanted.channel}: ${messageOf(error)}`);
        continue;
      }
    }
    const keep = new Set(wanted.agents.map((agent) => agent.agentId));
    for (const member of channel.members.filter((candidate) => !keep.has(candidate.agentId))) {
      await client.removeMember(channel.id, member.name).catch((error: unknown) => { notes.push(`${member.name}: ${messageOf(error)}`); });
    }
    const joined = new Set<string>();
    for (const agent of wanted.agents.filter((candidate) => !channel.members.some((member) => member.agentId === candidate.agentId))) {
      try {
        await client.addMember(channel.id, agent.agentId, agent.name);
        joined.add(agent.agentId);
      } catch (error) {
        notes.push(`${agent.name} could not join #${wanted.channel}: ${messageOf(error)}`);
      }
    }
    added.set(wanted.channel, joined);
  }

  const fresh = await client.list();
  const byName = (name: string | undefined) => (name ? fresh.find((channel) => channel.name === name) : undefined);
  const wiring: Wiring = {
    hub: byName(plan.hub),
    teams: Object.fromEntries(plan.teams.flatMap((team) => {
      const channel = byName(team.channel);
      return channel ? [[team.id, channel] as const] : [];
    })),
  };

  const nextBriefed: Record<string, string> = { ...briefed };
  for (const team of plan.teams) {
    const channel = team.channel ? wiring.teams[team.id] : undefined;
    const leadHandle = channel?.members.find((member) => member.agentId === team.lead.agentId)?.name;
    if (!channel || !leadHandle) continue;
    const leadChanged = briefed[channel.name] !== team.lead.agentId;
    const fresher = added.get(channel.name) ?? new Set<string>();
    const tell = channel.members.filter((member) => member.agentId !== team.lead.agentId && (leadChanged || fresher.has(member.agentId)));
    for (const member of tell) {
      await client.post(channel.id, member.name, memberNotice({ team: team.name, lead: leadHandle, teamChannel: channel.name }))
        .catch((error: unknown) => { notes.push(`${member.name} was not told who leads ${team.name}: ${messageOf(error)}`); });
    }
    nextBriefed[channel.name] = team.lead.agentId;
  }
  return { wiring, notes, briefed: nextBriefed };
}

export interface DispatchResult {
  readonly sentTo: readonly string[];
  readonly woken: number;
  readonly queued: number;
  /** Teams or agents not reached, and connection problems. */
  readonly notes: readonly string[];
  readonly briefed: Readonly<Record<string, string>>;
}

/** Connects (so a command never goes out over stale wiring), then sends the command to every recipient it plans. */
export async function dispatch(input: {
  readonly goal: string;
  readonly target: Target;
  readonly mode: Mode;
  readonly plan: ConnectPlan;
  readonly client: ChannelsClient;
  readonly briefed: Readonly<Record<string, string>>;
}): Promise<DispatchResult> {
  const connected = await connect(input.plan, input.client, input.briefed);
  const { posts, skipped } = planPosts(input.goal, input.target, input.mode, input.plan, connected.wiring);
  const notes = [...connected.notes, ...skipped.map((name) => `${name} is not connected yet.`)];
  const sentTo: string[] = [];
  let woken = 0;
  let queued = 0;
  for (const post of posts) {
    try {
      const deliveries = await input.client.post(post.channelId, post.to, post.text);
      sentTo.push(post.label);
      woken += deliveries.filter((delivery) => delivery.via !== 'inbox').length;
      queued += deliveries.filter((delivery) => delivery.via === 'inbox').length;
    } catch (error) {
      notes.push(`${post.label}: ${messageOf(error)}`);
    }
  }
  return { sentTo, woken, queued, notes, briefed: connected.briefed };
}
