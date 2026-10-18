import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { MANAGED_ENV_FLAG, paths } from '../config.ts';
import type { Agent, AgentEvent, AgentStatus, EventKind } from '../domain/types.ts';
import { describeToolInput, projectName, summarize, summarizeBlock, taskTitle } from '../domain/text.ts';
import type { ManagedHost, ManagedLaunch, ManagedRunner } from './types.ts';
import { stopProcessTree } from '../actions/kill.ts';
import { UsageMeter, codexExecTurnUsage } from '../usage/usageMeter.ts';
import { codexMcpArgs, codexRemoteMcpArgs, remoteHeaderPlan } from './cliCommands.ts';
import { activityFromEvent } from '../../shared/plainActivity.ts';
import { waystationInstructions } from './waystationContext.ts';
import { extractImageRefs } from './attachments.ts';

/** Resolve the npm-installed Codex CLI entry so we can spawn it without a shell. */
export function resolveCodexEntry(): string | undefined {
  const appData = process.env.APPDATA;
  const candidates = [
    process.env.AGENT_TOWER_CODEX_JS,
    appData ? join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : undefined,
  ];
  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && existsSync(candidate));
}

type Json = Record<string, unknown>;

export { codexMcpArgs, codexRemoteMcpArgs } from './cliCommands.ts';

export function codexArgs(entry: string, launch: ManagedLaunch, threadId?: string, images: readonly string[] = []): string[] {
  const options = [
    '--json',
    // `--image=` form: the flag takes several values, so a bare `-i path` could swallow the trailing `-`.
    ...images.map(image => `--image=${image}`),
    '--skip-git-repo-check',
    '-c', `developer_instructions=${JSON.stringify(waystationInstructions(launch))}`,
    ...(launch.model ? ['-m', launch.model] : []),
    ...(launch.writeRoot ? ['-c', 'sandbox_mode="workspace-write"'] : []),
    ...codexMcpArgs(launch.mcpServers),
    ...codexRemoteMcpArgs(launch.remoteMcpServers),
  ];
  return threadId
    ? [entry, 'exec', 'resume', threadId, ...options, '-']
    : [entry, 'exec', ...options, '-C', launch.cwd, '-'];
}

/** The codex process environment: secrets (stdio `inheritEnv`, remote MCP headers) travel here, never on argv. */
export function codexEnv(launch: ManagedLaunch, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...launch.env, ...remoteHeaderPlan(launch.remoteMcpServers).env, [MANAGED_ENV_FLAG]: '1' };
}

/** `codex exec --json` line -> tower event. */
export function normalizeCodexExecLine(line: Json): { kind: EventKind; summary: string; threadId?: string; tool?: AgentEvent['tool'] } | undefined {
  if (line.type === 'thread.started' && typeof line.thread_id === 'string') {
    return { kind: 'system', summary: 'thread started', threadId: line.thread_id };
  }
  if (line.type === 'turn.completed') return { kind: 'status', summary: 'turn complete' };
  if (line.type === 'turn.failed' || line.type === 'error') return { kind: 'error', summary: summarize(JSON.stringify(line)) };
  const item = line.item as Json | undefined;
  if ((line.type === 'item.completed' || line.type === 'item.started') && item) {
    if (item.type === 'agent_message' && typeof item.text === 'string') return { kind: 'assistant', summary: summarize(item.text) };
    if (item.type === 'command_execution' && line.type === 'item.started') {
      return { kind: 'tool_call', summary: describeToolInput('shell', { command: item.command }), tool: {
        id: typeof item.id === 'string' ? item.id : undefined, name: 'shell', command: typeof item.command === 'string' ? item.command : undefined,
      } };
    }
    if (item.type === 'command_execution' && line.type === 'item.completed') return {
      kind: 'tool_result', summary: `Command finished${typeof item.exit_code === 'number' ? ` (exit ${item.exit_code})` : ''}`,
      tool: { id: typeof item.id === 'string' ? item.id : undefined, name: 'shell', command: typeof item.command === 'string' ? item.command : undefined,
        exitCode: typeof item.exit_code === 'number' ? item.exit_code : undefined,
        output: typeof item.aggregated_output === 'string' ? summarizeBlock(item.aggregated_output, 8000) : undefined },
    };
    if (item.type === 'file_change' && line.type === 'item.completed') {
      const changes = Array.isArray(item.changes) ? item.changes as Json[] : [];
      return { kind: 'tool_call', summary: changes.map(change => `*** Update File: ${String(change.path ?? '')}`).join(' ') || 'edited files' };
    }
  }
  return undefined;
}

/** Tier A Codex agent: each turn is a `codex exec` (or `codex exec resume`) process. */
export class CodexRunner implements ManagedRunner {
  readonly id: string;
  private threadId: string | undefined;
  private child: ChildProcess | undefined;
  private status: AgentStatus = 'busy';
  private activity: string | undefined;
  private lastEventAt = Date.now();
  private readonly startedAt = Date.now();
  private stopped = false;
  private readonly pendingPrompts: string[] = [];
  private readonly meter: UsageMeter;
  private lastError: string | undefined;

  constructor(readonly launch: ManagedLaunch, private readonly host: ManagedHost, private readonly entry: string) {
    this.id = launch.agentId ?? `managed:${randomUUID()}`;
    this.meter = new UsageMeter(launch.model);
    // Continuing an earlier thread (e.g. back from the operator's terminal): its first turn already had the briefing.
    this.threadId = launch.resumeSessionId;
    if (launch.prompt) {
      this.event('prompt', summarize(launch.prompt));
      this.runTurn(launch.prompt);
      return;
    }
    this.status = 'idle';
    this.publish();
  }

  get sessionId(): string | undefined {
    return this.threadId;
  }

  get model(): string | undefined {
    return this.launch.model;
  }

  snapshot(): Agent {
    return {
      id: this.id,
      vendor: 'codex',
      tier: 'A',
      name: this.launch.name ?? taskTitle(this.launch.prompt) ?? `Managed Codex · ${projectName(this.launch.cwd)}`,
      sessionId: this.threadId,
      pid: this.child?.pid,
      cwd: this.launch.cwd,
      project: projectName(this.launch.cwd),
      status: this.status,
      source: `codex exec${this.launch.model ? ` · ${this.launch.model}` : ''} · launched here`,
      currentActivity: this.activity,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      hooked: false,
      intercepting: false,
      canInstruct: !this.stopped,
      model: this.meter.model,
      usage: this.meter.snapshot(),
      lastError: this.lastError,
    };
  }

  async send(text: string): Promise<void> {
    if (this.stopped) throw new Error('agent has stopped');
    if (this.pendingPrompts.length >= 20) throw new Error('Codex already has 20 queued messages. Wait for it to finish a turn before sending more.');
    this.event('prompt', summarize(extractImageRefs(text, paths.attachmentsDir).text));
    if (this.child) {
      this.pendingPrompts.push(text);
      this.event('system', `Message queued for the next turn (${this.pendingPrompts.length} pending)`);
      return;
    }
    this.runTurn(text);
  }

  async interrupt(): Promise<void> {
    this.cancelPending('the task was interrupted');
    if (this.child?.pid) await stopProcessTree(this.child.pid);
    this.event('system', 'Turn interrupted from the tower');
  }

  setIntercepting(): void {
    throw new Error('Per-tool interception is not available for Codex agents.');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelPending('the agent was stopped');
    try {
      if (this.child?.pid) await stopProcessTree(this.child.pid);
    } finally {
      this.status = 'stopped';
      this.event('stop', 'Stopped from the tower');
      this.host.onExit(this.id);
    }
  }

  private runTurn(message: string): void {
    // Pasted images travel as `[Image #N: path]` references; Codex takes them as --image files.
    const { text: prompt, images } = extractImageRefs(message, paths.attachmentsDir);
    const child = spawn(process.execPath, codexArgs(this.entry, this.launch, this.threadId, images.map(image => image.path)), {
      cwd: this.launch.cwd,
      env: codexEnv(this.launch),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.status = 'busy';
    // Standing instructions live in config, including on resume. The user's text stays unchanged.
    child.stdin?.end(prompt);
    createInterface({ input: child.stdout! }).on('line', (raw) => this.onLine(raw));
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    // A spawn failure may emit 'error' without 'close': never leave the agent stuck "busy".
    child.on('error', (error) => {
      if (this.child !== child) return;
      if (this.child === child) this.child = undefined;
      this.cancelPending('Codex could not start');
      if (!this.stopped) this.status = 'idle';
      this.event('error', summarize(error.message));
    });
    child.on('close', (code) => {
      if (this.child !== child) return;
      if (this.child === child) this.child = undefined;
      if (this.stopped) return;
      if (code !== 0) this.lastError = summarize(stderr.trim() || `codex exited with code ${code}`, 300);
      if (code !== 0 && stderr.trim()) this.event('error', summarize(stderr));
      if (code !== 0) this.cancelPending('the Codex turn failed');
      const next = this.pendingPrompts.shift();
      if (next !== undefined) {
        if (!this.threadId) {
          this.pendingPrompts.unshift(next);
          this.cancelPending('Codex did not return a conversation id');
        } else {
          this.event('system', 'Starting queued message on the same Codex conversation');
          this.runTurn(next);
          return;
        }
      }
      this.status = 'idle';
      this.publish();
    });
    this.publish();
  }

  private cancelPending(reason: string): void {
    const count = this.pendingPrompts.length;
    this.pendingPrompts.length = 0;
    if (count) this.event('system', `${count} queued message${count === 1 ? '' : 's'} cancelled because ${reason}. Send them again to continue.`);
  }

  private onLine(raw: string): void {
    let parsed: Json;
    try {
      parsed = JSON.parse(raw) as Json;
    } catch {
      return;
    }
    const turnUsage = codexExecTurnUsage(parsed);
    if (turnUsage) {
      this.meter.addTurn(turnUsage);
      this.lastError = undefined;
    }
    const normalized = normalizeCodexExecLine(parsed);
    if (!normalized) return;
    if (normalized.kind === 'error') this.lastError = summarize(normalized.summary, 300);
    if (normalized.threadId) this.threadId = normalized.threadId;
    this.event(normalized.kind, normalized.summary, normalized.tool);
  }

  private event(kind: EventKind, summary: string, tool?: AgentEvent['tool']): void {
    this.lastEventAt = Date.now();
    if (kind !== 'status' && kind !== 'system') this.activity = activityFromEvent({ kind, summary });
    this.host.onEvent({ agentId: this.id, ts: this.lastEventAt, kind, summary, ...(tool ? { tool } : {}) });
    this.publish();
  }

  private publish(): void {
    this.host.onAgent(this.snapshot());
  }
}
