import { vi } from 'vitest';
import type { Agent, AgentStatus } from '../daemon/domain/types.ts';
import type { LaunchLoadout } from '../daemon/library/types.ts';
import type { ManagedLaunch, ManagedRunner } from '../daemon/managed/types.ts';
import { TowerStore } from '../daemon/store/db.ts';
import { TeamManager, type TeamHost } from '../daemon/teams/teamManager.ts';
import type { TeamLogEntry } from '../daemon/teams/types.ts';
import { makeAgent, makeRepo, tempDir } from './helpers.ts';

/** Shared fakes for the teamCore* tests: a managed agent whose status, session and cost the test drives. */
export class CoreRunner implements ManagedRunner {
  readonly sent: string[] = [];
  status: AgentStatus = 'busy';
  sessionId: string | undefined;
  costUsd: number | undefined;
  /** Set to make the next send() reject, as when a wake cannot reach the agent. */
  failSend: Error | undefined;
  constructor(readonly id: string, readonly launch: ManagedLaunch, readonly loadout: LaunchLoadout | undefined) {}
  snapshot(): Agent {
    return makeAgent({
      id: this.id, tier: 'A', vendor: this.launch.vendor, status: this.status, name: this.launch.name ?? '',
      sessionId: this.sessionId, usage: this.costUsd === undefined ? undefined : { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, costUsd: this.costUsd },
    });
  }
  async send(text: string) {
    if (this.failSend) throw this.failSend;
    this.sent.push(text);
    this.status = 'busy';
  }
  async interrupt() {}
  setIntercepting() {}
  async stop() { this.status = 'stopped'; }
  get token(): string { return this.launch.env!.AGENT_TOWER_TEAM_TOKEN; }
}

export const MEMBERS = [
  { name: 'lead', role: 'lead', vendor: 'claude', focus: 'Owns the plan and reviews' },
  { name: 'api', role: 'worker', vendor: 'claude', focus: 'Backend endpoints' },
  { name: 'ui', role: 'worker', vendor: 'claude' },
];

const managers: TeamManager[] = [];

/** Call from afterEach: archives every team the test created and removes its worktrees. */
export async function cleanup(): Promise<void> {
  for (const manager of managers.splice(0)) {
    for (const team of manager.list()) await manager.disband(team.id, { removeWorktrees: true }).catch(() => undefined);
  }
}

export function coreHarness(opts: { store?: TowerStore; now?: () => number } = {}) {
  const runners: CoreRunner[] = [];
  const store = opts.store ?? new TowerStore(':memory:');
  const host: TeamHost = {
    launch: (launch, loadout) => {
      const runner = new CoreRunner(`managed:${runners.length + 1}`, launch, loadout);
      runners.push(runner);
      return runner.snapshot();
    },
    runner: (id) => runners.find((r) => r.id === id),
    agent: (id) => runners.find((r) => r.id === id)?.snapshot(),
    audit: vi.fn(),
    codexAvailable: () => true,
  };
  const teams = new TeamManager(host, store, { teamsDir: tempDir('teams-'), mcpScript: 'team-mcp.mjs', nodePath: 'node', now: opts.now });
  teams.setEndpoint('http://127.0.0.1:1');
  managers.push(teams);
  const events: TeamLogEntry[] = [];
  teams.on('log', (entry) => events.push(entry));
  const idle = (runner: CoreRunner) => {
    runner.status = 'idle';
    teams.onAgent(runner.snapshot());
  };
  const call = (runner: CoreRunner, name: string, args: Record<string, unknown> = {}) => teams.callForToken(runner.token, name, args);
  const view = () => teams.list()[0];
  const member = (name: string) => view().members.find((m) => m.name === name)!;
  const runnerFor = (name: string) => runners.filter((r) => r.launch.name?.endsWith(`· ${name}`)).at(-1);
  return { teams, runners, store, host, events, idle, call, view, member, runnerFor };
}

export async function startCoreTeam(extra: Record<string, unknown> = {}, h = coreHarness()) {
  const repo = makeRepo();
  const { team } = await h.teams.create({ name: 'Core', goal: 'Add login', cwd: repo, members: MEMBERS, ...extra });
  return { ...h, repo, team };
}
