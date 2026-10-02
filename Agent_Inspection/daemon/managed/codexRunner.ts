import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { MANAGED_ENV_FLAG } from '../config.ts';
import type { Agent, AgentStatus, EventKind } from '../domain/types.ts';
import { describeToolInput, projectName, summarize } from '../domain/text.ts';
import type { ManagedHost, ManagedLaunch, ManagedRunner } from './types.ts';
import { stopProcessTree } from '../actions/kill.ts';

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

/** TOML-safe literal: JSON strings and string arrays are valid TOML basic strings/arrays. */
const toml = (value: string | readonly string[]) => JSON.stringify(value);
const tomlTable = (env: Readonly<Record<string, string>>) =>
  `{${Object.entries(env).map(([key, value]) => `${key}=${toml(value)}`).join(', ')}}`;

/** `-c` overrides that register stdio MCP servers for this run, auto-approving their tools. */
export function codexMcpArgs(servers: ManagedLaunch['mcpServers']): string[] {
  return Object.entries(servers ?? {}).flatMap(([name, server]) => {
    const envNames = [...Object.keys(server.env), ...(server.inheritEnv ?? [])];
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !envNames.every((key) => /^[A-Za-z0-9_]+$/.test(key))) {
      throw new Error(`invalid MCP server config for "${name}"`);
    }
    const prefix = `mcp_servers.${name}`;
    return [
      '-c', `${prefix}.command=${toml(server.command)}`,
      '-c', `${prefix}.args=${toml(server.args)}`,
      '-c', `${prefix}.env=${tomlTable(server.env)}`,
      // Secrets travel in the codex process environment and are forwarded by name, never on argv.
      ...(server.inheritEnv?.length ? ['-c', `${prefix}.env_vars=${toml(server.inheritEnv)}`] : []),
      '-c', `${prefix}.default_tools_approval_mode="approve"`,
    ];
  });
}

export function codexArgs(entry: string, launch: ManagedLaunch, threadId?: string): string[] {
  const options = [
    '--json',
    '--skip-git-repo-check',
    ...(launch.model ? ['-m', launch.model] : []),
    ...(launch.writeRoot ? ['-c', 'sandbox_mode="workspace-write"'] : []),
    ...codexMcpArgs(launch.mcpServers),
  ];
  return threadId
    ? [entry, 'exec', 'resume', threadId, ...options, '-']
    : [entry, 'exec', ...options, '-C', launch.cwd, '-'];
}

/** `codex exec --json` line -> tower event. */
export function normalizeCodexExecLine(line: Json): { kind: EventKind; summary: string; threadId?: string } | undefined {
  if (line.type === 'thread.started' && typeof line.thread_id === 'string') {
    return { kind: 'system', summary: 'thread started', threadId: line.thread_id };
  }
  if (line.type === 'turn.completed') return { kind: 'status', summary: 'turn complete' };
  if (line.type === 'turn.failed' || line.type === 'error') return { kind: 'error', summary: summarize(JSON.stringify(line)) };
  const item = line.item as Json | undefined;
  if ((line.type === 'item.completed' || line.type === 'item.started') && item) {
    if (item.type === 'agent_message' && typeof item.text === 'string') return { kind: 'assistant', summary: summarize(item.text) };
    if (item.type === 'command_execution' && line.type === 'item.started') {
      return { kind: 'tool_call', summary: describeToolInput('shell', { command: item.command }) };
    }
    if (item.type === 'file_change' && line.type === 'item.completed') return { kind: 'tool_call', summary: 'edited files' };
  }
  return undefined;
}

/** Tier A Codex agent: each turn is a `codex exec` (or `codex exec resume`) process. */
export class CodexRunner implements ManagedRunner {
  readonly id = `managed:${randomUUID()}`;
  private threadId: string | undefined;
  private child: ChildProcess | undefined;
  private status: AgentStatus = 'busy';
  private activity: string | undefined;
  private lastEventAt = Date.now();
  private readonly startedAt = Date.now();
  private stopped = false;

  constructor(private readonly launch: ManagedLaunch, private readonly host: ManagedHost, private readonly entry: string) {
    this.runTurn(launch.prompt);
  }

  get sessionId(): string | undefined {
    return this.threadId;
  }

  snapshot(): Agent {
    return {
      id: this.id,
      vendor: 'codex',
      tier: 'A',
      name: this.launch.name ?? `Managed Codex · ${projectName(this.launch.cwd)}`,
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
      canInstruct: !this.stopped && this.status !== 'busy',
    };
  }

  async send(text: string): Promise<void> {
    if (this.stopped) throw new Error('agent has stopped');
    if (this.child) throw new Error('Codex is mid-turn; send the instruction when this turn completes (or Interrupt first).');
    this.event('prompt', summarize(text));
    this.runTurn(text);
  }

  async interrupt(): Promise<void> {
    if (this.child?.pid) await stopProcessTree(this.child.pid);
    this.event('system', 'Turn interrupted from the tower');
  }

  setIntercepting(): void {
    throw new Error('Per-tool interception is not available for Codex agents.');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      if (this.child?.pid) await stopProcessTree(this.child.pid);
    } finally {
      this.status = 'stopped';
      this.event('stop', 'Stopped from the tower');
      this.host.onExit(this.id);
    }
  }

  private runTurn(prompt: string): void {
    const child = spawn(process.execPath, codexArgs(this.entry, this.launch, this.threadId), {
      cwd: this.launch.cwd,
      env: { ...process.env, ...this.launch.env, [MANAGED_ENV_FLAG]: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.status = 'busy';
    // Codex has no system-prompt option: standing instructions lead every turn that starts a fresh thread.
    const brief = this.launch.appendSystemPrompt;
    child.stdin?.end(!this.threadId && brief ? `${brief}\n\n---\n\n${prompt}` : prompt);
    createInterface({ input: child.stdout! }).on('line', (raw) => this.onLine(raw));
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    // A spawn failure may emit 'error' without 'close': never leave the agent stuck "busy".
    child.on('error', (error) => {
      if (this.child === child) this.child = undefined;
      if (!this.stopped) this.status = 'idle';
      this.event('error', summarize(error.message));
    });
    child.on('close', (code) => {
      if (this.child === child) this.child = undefined;
      if (this.stopped) return;
      if (code !== 0 && stderr.trim()) this.event('error', summarize(stderr));
      this.status = 'idle';
      this.publish();
    });
    this.publish();
  }

  private onLine(raw: string): void {
    let parsed: Json;
    try {
      parsed = JSON.parse(raw) as Json;
    } catch {
      return;
    }
    const normalized = normalizeCodexExecLine(parsed);
    if (!normalized) return;
    if (normalized.threadId) this.threadId = normalized.threadId;
    this.event(normalized.kind, normalized.summary);
  }

  private event(kind: EventKind, summary: string): void {
    this.lastEventAt = Date.now();
    if (kind !== 'status' && kind !== 'system') this.activity = summary;
    this.host.onEvent({ agentId: this.id, ts: this.lastEventAt, kind, summary });
    this.publish();
  }

  private publish(): void {
    this.host.onAgent(this.snapshot());
  }
}
