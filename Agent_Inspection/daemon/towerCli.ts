import { managedProvider, type ManagedVendor } from '../shared/agentProviders.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { claudePaths } from './config.ts';
import type { AgentRegistry } from './domain/registry.ts';
import type { Agent } from './domain/types.ts';
import { summarize } from './domain/text.ts';
import type { TowerStore } from './store/db.ts';
import { claudeProjectSlug } from './collectors/claudeSessions.ts';
import type { ManagedAgents } from './managed/managedAgents.ts';
import { resolveCodexEntry } from './managed/codexRunner.ts';
import { claudeCliCommand, claudeMcpConfig, codexCliCommand, remoteHeaderPlan, resolveClaudeExe } from './managed/cliCommands.ts';
import type { ManagedLaunch, StdioMcpServer } from './managed/types.ts';
import { TOKEN_ENV } from './teams/teamManager.ts';
import { lookupProcess, stopProcessTree } from './actions/kill.ts';
import { isTicketId, type CliHandoffs, type CliSpec } from './actions/cliHandoffs.ts';
import type { Notifier } from './notify/notifier.ts';
import { UserError } from './userError.ts';

export const CLI_NAME: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex', copilot: 'GitHub Copilot' };
export const MANAGED_SOURCE = 'managed';

export type CliVendor = ManagedVendor;

/** A Waystation agent whose session is open in the operator's terminal. */
interface ParkedAgent {
  readonly launch: ManagedLaunch;
  readonly sessionId: string;
  /** Its CLI session's label in `cliSessions`. */
  readonly label: string;
  /** Set by Stop: when the terminal closes, end the agent instead of bringing it back. */
  readonly stopping: boolean;
}

/** What to start in the operator's terminal: the real CLI, optionally resuming a session and wired to a team. */
export interface CliRequest {
  readonly vendor: CliVendor;
  readonly cwd: string;
  readonly sessionId?: string;
  /** Open a copy of the session (it keeps running where it is) rather than continuing it. */
  readonly fork?: boolean;
  readonly model?: string;
  readonly mcpServers?: Readonly<Record<string, StdioMcpServer>>;
  readonly remoteMcpServers?: ManagedLaunch['remoteMcpServers'];
  /** Claude only: local plugin directories. */
  readonly plugins?: readonly string[];
  /** Secret environment the agent was launched with (forwarded MCP secrets). Never on argv. */
  readonly env?: Readonly<Record<string, string>>;
  readonly appendSystemPrompt?: string;
  readonly teamToken?: string;
  readonly sandbox?: boolean;
}

/** Where the CLI runs: the operator's own Windows Terminal tab (default), or a console on the board. */
export type CliLauncher = 'external' | 'console';

export interface TowerCliDeps {
  readonly registry: AgentRegistry;
  readonly store: TowerStore;
  readonly managed: ManagedAgents;
  readonly notifier: Notifier;
  readonly prepareMcp?: (launch: ManagedLaunch) => ManagedLaunch;
  readonly cliSessions: CliHandoffs;
  readonly hooksOn: () => boolean;
  /** Opens a terminal tab running the launcher for a ticket. */
  readonly launchCliTab: (ticketId: string, title: string) => Promise<void>;
  /**
   * Runs the same launcher for a ticket inside an in-app console and returns that console's id.
   * `onExit` runs when its process ends, so a closed console hands the agent back at once.
   */
  readonly launchCliConsole?: (ticketId: string, vendor: CliVendor, title: string, agentId: string | undefined, onExit: () => void) => Promise<string>;
  /** Ends an in-app console's process and unlinks it from its agent; used when its CLI session ended without the console closing. */
  readonly endConsole?: (consoleId: string) => void;
  /** True once the tower is stopping: nothing may be relaunched then. */
  readonly isShuttingDown?: () => boolean;
  /** True when the agent belongs to a team (those open through their team, in a terminal tab). */
  readonly isTeamMember?: (agentId: string) => boolean;
  readonly requireAgent: (agentId: string) => Agent;
  readonly queueHookMessage: (agentId: string, sessionId: string, text: string) => void;
  /** A team member opens through its team (it rejoins when the CLI closes); undefined for other agents. */
  readonly openTeamMember: (agentId: string, vendor: CliVendor) => Promise<{ message: string }> | undefined;
}

/** What a managed agent was launched with that its CLI session needs too: its MCP servers and plugins. */
function launchExtras(launch: ManagedLaunch): Pick<CliRequest, 'mcpServers' | 'remoteMcpServers' | 'plugins' | 'env'> {
  return {
    mcpServers: launch.mcpServers && Object.keys(launch.mcpServers).length ? launch.mcpServers : undefined,
    remoteMcpServers: launch.remoteMcpServers && Object.keys(launch.remoteMcpServers).length ? launch.remoteMcpServers : undefined,
    plugins: launch.vendor === 'claude' && launch.plugins?.length ? launch.plugins : undefined,
    env: launch.env,
  };
}

export function requireCli(vendor: CliVendor): void {
  if (!managedProvider(vendor)?.cli) throw new UserError('This provider uses managed sessions in Waystation; CLI handoff is not available.');
  if (vendor === 'claude' && !resolveClaudeExe()) {
    throw new UserError('Claude Code was not found. Install it (npm i -g @anthropic-ai/claude-code) or set AGENT_TOWER_CLAUDE_EXE.');
  }
  if (vendor === 'codex' && !resolveCodexEntry()) throw new UserError('Codex CLI not found (expected an npm global install of @openai/codex).');
}

/** Codex reads the team token from its environment (forwarded by name); Claude reads it from a private MCP config file. */
function cliSpec(request: CliRequest, mcpConfigPath: string | undefined): CliSpec {
  if (request.vendor === 'codex') {
    if (!request.sessionId) throw new UserError('Codex sessions can only be continued, not started, from here.');
    return {
      ...codexCliCommand(process.execPath, resolveCodexEntry()!, {
        resumeSessionId: request.sessionId, fork: request.fork, model: request.model, sandbox: request.sandbox,
        mcpServers: request.mcpServers, remoteMcpServers: request.remoteMcpServers,
        appendSystemPrompt: request.appendSystemPrompt,
      }),
      cwd: request.cwd,
      env: {
        ...request.env,
        ...remoteHeaderPlan(request.remoteMcpServers).env,
        ...(request.teamToken ? { [TOKEN_ENV]: request.teamToken } : {}),
      },
    };
  }
  return {
    ...claudeCliCommand(resolveClaudeExe()!, {
      resumeSessionId: request.sessionId,
      fork: request.fork,
      model: request.model,
      mcpConfig: mcpConfigPath,
      appendSystemPrompt: request.appendSystemPrompt,
      plugins: request.plugins,
    }),
    cwd: request.cwd,
    env: {},
  };
}

/** Sessions moved to the real Claude Code / Codex CLI in the operator's terminal, and how they come back. */
export class TowerCli {
  /** Managed agents whose session moved to the real CLI: their runner's last updates must not re-list them. */
  private handedOff = new Set<string>();
  private opening = new Set<string>();
  /** Waystation agents open in the operator's terminal: they come back here when it closes, and only Stop ends them. */
  private parked = new Map<string, ParkedAgent>();

  constructor(private readonly deps: TowerCliDeps) {}

  isHandedOff(agentId: string): boolean { return this.handedOff.has(agentId); }

  isParked(agentId: string): boolean { return this.parked.has(agentId); }

  parkedIdForSession(sessionId: string): string | undefined {
    return [...this.parked].find(([, parked]) => parked.sessionId === sessionId)?.[0];
  }

  /** Continue a managed agent's own session in the real Claude Code / Codex CLI. Team members rejoin when it closes. */
  async open(agentId: string, launcher: CliLauncher = 'external'): Promise<{ message: string; consoleId?: string }> {
    // One hand-off at a time per agent: a double click must not open the same session twice.
    if (this.opening.has(agentId)) throw new UserError('This agent is already being opened in the CLI.');
    this.opening = new Set([...this.opening, agentId]);
    try {
      return await this.openOnce(agentId, launcher);
    } finally {
      this.opening = new Set([...this.opening].filter((id) => id !== agentId));
    }
  }

  private async openOnce(agentId: string, launcher: CliLauncher): Promise<{ message: string; consoleId?: string }> {
    const agent = this.deps.requireAgent(agentId);
    const runner = this.deps.managed.get(agentId);
    if (!runner) return this.openCopy(agent, launcher);
    const vendor = agent.vendor === 'other' ? 'claude' : agent.vendor;
    requireCli(vendor);
    if (launcher === 'console' && this.deps.isTeamMember?.(agentId)) {
      throw new UserError('Team members open through their team, in a terminal tab.');
    }
    const asMember = this.deps.openTeamMember(agentId, vendor);
    if (asMember) return asMember;
    if (agent.status === 'busy' || agent.status === 'waiting') {
      throw new UserError('This agent is mid-turn. Wait for it to finish (or interrupt it), then try again.');
    }
    if (!runner.sessionId || !agent.cwd || !runner.launch) throw new UserError('This agent has no session to continue yet.');
    this.deps.store.audit('open_cli', agentId, { vendor, sessionId: runner.sessionId });
    const label = `agent:${agentId}`;
    // Recorded before the tab opens, so closing the terminal at any point brings the agent back here.
    this.parked = new Map([...this.parked, [agentId, { launch: runner.launch, sessionId: runner.sessionId, label, stopping: false }]]);
    // Open the tab first: if that fails, the agent keeps running here untouched. The CLI only starts once
    // its launcher has checked in, by which time the idle runner below has been stopped.
    let consoleId: string | undefined;
    try {
      ({ consoleId } = await this.openTab(
        { vendor, cwd: agent.cwd, sessionId: runner.sessionId, model: runner.model, ...launchExtras(runner.launch) },
        label, `${CLI_NAME[vendor]} · ${agent.name}`,
        () => this.returnFromTerminal(agentId),
        launcher, agentId,
      ));
    } catch (error) {
      this.parked = new Map([...this.parked].filter(([id]) => id !== agentId));
      throw error;
    }
    // The launcher can already have died (bad ticket, missing exe) while the tab opened.
    if (!this.parked.has(agentId)) throw new UserError('The CLI session ended before it started, so the agent stayed in Waystation.');
    const card = runner.snapshot();
    this.handedOff = new Set([...this.handedOff, agentId]);
    // The session belongs to the CLI from here on, whether or not the runner stops cleanly.
    await runner.stop().catch((error: Error) => console.error(`[tower] stopping ${agentId} after hand-off failed:`, error));
    // A launcher that died while the runner was stopping already brought the agent back (and cleared `parked`).
    if (!this.parked.has(agentId)) throw new UserError('The CLI session ended before it started, so the agent stayed in Waystation.');
    this.deps.managed.forget(agentId);
    // The agent stays listed (and stoppable) while it is in the terminal.
    this.deps.registry.upsert(MANAGED_SOURCE, {
      ...card,
      status: 'idle',
      pid: undefined,
      inTerminal: true,
      canInstruct: vendor === 'claude' && this.deps.hooksOn(),
      currentActivity: consoleId ? `Open in a console (${CLI_NAME[vendor]})` : `Open in your terminal (${CLI_NAME[vendor]})`,
    });
    return consoleId
      ? { message: `Opened in a ${CLI_NAME[vendor]} console on the board. When you close it, the agent comes back to Waystation and waits.`, consoleId }
      : { message: `Opened in ${CLI_NAME[vendor]}. When you close that terminal, the agent comes back to Waystation and waits.` };
  }

  /** The terminal closed: relaunch the agent on its session, idle, under the same id. Only Stop ends it. */
  private returnFromTerminal(agentId: string): void {
    // The tower is closing (consoles are being killed): launching a runner now would outlive the shutdown.
    if (this.deps.isShuttingDown?.()) return;
    const parked = this.parked.get(agentId);
    if (!parked) return;
    this.parked = new Map([...this.parked].filter(([id]) => id !== agentId));
    this.handedOff = new Set([...this.handedOff].filter((id) => id !== agentId));
    if (parked.stopping) {
      this.deps.registry.drop(MANAGED_SOURCE, agentId);
      return;
    }
    try {
      this.deps.managed.launch({ ...parked.launch, agentId, prompt: '', resumeSessionId: parked.sessionId, fork: false });
      this.deps.registry.pushEvent({ agentId, ts: Date.now(), kind: 'system', summary: 'Back from your terminal; waiting for instructions' });
    } catch (error) {
      console.error(`[tower] bringing ${agentId} back from the terminal failed:`, error);
      this.deps.registry.pushEvent({ agentId, ts: Date.now(), kind: 'error', summary: `Could not bring this agent back: ${(error as Error).message}` });
      this.deps.registry.drop(MANAGED_SOURCE, agentId);
    }
  }

  /** Stop from Waystation while the agent is in the terminal: close that CLI session and end the agent. */
  async stopParked(agentId: string): Promise<void> {
    const parked = this.parked.get(agentId);
    if (!parked) return;
    this.deps.store.audit('stop', agentId, { inTerminal: true, sessionId: parked.sessionId });
    this.parked = new Map([...this.parked, [agentId, { ...parked, stopping: true }]]);
    const session = this.deps.cliSessions.find(parked.label);
    const launcherPid = session?.pids[0];
    if (session && launcherPid) {
      const proc = await lookupProcess(launcherPid);
      // Only ever our own launcher for this ticket (pids are reused); taking it down closes the CLI it started.
      const ours = proc && /^node(\.exe)?$/i.test(proc.name) && proc.commandLine.includes('launchCli.ts') && proc.commandLine.includes(session.id);
      if (ours) await stopProcessTree(launcherPid);
    }
    this.deps.registry.pushEvent({ agentId, ts: Date.now(), kind: 'stop', summary: 'Stopped from the tower (its terminal session was closed)' });
    if (session) this.deps.cliSessions.ended(session.id);
    else this.returnFromTerminal(agentId);
  }

  /** Instructions for an agent in the terminal reach it through the Claude Code hooks, like your own sessions. */
  instructParked(agentId: string, text: string): string {
    const parked = this.parked.get(agentId);
    if (!parked || parked.launch.vendor !== 'claude' || !this.deps.hooksOn()) {
      throw new UserError('This agent is open in your terminal. Type there, or close that terminal to hand it back to Waystation.');
    }
    this.deps.queueHookMessage(agentId, parked.sessionId, text);
    this.deps.registry.pushEvent({ agentId, ts: Date.now(), kind: 'system', summary: `Queued instruction: ${summarize(text, 160)}` });
    return 'Queued for its terminal session: delivered after its next tool call, or with the next prompt you type there.';
  }

  /**
   * A session that runs outside the tower (your own Claude Code, or a Codex thread in your editor) is already
   * open somewhere: continuing it here would put two writers on one conversation. Open a copy instead.
   */
  private async openCopy(agent: Agent, launcher: CliLauncher): Promise<{ message: string; consoleId?: string }> {
    const vendor = agent.vendor === 'claude' || agent.vendor === 'codex' ? agent.vendor : undefined;
    if (!vendor) throw new UserError('Only Claude Code and Codex sessions can be opened in their CLI.');
    if (!agent.sessionId) throw new UserError('This session has no id recorded yet, so it cannot be opened in the CLI.');
    if (!agent.cwd || !existsSync(agent.cwd)) throw new UserError('This session\'s project folder was not found.');
    requireCli(vendor);
    // Claude Code writes a transcript only once a session has a conversation; without one there is nothing to resume.
    const hasConversation = vendor === 'codex'
      || existsSync(join(claudePaths.projects, claudeProjectSlug(agent.cwd), `${agent.sessionId}.jsonl`));
    this.deps.store.audit('open_cli_copy', agent.id, { vendor, sessionId: agent.sessionId, fresh: !hasConversation });
    // A copy is a new session: nothing links it to the original agent, so no agent id is passed on.
    const { consoleId } = await this.openTab(
      hasConversation ? { vendor, cwd: agent.cwd, sessionId: agent.sessionId, fork: true } : { vendor, cwd: agent.cwd },
      `copy:${agent.id}:${Date.now()}`,
      hasConversation ? `${CLI_NAME[vendor]} · copy of ${agent.name}` : `${CLI_NAME[vendor]} · ${agent.project}`,
      () => undefined,
      launcher,
    );
    return {
      message: hasConversation
        ? `Opened a copy of this conversation in ${CLI_NAME[vendor]}${consoleId ? ' on the board' : ''}. The original keeps running where it is.`
        : `This session has no conversation yet, so a new ${CLI_NAME[vendor]} session was opened in its folder.`,
      ...(consoleId ? { consoleId } : {}),
    };
  }

  started(ticketId: string, raw: unknown): void {
    const pid = (raw as Record<string, unknown> | undefined)?.pid;
    if (!isTicketId(ticketId) || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) throw new UserError('Unknown session.');
    if (!this.deps.cliSessions.started(ticketId, pid)) throw new UserError('Unknown session.');
  }

  ended(ticketId: string): void {
    if (!isTicketId(ticketId)) throw new UserError('Unknown session.');
    this.deps.cliSessions.ended(ticketId);
  }

  /** Writes the ticket and opens its terminal tab. `onEnd` runs when that CLI session ends (or the tab fails to start it). */
  async openTab(
    request: CliRequest, label: string, title: string, onEnd: () => void, launcher: CliLauncher = 'external', agentId?: string,
  ): Promise<{ consoleId?: string }> {
    const { notifier, cliSessions } = this.deps;
    const notified = notifier.attachDefaults({ ...request, prompt: '', agentId: `cli:${randomUUID()}` });
    const prepared = this.deps.prepareMcp?.(notified) ?? notified;
    request = { ...request, ...prepared };
    // Set once the console exists; a session that ends first (launcher never checked in) must not leave it running.
    let consoleId: string | undefined;
    const finish = () => {
      if (prepared.agentId) notifier.revoke(prepared.agentId);
      if (consoleId) this.deps.endConsole?.(consoleId);
      onEnd();
    };
    const secrets: Record<string, string> = { ...request.env, ...(request.teamToken ? { [TOKEN_ENV]: request.teamToken } : {}) };
    // Written to the tower's private folder next to the ticket and deleted when the session ends.
    const mcpFile = request.vendor === 'claude' && (request.mcpServers || request.remoteMcpServers)
      ? JSON.stringify(claudeMcpConfig(request.mcpServers ?? {}, secrets, request.remoteMcpServers ?? {}, true))
      : undefined;
    let ticketId: string;
    try {
      ticketId = cliSessions.create(
        (sidecarPath) => cliSpec(request, mcpFile ? sidecarPath('mcp.json') : undefined),
        { label }, finish, mcpFile ? { 'mcp.json': mcpFile } : {},
      );
    } catch (error) {
      if (prepared.agentId) notifier.revoke(prepared.agentId);
      throw error instanceof UserError ? error : new UserError(`Could not prepare the CLI session: ${(error as Error).message}`);
    }
    try {
      if (launcher === 'console') {
        if (!this.deps.launchCliConsole) throw new Error('consoles are not available');
        consoleId = await this.deps.launchCliConsole(ticketId, request.vendor, title, agentId, () => cliSessions.ended(ticketId));
        // Ended while the console was starting: nothing else will close it.
        if (!cliSessions.has(label)) this.deps.endConsole?.(consoleId);
        return { consoleId };
      }
      await this.deps.launchCliTab(ticketId, title);
      return {};
    } catch (error) {
      cliSessions.discard(ticketId);
      if (prepared.agentId) notifier.revoke(prepared.agentId);
      throw new UserError(launcher === 'console'
        ? `Could not open the console (${(error as Error).message}).`
        : `Could not open Windows Terminal (${(error as Error).message}).`);
    }
  }

  /** The session now belongs to the CLI: drop the managed copy so collectors list the CLI session instead. */
  handOver(agentId: string): void {
    this.handedOff = new Set([...this.handedOff, agentId]);
    this.deps.managed.forget(agentId);
    this.deps.registry.drop(MANAGED_SOURCE, agentId);
  }
}
