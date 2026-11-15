import { describe, expect, it } from 'vitest';
import type { ChannelView } from '../web/src/components/consoles/channelsApi.ts';
import type { ConnectPlan } from '../web/src/components/consoles/orchestration.ts';
import { connect, dispatch, type ChannelsClient } from '../web/src/components/consoles/orchestratorActions.ts';

/** An in-memory stand-in for the daemon's channel routes. */
function fakeChannels(options: { readonly refuse?: string } = {}) {
  let channels: ChannelView[] = [];
  const posts: Array<{ channelId: string; to: string; text: string }> = [];
  let seq = 0;
  const handle = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const client: ChannelsClient = {
    list: async () => channels,
    create: async ({ name, purpose }) => {
      const created: ChannelView = { id: `ch${++seq}`, name, purpose: purpose ?? '', createdAt: 0, members: [], messages: [] };
      channels = [...channels, created];
      return created;
    },
    addMember: async (channelId, agentId, name = agentId) => {
      if (agentId === options.refuse) throw new Error('That session is not running.');
      const member = { name: handle(name), agentId, vendor: 'claude', joinedAt: 0 };
      channels = channels.map((c) => (c.id === channelId ? { ...c, members: [...c.members, { ...member, agentName: name, status: 'idle' as const, unread: 0 }] } : c));
      return { member, notice: 'told' };
    },
    removeMember: async (channelId, name) => {
      channels = channels.map((c) => (c.id === channelId ? { ...c, members: c.members.filter((m) => m.name !== name) } : c));
    },
    post: async (channelId, to, text) => {
      posts.push({ channelId, to, text });
      return [{ to, via: 'woken' as const }];
    },
  };
  return { client, posts, channels: () => channels };
}

const plan = (lead = 'A'): ConnectPlan => ({
  hub: 'hub-p', hubPurpose: 'hub', waiting: 0,
  teams: [{
    id: 'g1', name: 'Front', channel: 'team-front',
    lead: lead === 'A' ? { agentId: 'A', name: 'Ann' } : { agentId: 'B', name: 'Bo' },
    agents: [{ agentId: 'A', name: 'Ann' }, { agentId: 'B', name: 'Bo' }, { agentId: 'C', name: 'Cy' }],
  }],
  solos: [{ agentId: 'S', name: 'Sol' }],
});

describe('connect', () => {
  it('creates the team channel and the hub, adds everyone, and tells each member who leads', async () => {
    const fake = fakeChannels();
    const result = await connect(plan(), fake.client, {});
    expect(result.notes).toEqual([]);
    const byName = Object.fromEntries(fake.channels().map((c) => [c.name, c.members.map((m) => m.agentId)]));
    expect(byName).toEqual({ 'team-front': ['A', 'B', 'C'], 'hub-p': ['A', 'S'] });
    expect(result.wiring.hub?.name).toBe('hub-p');
    expect(result.wiring.teams.g1?.name).toBe('team-front');
    expect(fake.posts.map((post) => post.to)).toEqual(['bo', 'cy']);
    expect(fake.posts[0]!.text).toContain('authorises ann to assign you tasks on #team-front');
    expect(result.briefed).toEqual({ 'team-front': 'A' });
  });
  it('is quiet when nothing changed, and tells the team again when the lead changes', async () => {
    const fake = fakeChannels();
    const first = await connect(plan(), fake.client, {});
    fake.posts.length = 0;
    await connect(plan(), fake.client, first.briefed);
    expect(fake.posts).toEqual([]);
    const changed = await connect(plan('B'), fake.client, first.briefed);
    expect(fake.posts.map((post) => post.to)).toEqual(['ann', 'cy']);
    expect(changed.briefed).toEqual({ 'team-front': 'B' });
  });
  it('takes out a member who left the team, and tells only a newcomer', async () => {
    const fake = fakeChannels();
    const first = await connect(plan(), fake.client, {});
    fake.posts.length = 0;
    const smaller: ConnectPlan = { ...plan(), teams: [{ ...plan().teams[0]!, agents: [{ agentId: 'A', name: 'Ann' }, { agentId: 'B', name: 'Bo' }, { agentId: 'D', name: 'Dee' }] }] };
    await connect(smaller, fake.client, first.briefed);
    expect(fake.channels().find((c) => c.name === 'team-front')!.members.map((m) => m.agentId)).toEqual(['A', 'B', 'D']);
    expect(fake.posts.map((post) => post.to)).toEqual(['dee']);
  });
  it('carries on past a session that cannot join, and says so', async () => {
    const fake = fakeChannels({ refuse: 'C' });
    const result = await connect(plan(), fake.client, {});
    expect(result.notes).toEqual(['Cy could not join #team-front: That session is not running.']);
    expect(fake.channels().find((c) => c.name === 'hub-p')!.members).toHaveLength(2);
  });
});

describe('dispatch', () => {
  it('connects, then sends the goal to every lead and solo agent', async () => {
    const fake = fakeChannels();
    const result = await dispatch({ goal: 'Build the landing page', target: { kind: 'all' }, mode: 'delegate', plan: plan(), client: fake.client, briefed: {} });
    expect(result.sentTo).toEqual(['Ann (lead of Front)', 'Sol']);
    expect(result.woken).toBe(2);
    expect(result.notes).toEqual([]);
    const commands = fake.posts.filter((post) => post.text.includes('Build the landing page'));
    expect(commands.map((post) => post.to)).toEqual(['ann', 'sol']);
    expect(commands[0]!.text).toContain('Your teammates on #team-front: bo, cy.');
  });
  it('reports a failed send without stopping the others', async () => {
    const fake = fakeChannels();
    const failing: ChannelsClient = {
      ...fake.client,
      post: async (channelId, to, text) => (text.includes('goal') && to === 'ann' ? Promise.reject(new Error('wake limit')) : fake.client.post(channelId, to, text)),
    };
    const result = await dispatch({ goal: 'the goal', target: { kind: 'all' }, mode: 'delegate', plan: plan(), client: failing, briefed: {} });
    expect(result.sentTo).toEqual(['Sol']);
    expect(result.notes).toEqual(['Ann (lead of Front): wake limit']);
  });
});
