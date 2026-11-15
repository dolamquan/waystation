import { describe, expect, it } from 'vitest';
import type { ConsoleInfo } from '../web/src/api.ts';
import type { BoardItem } from '../web/src/components/consoles/boardItems.ts';
import type { CanvasGroup } from '../web/src/components/consoles/canvasGroups.ts';
import type { ChannelView } from '../web/src/components/consoles/channelsApi.ts';
import {
  MAX_GOAL, ORCHESTRATION_KEY, buildRoster, connectPlan, describeRecipients, hubChannelName, nameList, leadBrief, loadOrchestration, missingMembers, planPosts,
  saveOrchestration, teamChannelName, wantedMembers, type ConnectPlan, type Wiring,
} from '../web/src/components/consoles/orchestration.ts';

const NOW = 100_000;

function consoleItem(id: string, kind: ConsoleInfo['kind'] = 'claude', extra: Partial<ConsoleInfo> = {}): BoardItem {
  const info = { id, name: `Agent ${id}`, kind, cwd: 'c:/proj', state: 'running', createdAt: 1, lastOutputAt: 0, agentId: `ag-${id}`, ...extra } as ConsoleInfo;
  return { key: `console:${id}`, origin: 'console', console: info };
}
const group = (id: string, name: string, members: string[]): CanvasGroup => ({ id, name, members, arranged: true });

function channel(id: string, name: string, members: Array<[handle: string, agentId: string]>): ChannelView {
  return {
    id, name, purpose: '', createdAt: 0, messages: [],
    members: members.map(([handle, agentId]) => ({ name: handle, agentId, vendor: 'claude', joinedAt: 0, agentName: handle, status: 'idle', unread: 0 })),
  };
}

describe('buildRoster', () => {
  const items = [
    consoleItem('a'), consoleItem('b'), consoleItem('c', 'codex'), consoleItem('s'),
    consoleItem('sh', 'shell'), consoleItem('dead', 'claude', { state: 'exited' }), consoleItem('new', 'claude', { agentId: undefined }),
  ];
  const groups = [group('g1', 'Front', ['console:a', 'console:b']), group('g2', 'Back', ['console:c', 'console:new'])];

  it('groups agents by team, leaves shells and exited sessions out, and puts the rest in no team', () => {
    const roster = buildRoster(items, groups, {}, NOW);
    expect(roster.teams.map((team) => [team.name, team.members.map((m) => m.key)])).toEqual([
      ['Front', ['console:a', 'console:b']], ['Back', ['console:c', 'console:new']],
    ]);
    expect(roster.solos.map((agent) => agent.key)).toEqual(['console:s']);
    expect(roster.total).toBe(5);
    expect(roster.teams[1]!.members[0]!.vendor).toBe('Codex');
  });
  it('makes the first member the lead unless another was chosen, and counts who is working', () => {
    const roster = buildRoster([...items, consoleItem('w', 'claude', { attention: 'working' })], groups, { g1: 'console:b' }, NOW);
    expect(roster.teams[0]!.leadKey).toBe('console:b');
    expect(roster.teams[1]!.leadKey).toBe('console:c');
    expect(roster.working).toBe(1);
  });
  it('counts a tile in two groups only once', () => {
    const roster = buildRoster(items, [group('g1', 'One', ['console:a']), group('g2', 'Two', ['console:a', 'console:b'])], {}, NOW);
    expect(roster.teams.map((team) => team.members.map((m) => m.key))).toEqual([['console:a'], ['console:b']]);
  });
});

describe('connectPlan', () => {
  it('gives a channel to teams of two or more, puts leads and solos in the hub, and waits for unlinked sessions', () => {
    const roster = buildRoster([consoleItem('a'), consoleItem('b'), consoleItem('c'), consoleItem('n', 'claude', { agentId: undefined }), consoleItem('s')],
      [group('g1', 'Front', ['console:a', 'console:b']), group('g2', 'Solo team', ['console:c', 'console:n'])], { g2: 'console:n' }, NOW);
    const plan = connectPlan(roster, 'folder:c:/proj', 'proj');
    expect(plan.teams[0]!.channel).toBe(teamChannelName({ id: 'g1', name: 'Front' }));
    expect(plan.teams[1]!.channel).toBeUndefined(); // only one linked agent: nobody to delegate to
    expect(plan.teams[1]!.lead.agentId).toBe('ag-c'); // the chosen lead is not linked yet, so the linked one leads
    expect(plan.waiting).toBe(1);
    const hub = wantedMembers(plan).find((wanted) => wanted.channel === plan.hub)!;
    expect(hub.agents.map((agent) => agent.agentId)).toEqual(['ag-a', 'ag-c', 'ag-s']);
  });
  it('names channels the way the daemon would keep them, distinct per team and project', () => {
    const name = teamChannelName({ id: 'abc-123', name: 'Front End & Docs!!' });
    expect(name).toMatch(/^[a-z0-9-]{1,32}$/);
    expect(name).not.toBe(teamChannelName({ id: 'xyz-999', name: 'Front End & Docs!!' }));
    expect(hubChannelName('folder:c:/a/app', 'app')).not.toBe(hubChannelName('folder:c:/b/app', 'app'));
    expect(hubChannelName('k', '')).toMatch(/^hub-board-/);
  });
});

describe('sending a command', () => {
  const plan: ConnectPlan = {
    hub: 'hub-p', hubPurpose: '', waiting: 0,
    teams: [
      { id: 'g1', name: 'Front', channel: 'team-front', lead: { agentId: 'A', name: 'Ann' }, agents: [{ agentId: 'A', name: 'Ann' }, { agentId: 'B', name: 'Bo' }] },
      { id: 'g2', name: 'Back', lead: { agentId: 'C', name: 'Cy' }, agents: [{ agentId: 'C', name: 'Cy' }] },
    ],
    solos: [{ agentId: 'S', name: 'Sol' }],
  };
  const wiring: Wiring = {
    hub: channel('h', 'hub-p', [['ann', 'A'], ['cy', 'C'], ['sol', 'S']]),
    teams: { g1: channel('t1', 'team-front', [['ann', 'A'], ['bo', 'B']]) },
  };

  it('via leads: each lead gets a brief naming its teammates and the other leads; solo agents get theirs', () => {
    const { posts, skipped } = planPosts('Ship the page', { kind: 'all' }, 'delegate', plan, wiring);
    expect(skipped).toEqual([]);
    expect(posts.map((post) => [post.channelId, post.to])).toEqual([['h', 'ann'], ['h', 'cy'], ['h', 'sol']]);
    expect(posts[0]!.text).toContain('Ship the page');
    expect(posts[0]!.text).toContain('Your teammates on #team-front: bo.');
    expect(posts[0]!.text).toContain('Other leads on #hub-p: cy, sol.');
    expect(posts[1]!.text).toContain('only member of your team');
    expect(posts[2]!.text).toContain('You are working on your own.');
  });
  it('everyone: a team with a channel gets one message to all of it', () => {
    const { posts } = planPosts('Stop and commit', { kind: 'all' }, 'everyone', plan, wiring);
    expect(posts.map((post) => [post.channelId, post.to])).toEqual([['t1', 'all'], ['h', 'cy'], ['h', 'sol']]);
    expect(posts[0]!.text).toContain('From your operator');
  });
  it('one team or one agent only', () => {
    expect(planPosts('x', { kind: 'team', id: 'g1' }, 'delegate', plan, wiring).posts.map((post) => post.to)).toEqual(['ann']);
    const toBo = planPosts('x', { kind: 'agent', agentId: 'B' }, 'delegate', plan, wiring).posts;
    expect(toBo.map((post) => [post.channelId, post.to])).toEqual([['t1', 'bo']]);
  });
  it('reports who it could not reach when the channels are not wired', () => {
    const { posts, skipped } = planPosts('x', { kind: 'all' }, 'delegate', plan, { teams: {} });
    expect(posts).toEqual([]);
    expect(skipped).toEqual(['Front', 'Back', 'Sol']);
  });
  it('a full-length goal still fits the daemon message limit', () => {
    const brief = leadBrief({ goal: 'x'.repeat(MAX_GOAL), team: 'T'.repeat(40), teamChannel: 'team-t', teammates: Array(11).fill('handle-name-long'), hub: 'hub-p', otherLeads: Array(11).fill('lead-name-long') });
    expect(brief.length).toBeLessThanOrEqual(8000);
  });
  it('counts members still missing from their channels', () => {
    expect(missingMembers(plan, [wiring.hub!, wiring.teams.g1!])).toBe(0);
    expect(missingMembers(plan, [wiring.teams.g1!])).toBe(3);
  });
});

describe('remembered leads', () => {
  function fakeStorage(initial: Record<string, string> = {}): Storage {
    const data = new Map(Object.entries(initial));
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } } as unknown as Storage;
  }
  it('round-trips, and drops anything that is not a string map', () => {
    const storage = fakeStorage();
    saveOrchestration({ leads: { g1: 'console:a' }, briefed: { 'team-x': 'A' } }, storage);
    expect(loadOrchestration(storage)).toEqual({ leads: { g1: 'console:a' }, briefed: { 'team-x': 'A' } });
    const junk = fakeStorage({ [ORCHESTRATION_KEY]: JSON.stringify({ leads: { g: 7, h: 'ok' }, briefed: [1] }) });
    expect(loadOrchestration(junk)).toEqual({ leads: { h: 'ok' }, briefed: {} });
    expect(loadOrchestration(fakeStorage({ [ORCHESTRATION_KEY]: '{bad' }))).toEqual({ leads: {}, briefed: {} });
  });
});

describe('describeRecipients (the "Goes to" line)', () => {
  const plan: ConnectPlan = {
    hub: 'hub-p', hubPurpose: '', waiting: 0,
    teams: [
      { id: 'g1', name: 'Front', channel: 'team-front', lead: { agentId: 'A', name: 'Ann' }, agents: [{ agentId: 'A', name: 'Ann' }, { agentId: 'B', name: 'Bo' }] },
      { id: 'g2', name: 'Back', lead: { agentId: 'C', name: 'Cy' }, agents: [{ agentId: 'C', name: 'Cy' }] },
    ],
    solos: [{ agentId: 'S', name: 'Sol' }],
  };
  it('names the leads (and what they lead) and solo agents, and says leads split the work', () => {
    expect(describeRecipients(plan, { kind: 'all' }, 'delegate')).toBe('Goes to Ann (leads Front), Cy and Sol. Each lead splits the goal among its teammates.');
  });
  it('counts every agent when everyone gets the same words', () => {
    expect(describeRecipients(plan, { kind: 'all' }, 'everyone')).toBe('Goes to all 4 agents, word for word.');
    expect(describeRecipients(plan, { kind: 'team', id: 'g1' }, 'everyone')).toBe('Goes to all 2 agents in Front, word for word.');
  });
  it('one team goes to its lead; one agent only to that agent; nobody gives an empty line', () => {
    expect(describeRecipients(plan, { kind: 'team', id: 'g2' }, 'delegate')).toBe('Goes to Cy.');
    expect(describeRecipients(plan, { kind: 'agent', agentId: 'B' }, 'delegate')).toBe('Goes to Bo only.');
    expect(describeRecipients({ ...plan, teams: [], solos: [] }, { kind: 'all' }, 'delegate')).toBe('');
  });
  it('shortens long name lists', () => {
    expect(nameList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
    expect(nameList(['a', 'b'])).toBe('a and b');
    expect(nameList(['a'])).toBe('a');
  });
});
