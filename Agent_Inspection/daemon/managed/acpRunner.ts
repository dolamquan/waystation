import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { ClientSideConnection, InitializeResponse, McpServer, RequestPermissionRequest, RequestPermissionResponse, SessionNotification, Usage } from '@agentclientprotocol/sdk';
import { MANAGED_ENV_FLAG, paths } from '../config.ts';
import type { Agent, AgentEvent, AgentStatus, EventKind, TokenCounts } from '../domain/types.ts';
import { projectName, summarize, taskTitle } from '../domain/text.ts';
import { stopProcessTree } from '../actions/kill.ts';
import { extractImageRefs } from './attachments.ts';
import { readViolation, writeViolation } from './writeGuard.ts';
import { waystationInstructions } from './waystationContext.ts';
import type { ManagedHost, ManagedLaunch, ManagedRunner } from './types.ts';
import type { AcpRegistration, ResolvedCommand } from './providerRegistry.ts';

const zero = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
async function deadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

export function acpMcpServers(launch: ManagedLaunch): McpServer[] {
  return [
    ...Object.entries(launch.mcpServers ?? {}).map(([name, server]) => ({ name, command: server.command, args: [...server.args],
      env: Object.entries({ ...server.env, ...Object.fromEntries((server.inheritEnv ?? []).flatMap(key => {
        const value = launch.env?.[key] ?? process.env[key]; return value === undefined ? [] : [[key, value]];
      })) }).map(([name, value]) => ({ name, value })) })),
    ...Object.entries(launch.remoteMcpServers ?? {}).map(([name, server]) => ({ name, type: server.type, url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) })),
  ];
}

/** One persistent ACP v1 connection for any locally configured compatible agent. */
export class AcpRunner implements ManagedRunner {
  readonly id: string;
  private sid?: string;
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientSideConnection;
  private negotiated?: InitializeResponse;
  private status: AgentStatus;
  private stopped = false;
  private draining = false;
  private pending: string[] = [];
  private intercepting: boolean;
  private abort = new AbortController();
  private readonly ready: Promise<void>;
  private readonly startedAt = Date.now();
  private lastEventAt = this.startedAt;
  private lastError?: string;
  private message = '';
  private replaying = false;
  private firstTurn = true;
  private canSelectModel = false;
  private selectedModel?: string;
  private tokens = zero();
  private usageKnown = false;
  private reportedTokens?: TokenCounts;
  private contextTokens?: number;
  private contextWindow?: number;
  constructor(readonly launch: ManagedLaunch, private readonly host: ManagedHost, private readonly provider: AcpRegistration, private readonly executable: ResolvedCommand) {
    this.id = launch.agentId ?? `managed:${randomUUID()}`;
    this.sid = launch.resumeSessionId;
    this.status = launch.prompt ? 'busy' : 'idle'; this.intercepting = launch.intercept === true;
    this.ready = Promise.resolve().then(() => deadline(this.open(), 45_000, 'ACP startup timed out. Check the agent’s installation and sign-in.'));
    void this.ready.catch(error => this.fail(error));
    if (launch.prompt) queueMicrotask(() => { if (!this.stopped) void this.send(launch.prompt); });
  }
  get sessionId() { return this.sid; }
  get model() { return this.selectedModel ?? this.launch.model; }
  snapshot(): Agent {
    return { id: this.id, vendor: this.provider.id, providerId: this.provider.id, providerLabel: this.provider.label, tier: 'A',
      name: this.launch.name ?? taskTitle(this.launch.prompt) ?? `${this.provider.label} · ${projectName(this.launch.cwd)}`,
      sessionId: this.sid, cwd: this.launch.cwd, project: projectName(this.launch.cwd), status: this.status,
      source: 'ACP · launched here', startedAt: this.startedAt, lastEventAt: this.lastEventAt, hooked: false,
      intercepting: this.intercepting, canInstruct: !this.stopped, model: this.model, lastError: this.lastError,
      capabilities: { resume: this.negotiated?.agentCapabilities?.loadSession === true, model: this.canSelectModel },
      usage: this.usageKnown || this.contextTokens !== undefined || this.reportedTokens ? { tokens: this.tokens, tokensReported: this.usageKnown, reportedTokens: this.reportedTokens, contextTokens: this.contextTokens, contextWindow: this.contextWindow } : undefined };
  }
  async send(text: string): Promise<void> {
    if (this.stopped) throw new Error(`${this.provider.label} has stopped.`);
    if (this.pending.length >= 20) throw new Error('This agent already has 20 queued messages.');
    this.pending.push(text); this.event('prompt', summarize(extractImageRefs(text, paths.attachmentsDir).text)); void this.drain();
  }
  setIntercepting(on: boolean): void { this.intercepting = on; this.publish(); }
  async interrupt(): Promise<void> {
    this.pending = []; this.abort.abort();
    if (this.connection && this.sid) await this.connection.cancel({ sessionId: this.sid });
    // An agent that ignores cancellation must not hold the queue forever.
    if (this.draining) {
      const timer = setTimeout(() => { if (this.draining && !this.stopped) void this.fail(new Error('Agent did not acknowledge cancellation. Session stopped; resume it from history if supported.')); }, 5000);
      timer.unref();
    }
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; this.pending = []; this.abort.abort(); this.flushMessage();
    await this.kill(); this.status = 'stopped'; this.event('stop', 'Stopped from Waystation'); this.host.onExit(this.id);
  }
  private async kill(): Promise<void> {
    if (this.child?.pid && this.child.exitCode === null) await stopProcessTree(this.child.pid).catch(() => { this.child?.kill(); });
    this.child?.stdin.destroy(); this.child?.stdout.destroy(); this.child?.stderr.destroy();
  }
  private async open(): Promise<void> {
    const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = await import('@agentclientprotocol/sdk');
    if (this.stopped) return;
    this.child = spawn(this.executable.command, [...this.executable.args], { cwd: this.launch.cwd, shell: false, windowsHide: true,
      env: { ...process.env, ...this.provider.env, ...this.launch.env, [MANAGED_ENV_FLAG]: '1' }, stdio: 'pipe' });
    this.child.once('error', error => { void this.fail(new Error(`Could not start ${this.provider.label}: ${error.message}`)); });
    // Never forward stderr: it can contain authentication details or server configuration.
    this.child.stderr.resume();
    this.child.once('exit', (code) => { if (!this.stopped) void this.fail(new Error(`${this.provider.label} exited (${code ?? 'terminated'}). Check its installation and sign-in in its own CLI.`)); });
    this.connection = new ClientSideConnection(() => ({
      sessionUpdate: params => this.update(params), requestPermission: params => this.permission(params),
      readTextFile: async params => {
        const path = this.checkedPath(params.sessionId, params.path, false);
        const content = await readFile(path, 'utf8');
        const lines = content.split('\n'); const start = Math.max(0, (params.line ?? 1) - 1);
        return { content: lines.slice(start, params.limit == null ? undefined : start + params.limit).join('\n') };
      },
      writeTextFile: async params => {
        const path = this.checkedPath(params.sessionId, params.path, true);
        await writeFile(path, params.content, 'utf8'); this.event('tool_call', `*** Update File: ${path}`); return {};
      },
    }), ndJsonStream(Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(this.child.stdout) as unknown as ReadableStream<Uint8Array>));
    this.negotiated = await this.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'waystation', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } });
    if (this.stopped) return;
    if (this.negotiated.protocolVersion !== PROTOCOL_VERSION) throw new Error('This agent requires a different ACP protocol version. Waystation currently supports ACP v1.');
    const servers = acpMcpServers(this.launch);
    const caps = this.negotiated.agentCapabilities;
    if (servers.some(s => 'type' in s && s.type === 'http') && !caps?.mcpCapabilities?.http || servers.some(s => 'type' in s && s.type === 'sse') && !caps?.mcpCapabilities?.sse) throw new Error('This agent does not support an attached MCP transport. Remove that tool connection before launching.');
    let session;
    try {
      this.replaying = !!this.sid;
      if (this.sid && !caps?.loadSession) throw new Error('This agent does not support conversation recovery through ACP. Start a new session instead.');
      session = this.sid ? await this.connection.loadSession({ sessionId: this.sid, cwd: this.launch.cwd, mcpServers: servers })
        : await this.connection.newSession({ cwd: this.launch.cwd, mcpServers: servers });
    } catch (error) {
      if (String((error as Error).message).toLowerCase().includes('auth')) throw new Error(`Sign in to ${this.provider.label} using its own CLI, then launch again. Waystation reuses its configured authentication.`);
      throw error;
    } finally { this.replaying = false; }
    if ('sessionId' in session && typeof session.sessionId === 'string') this.sid = session.sessionId;
    if (this.stopped) return;
    this.tokens = this.host.usageBaseline?.(this.provider.id, this.sid!) ?? zero();
    this.usageKnown = Object.values(this.tokens).some(value => value > 0);
    const modelOption = session.configOptions?.find(option => option.category === 'model');
    this.canSelectModel = !!modelOption;
    if (modelOption && typeof modelOption.currentValue === 'string') this.selectedModel = modelOption.currentValue;
    if (this.launch.model) {
      const option = modelOption;
      if (option) await this.connection.setSessionConfigOption({ sessionId: this.sid!, configId: option.id, value: this.launch.model });
      else throw new Error('This agent did not expose model selection through ACP. Select its default model or configure the model in its own CLI.');
      this.selectedModel = this.launch.model;
    }
    this.publish();
  }
  private checkedPath(sessionId: string, path: string, write: boolean): string {
    if (this.stopped || sessionId !== this.sid) throw new Error('Unknown or stopped ACP session.');
    const target = resolve(this.launch.cwd, path);
    const reason = write && this.launch.writeRoot ? writeViolation('Write', { file_path: target }, this.launch.writeRoot) : undefined;
    const privateRead = this.launch.readGuard ? readViolation('Read', { file_path: target }, this.launch.cwd, this.launch.readGuard) : undefined;
    if (reason || privateRead) throw new Error(reason ?? privateRead);
    return target;
  }
  private async permission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
    if (this.stopped || this.abort.signal.aborted || params.sessionId !== this.sid) return cancelled;
    const call = params.toolCall;
    try { for (const location of call.locations ?? []) this.checkedPath(params.sessionId, location.path, call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move'); }
    catch { return cancelled; }
    let allow = !this.intercepting;
    if (this.intercepting) {
      this.status = 'waiting'; this.publish();
      try {
        const decision = await this.host.requestDecision({ agentId: this.id, sessionId: this.sid!, toolName: call.title ?? call.name ?? call.kind ?? 'ACP tool',
          input: { tool: call.rawInput ?? {}, note: 'ACP supports approve or deny. Editing arguments requires a new instruction.' }, origin: 'managed' }, this.abort.signal);
        allow = decision.behavior === 'allow' && !decision.updatedInput;
      } finally { if (!this.stopped) this.status = 'busy'; this.publish(); }
    }
    if (this.stopped || this.abort.signal.aborted) return cancelled;
    const option = params.options.find(option => option.kind === (allow ? 'allow_once' : 'reject_once'));
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : cancelled;
  }
  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true; this.status = 'busy'; this.publish();
    try {
      await this.ready;
      while (!this.stopped && this.pending.length) {
        this.abort = new AbortController(); this.status = 'busy'; this.event('status', 'turn started');
        const { text, images } = extractImageRefs(this.pending.shift()!, paths.attachmentsDir);
        if (images.length && !this.negotiated?.agentCapabilities?.promptCapabilities?.image) throw new Error('This agent does not accept images through ACP. Send a text instruction instead.');
        const instructions = this.firstTurn ? waystationInstructions(this.launch) : '';
        this.firstTurn = false;
        const result = await deadline(this.connection!.prompt({ sessionId: this.sid!, prompt: [
          ...(instructions ? [{ type: 'text' as const, text: `[Waystation standing instructions]\n${instructions}` }] : []), { type: 'text', text },
          ...await Promise.all(images.map(async image => ({ type: 'image' as const, mimeType: image.mediaType, data: (await readFile(image.path)).toString('base64') }))),
        ] }), 3_600_000, 'ACP turn timed out.');
        this.flushMessage(); if (result.usage) this.recordUsage(result.usage);
        this.lastError = undefined; this.event('status', result.stopReason === 'cancelled' ? 'turn interrupted' : 'turn complete');
      }
    } catch (error) {
      this.pending = []; this.flushMessage();
      if (!this.stopped && !this.abort.signal.aborted) { this.lastError = summarize((error as Error).message, 300); this.event('error', this.lastError); }
    } finally { this.draining = false; if (!this.stopped) this.status = 'idle'; this.publish(); }
  }
  private update(params: SessionNotification): void {
    if (this.stopped || this.replaying || this.sid && params.sessionId !== this.sid) return;
    const update = params.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') { this.message += update.content.text; return; }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.flushMessage();
      const done = update.status === 'completed' || update.status === 'failed';
      const output = (update.content ?? []).flatMap(content => content.type === 'content' && content.content.type === 'text' ? [content.content.text] : []).join('\n');
      this.event(done ? 'tool_result' : 'tool_call', summarize(update.title ?? output ?? update.kind ?? 'Tool update'), { id: update.toolCallId, name: update.name ?? update.title ?? undefined, failed: update.status === 'failed', output: output || undefined });
      if (done && update.status !== 'failed') for (const content of update.content ?? []) if (content.type === 'diff') this.event('tool_call', `*** Update File: ${content.path}`);
    }
    if (update.sessionUpdate === 'usage_update') { this.contextTokens = update.used; this.contextWindow = update.size; this.publish(); }
    if (update.sessionUpdate === 'notice') this.event(update.severity === 'error' ? 'error' : 'system', summarize(`${update.title}\n${update.description ?? ''}`));
  }
  private recordUsage(usage: Usage): void {
    const count = (value: number | null | undefined) => Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
    // Context occupancy is separate. The experimental prompt usage field has incompatible scopes
    // across ACP implementations: registration declares one, otherwise keep the raw reading only.
    const total: TokenCounts = { input: count(usage.inputTokens), output: count(usage.outputTokens) + count(usage.thoughtTokens),
      cacheRead: count(usage.cachedReadTokens), cacheWrite5m: count(usage.cachedWriteTokens), cacheWrite1h: 0 };
    if (!this.provider.usageMode) { this.reportedTokens = total; this.publish(); return; }
    const delta = this.provider.usageMode === 'turn' ? total : Object.fromEntries(Object.entries(total).map(([key, value]) => [key, Math.max(0, value - this.tokens[key as keyof TokenCounts])])) as unknown as TokenCounts;
    this.tokens = Object.fromEntries(Object.entries(this.tokens).map(([key, value]) => [key, value + delta[key as keyof TokenCounts]])) as unknown as TokenCounts;
    if (Object.values(delta).some(value => value > 0)) this.host.onUsage?.({ id: `acp:${this.provider.id}:${this.sid}:${this.provider.usageMode === 'turn' ? randomUUID() : Object.values(this.tokens).join('-')}`, vendor: this.provider.id, sessionId: this.sid,
      cumulative: this.tokens, ts: Date.now(), tokens: delta, model: this.model });
    this.usageKnown = true; this.publish();
  }
  private flushMessage(): void { if (this.message) { const text = this.message; this.message = ''; this.event('assistant', summarize(text)); } }
  private async fail(error: Error): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; this.status = 'stopped'; this.lastError = summarize(error.message, 300); this.pending = []; this.abort.abort();
    this.flushMessage(); this.event('error', this.lastError); this.host.onExit(this.id); await this.kill();
  }
  private event(kind: EventKind, summary: string, tool?: AgentEvent['tool']): void {
    this.lastEventAt = Date.now(); this.host.onEvent({ agentId: this.id, ts: this.lastEventAt, kind, summary, ...(tool ? { tool } : {}) }); this.publish();
  }
  private publish(): void { this.host.onAgent(this.snapshot()); }
}
