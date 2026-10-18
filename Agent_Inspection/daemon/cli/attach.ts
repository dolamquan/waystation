// Terminal console for one agent or one team: `npm run attach -- agent|team <id or name>`,
// or Waystation's "Open in terminal" buttons. It talks to the daemon exactly like the UI does.
import { clearLine, createInterface, cursorTo, type Interface } from 'node:readline';
import { styleText } from 'node:util';
import { WebSocket, type RawData } from 'ws';
import { WS_PROTOCOL } from '../api/security.ts';
import { TOWER_HOME } from '../config.ts';
import { clip } from '../domain/text.ts';
import type { Agent, AgentEvent, PendingInterception } from '../domain/types.ts';
import type { TeamLogEntry, TeamMember, TeamView } from '../teams/types.ts';
import {
  AGENT_HELP, TEAM_HELP, findTarget, parseAgentLine, parseAttachArgs, parseTeamLine, type AgentCommand, type TeamCommand,
} from './attachCommands.ts';
import {
  STATUS_WORD, TEAM_STATUS_WORD, agentBanner, eventKey, isVisibleLogEntry, logKey, renderEvent, renderLogEntry,
  renderMembers, renderPending, renderTasks, sanitize, teamBanner, type Line, type Tone,
} from './attachRender.ts';
import { readDaemonInfo } from './daemonInfo.ts';

const BACKLOG_SIZE = 40;
const USAGE = 'Usage: npm run attach -- agent <id or name>   |   npm run attach -- team <id or name> [--all]';
const TONE_STYLE: Record<Exclude<Tone, 'plain'>, Parameters<typeof styleText>[0]> = {
  dim: 'dim', info: 'cyan', ok: 'green', warn: 'yellow', error: 'red', you: 'magenta',
};

interface TowerState { readonly agents: Agent[]; readonly pending: PendingInterception[]; readonly teams: TeamView[] }
interface MemberDiff { readonly stat: string; readonly patch: string; readonly truncated: boolean }
type ServerMessage =
  | { readonly type: 'snapshot'; readonly agents: Agent[]; readonly pending: PendingInterception[]; readonly teams: TeamView[] }
  | { readonly type: 'agents'; readonly agents: Agent[] }
  | { readonly type: 'event'; readonly event: AgentEvent }
  | { readonly type: 'pending'; readonly pending: PendingInterception[] }
  | { readonly type: 'teams'; readonly teams: TeamView[] }
  | { readonly type: 'team_log'; readonly entry: TeamLogEntry };
type Outcome = 'quit' | void;

interface Mode {
  readonly backlog: () => Promise<void>;
  readonly onMessage: (message: ServerMessage) => void;
  readonly onLine: (line: string) => Promise<Outcome>;
}

const enc = encodeURIComponent;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

class TowerClient {
  constructor(private readonly port: number, private readonly token: string) {}

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-tower-token': this.token },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
    return data as T;
  }

  /** The token rides in the subprotocol list, as it does for the browser. */
  socket(): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${this.port}/ws`, [WS_PROTOCOL, this.token]);
  }
}

/** Prints above the prompt without mangling what the operator is typing. */
class Screen {
  private readonly tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  constructor(private readonly rl: Interface) {}

  print(lines: Line | readonly Line[]): void {
    const list = (Array.isArray(lines) ? lines : [lines]) as readonly Line[];
    if (this.tty) {
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
    }
    // Single choke point: every printed line is sanitized, whatever field it came from.
    for (const { text, tone } of list) {
      const safe = sanitize(text);
      process.stdout.write(`${tone === 'plain' ? safe : styleText(TONE_STYLE[tone], safe)}\n`);
    }
    this.prompt();
  }

  note(text: string, tone: Tone = 'dim'): void {
    this.print({ text, tone });
  }

  setPrompt(text: string): void {
    this.rl.setPrompt(text);
    this.prompt();
  }

  prompt(): void {
    if (this.tty) this.rl.prompt(true);
  }

  confirm(question: string): Promise<boolean> {
    return new Promise((resolve) => this.rl.question(`${question} [y/N] `, (answer) => resolve(/^y(es)?$/i.test(answer.trim()))));
  }
}

interface Ctx { readonly client: TowerClient; readonly screen: Screen; readonly state: TowerState }

/** Held tool calls for the agents this console watches, answered oldest first. */
class Approvals {
  private pending: PendingInterception[] = [];
  private readonly announced = new Set<string>();

  constructor(private readonly ctx: Ctx, private readonly nameOf: (agentId: string) => string | undefined) {}

  update(all: readonly PendingInterception[]): void {
    this.pending = all.filter((item) => this.nameOf(item.agentId) !== undefined);
    for (const item of this.pending) {
      if (this.announced.has(item.id)) continue;
      this.announced.add(item.id);
      this.ctx.screen.print(renderPending(item, this.nameOf(item.agentId) ?? 'agent'));
    }
  }

  async answer(command: { kind: 'approve' } | { kind: 'deny'; message?: string } | { kind: 'ask' }): Promise<void> {
    const next = this.pending[0];
    if (!next) {
      this.ctx.screen.note('Nothing is waiting for your approval.');
      return;
    }
    const decision = command.kind === 'approve' ? { behavior: 'allow' }
      : command.kind === 'deny' ? { behavior: 'deny', ...(command.message ? { message: command.message } : {}) }
      : { behavior: 'ask' };
    await this.ctx.client.request('POST', `/api/interceptions/${enc(next.id)}`, decision);
    this.pending = this.pending.slice(1);
    const verb = command.kind === 'approve' ? 'Approved' : command.kind === 'deny' ? 'Denied' : 'Handed to Claude Code\'s prompt:';
    this.ctx.screen.note(`${verb} ${next.toolName}.`, 'ok');
  }
}

const helpLines = (lines: readonly string[]): Line[] => lines.map((text) => ({ text, tone: 'dim' as const }));

// ---- agent console --------------------------------------------------------------------------

async function runAgentCommand(ctx: Ctx, agent: Agent, approvals: Approvals, command: AgentCommand): Promise<Outcome> {
  const { client, screen } = ctx;
  const path = `/api/agents/${enc(agent.id)}`;
  switch (command.kind) {
    case 'none': return;
    case 'quit': return 'quit';
    case 'help': screen.print(helpLines(AGENT_HELP)); return;
    case 'error': screen.note(command.message, 'error'); return;
    case 'approve': case 'deny': case 'ask': return approvals.answer(command);
    case 'say': screen.note((await client.request<{ message: string }>('POST', `${path}/instruct`, { text: command.text })).message); return;
    case 'interrupt': await client.request('POST', `${path}/interrupt`); screen.note('Interrupted.', 'ok'); return;
    case 'intercept':
      await client.request('POST', `${path}/intercept`, { on: command.on });
      screen.note(command.on ? 'Tool calls now wait for your approval.' : 'Tool calls run without approval again.', 'ok');
      return;
    case 'stop':
      if (!(await screen.confirm(`Stop ${sanitize(agent.name)}? This ends the session.`))) return screen.note('Not stopped.');
      await client.request('POST', `${path}/stop`, { confirm: true });
      screen.note('Stopped.', 'ok');
  }
}

function agentMode(ctx: Ctx, initial: Agent): Mode {
  const { client, screen } = ctx;
  const label = clip(sanitize(initial.name), 28);
  const seen = new Set<string>();
  const approvals = new Approvals(ctx, (agentId) => (agentId === initial.id ? label : undefined));
  let current: Agent | undefined = initial;
  let promptText = '';

  const showEvent = (event: AgentEvent) => {
    if (event.agentId !== initial.id || seen.has(eventKey(event))) return;
    seen.add(eventKey(event));
    screen.print(renderEvent(event));
  };
  const onAgents = (agents: readonly Agent[]) => {
    const next = agents.find((agent) => agent.id === initial.id);
    if (!next && current) screen.note('This agent is no longer listed by the tower. It has exited.', 'warn');
    current = next;
    const text = `${label} · ${current ? STATUS_WORD[current.status] : 'gone'} › `;
    if (text !== promptText) screen.setPrompt((promptText = text));
  };

  return {
    backlog: async () => {
      screen.print(agentBanner(initial));
      const { events } = await client.request<{ events: AgentEvent[] }>('GET', `/api/agents/${enc(initial.id)}/events`);
      events.slice(-BACKLOG_SIZE).forEach(showEvent);
    },
    onMessage: (message) => {
      if (message.type === 'snapshot' || message.type === 'agents') onAgents(message.agents);
      if (message.type === 'snapshot' || message.type === 'pending') approvals.update(message.pending);
      if (message.type === 'event') showEvent(message.event);
    },
    onLine: (line) => runAgentCommand(ctx, current ?? initial, approvals, parseAgentLine(line)),
  };
}

// ---- team console ---------------------------------------------------------------------------

interface TeamAccess { readonly team: () => TeamView | undefined; readonly agents: () => readonly Agent[] }

function printDiff(screen: Screen, member: TeamMember, diff: MemberDiff, full: boolean): void {
  if (!diff.stat.trim()) return screen.note(`${member.name} has no changes yet.`);
  screen.print(diff.stat.split('\n').map((text) => ({ text: sanitize(text), tone: 'dim' as const })));
  if (!full) return screen.note(`Type /diff ${member.name} full to see the patch.`);
  screen.print(diff.patch.split('\n').map((text): Line => ({
    text: sanitize(text),
    tone: text.startsWith('+') ? 'ok' : text.startsWith('-') ? 'error' : text.startsWith('@@') ? 'info' : 'plain',
  })));
  if (diff.truncated) screen.note(`The patch was cut short. Open ${member.worktree} to see everything.`, 'warn');
}

async function runMemberCommand(
  ctx: Ctx, team: TeamView, command: Extract<TeamCommand, { kind: 'diff' | 'merge' | 'attach' }>,
): Promise<void> {
  const { client, screen } = ctx;
  const member = team.members.find((candidate) => candidate.name === command.member);
  if (!member) return screen.note(`No member named "${command.member}". Members: ${team.members.map((m) => m.name).join(', ')}.`, 'error');
  const path = `/api/teams/${enc(team.id)}/members/${enc(member.id)}`;
  if (command.kind === 'diff') {
    return printDiff(screen, member, (await client.request<{ diff: MemberDiff }>('GET', `${path}/diff`)).diff, command.full);
  }
  if (command.kind === 'merge') {
    if (!(await screen.confirm(`Merge ${member.branch} into ${team.baseBranch} in ${team.repoRoot}?`))) return screen.note('Not merged.');
    return screen.note((await client.request<{ message: string }>('POST', `${path}/merge`, { confirm: true })).message, 'ok');
  }
  if (!member.agentId) return screen.note(`${member.name} hasn't started yet. It starts when it gets its first message.`);
  await client.request('POST', '/api/terminal', { kind: 'agent', id: member.agentId });
  screen.note(`Opened ${member.name}'s console in a new tab.`, 'ok');
}

async function runTeamCommand(
  ctx: Ctx, access: TeamAccess, approvals: Approvals, setEverything: (on: boolean) => void, command: TeamCommand,
): Promise<Outcome> {
  const { client, screen } = ctx;
  switch (command.kind) {
    case 'none': return;
    case 'quit': return 'quit';
    case 'help': screen.print(helpLines(TEAM_HELP)); return;
    case 'error': screen.note(command.message, 'error'); return;
    case 'approve': case 'deny': case 'ask': return approvals.answer(command);
    case 'filter':
      setEverything(command.everything);
      screen.note(command.everything ? 'Showing everything, including member tool activity.' : 'Showing the team channel only.');
      return;
  }
  const team = access.team();
  if (!team) return screen.note('This team no longer exists.', 'error');
  const path = `/api/teams/${enc(team.id)}`;
  switch (command.kind) {
    case 'say': screen.note((await client.request<{ message: string }>('POST', `${path}/message`, { to: command.to, text: command.text })).message); return;
    case 'tasks': screen.print(renderTasks(team.tasks)); return;
    case 'members': screen.print(renderMembers(team, access.agents())); return;
    case 'pause': await client.request('POST', `${path}/pause`); screen.note('Team paused. Members finish their current turn.', 'ok'); return;
    case 'resume': await client.request('POST', `${path}/resume`); screen.note('Team resumed.', 'ok'); return;
    default: return runMemberCommand(ctx, team, command);
  }
}

function teamMode(ctx: Ctx, initial: TeamView, everythingAtStart: boolean): Mode {
  const { client, screen } = ctx;
  const seen = new Set<string>();
  let team: TeamView | undefined = initial;
  let agents: readonly Agent[] = ctx.state.agents;
  let everything = everythingAtStart;
  let promptText = '';
  const approvals = new Approvals(ctx, (agentId) => team?.members.find((member) => member.agentId === agentId)?.name);

  const showEntry = (entry: TeamLogEntry) => {
    if (entry.teamId !== initial.id || seen.has(logKey(entry))) return;
    seen.add(logKey(entry));
    if (isVisibleLogEntry(entry, everything)) screen.print(renderLogEntry(entry));
  };
  const onTeams = (teams: readonly TeamView[]) => {
    const next = teams.find((candidate) => candidate.id === initial.id);
    if (!next && team) screen.note('This team was disbanded.', 'warn');
    team = next;
    const text = `${clip(sanitize(initial.name), 24)} · ${team ? TEAM_STATUS_WORD[team.status] : 'gone'} › `;
    if (text !== promptText) screen.setPrompt((promptText = text));
  };
  const access: TeamAccess = { team: () => team, agents: () => agents };

  return {
    backlog: async () => {
      screen.print(teamBanner(initial, everything));
      const { entries } = await client.request<{ entries: TeamLogEntry[] }>('GET', `/api/teams/${enc(initial.id)}/log`);
      entries.filter((entry) => isVisibleLogEntry(entry, everything)).slice(-BACKLOG_SIZE).forEach(showEntry);
    },
    onMessage: (message) => {
      if (message.type === 'snapshot' || message.type === 'agents') agents = message.agents;
      if (message.type === 'snapshot' || message.type === 'teams') onTeams(message.teams);
      if (message.type === 'snapshot' || message.type === 'pending') approvals.update(message.pending);
      if (message.type === 'team_log') showEntry(message.entry);
    },
    onLine: (line) => runTeamCommand(ctx, access, approvals, (on) => { everything = on; }, parseTeamLine(line)),
  };
}

// ---- wiring ---------------------------------------------------------------------------------

function parseMessage(raw: RawData): ServerMessage | undefined {
  try {
    const message = JSON.parse(raw.toString()) as { type?: unknown };
    return typeof message.type === 'string' ? message as ServerMessage : undefined;
  } catch {
    return undefined;
  }
}

/** Live updates are held back until the backlog is on screen, so nothing prints out of order. */
function connect(client: TowerClient, mode: Mode): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = client.socket();
    const held: ServerMessage[] = [];
    let ready = false;
    ws.on('message', (raw) => {
      const message = parseMessage(raw);
      if (!message) return;
      if (ready) mode.onMessage(message);
      else held.push(message);
    });
    // Persistent listeners: a failure before the backlog is shown rejects; afterwards main()'s close handler reports it.
    ws.on('error', (error) => { if (!ready) reject(error); });
    ws.on('close', () => { if (!ready) reject(new Error('the tower closed the connection')); });
    ws.once('open', () => {
      mode.backlog().then(() => {
        ready = true;
        for (const message of held.splice(0)) mode.onMessage(message);
        resolve(ws);
      }, reject);
    });
  });
}

function printTargets(state: TowerState): void {
  const row = (id: string, name: string, status: string) => `  ${sanitize(id).padEnd(46)} ${clip(sanitize(name), 40).padEnd(40)} ${status}`;
  const agents = state.agents.map((agent) => row(agent.id, agent.name, STATUS_WORD[agent.status]));
  const teams = state.teams.map((team) => row(team.id, team.name, TEAM_STATUS_WORD[team.status]));
  process.stdout.write([
    'Agents', ...(agents.length ? agents : ['  (none)']), '', 'Teams', ...(teams.length ? teams : ['  (none)']), '', USAGE, '',
  ].join('\n'));
}

function pick<T extends { id: string; name: string }>(items: readonly T[], query: string, kind: string): T {
  const { match, error } = findTarget(items, query);
  return match ?? fail(`${error ?? `No ${kind} found.`}\nRun \`npm run attach\` to list what you can attach to.`);
}

async function main(): Promise<void> {
  const args = parseAttachArgs(process.argv.slice(2));
  if ('error' in args) fail(`${args.error}\n${USAGE}`);
  const { port, token } = readDaemonInfo(args.home ?? TOWER_HOME)
    ?? fail('The tower is not running. Start it with `npm start`, then try again.');
  const client = new TowerClient(port, token);
  const state = await client.request<TowerState>('GET', '/api/state')
    .catch((error: Error) => fail(`Could not reach the tower on port ${port}: ${error.message}`));
  if (!args.kind || !args.query) return printTargets(state);
  const agent = args.kind === 'agent' ? pick(state.agents, args.query, 'agent') : undefined;
  const team = args.kind === 'team' ? pick(state.teams, args.query, 'team') : undefined;

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
  const screen = new Screen(rl);
  const ctx: Ctx = { client, screen, state };
  const mode = agent ? agentMode(ctx, agent) : teamMode(ctx, team!, args.everything);
  const ws = await connect(client, mode).catch((error: Error) => fail(`Could not connect to the tower: ${error.message}`));

  let quitting = false;
  const quit = () => {
    if (quitting) return;
    quitting = true;
    ws.close();
    rl.close();
    process.stdout.write('Detached. Everything keeps running in the tower.\n', () => process.exit(0));
  };
  ws.on('close', () => {
    if (quitting) return;
    screen.note('Lost the connection to the tower. It may have stopped; run this command again once it is back.', 'error');
    process.exitCode = 1;
    rl.close();
  });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    queue = queue.then(async () => {
      try {
        if ((await mode.onLine(line)) === 'quit') quit();
      } catch (error) {
        screen.note((error as Error).message, 'error');
      }
    });
  });
  rl.on('SIGINT', quit);
  // End of input (Ctrl+D, or piped commands) finishes the queued commands before detaching.
  rl.on('close', () => { if (process.exitCode !== 1) void queue.then(quit); });
  screen.prompt();
}

void main();
