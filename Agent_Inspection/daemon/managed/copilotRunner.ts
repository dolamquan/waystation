import { randomUUID } from 'node:crypto';
import type { CopilotClient, CopilotSession, MCPServerConfig, SessionConfig, SessionEvent } from '@github/copilot-sdk';
import { MANAGED_ENV_FLAG, paths } from '../config.ts';
import type { Agent, AgentStatus, EventKind, TokenCounts } from '../domain/types.ts';
import { describeToolInput, projectName, summarize, taskTitle } from '../domain/text.ts';
import { activityFromEvent } from '../../shared/plainActivity.ts';
import { waystationInstructions } from './waystationContext.ts';
import { extractImageRefs } from './attachments.ts';
import { readViolation, writeViolation } from './writeGuard.ts';
import type { ManagedHost, ManagedLaunch, ManagedRunner } from './types.ts';

export function copilotMcpServers(launch: ManagedLaunch): Record<string, MCPServerConfig> {
  return Object.fromEntries([
    ...Object.entries(launch.mcpServers ?? {}).map(([name, server]) => [name, {
      type: 'local', command: server.command, args: [...server.args], tools: ['*'],
      env: { ...server.env, ...Object.fromEntries((server.inheritEnv ?? []).flatMap(key => {
        const value = launch.env?.[key] ?? process.env[key];
        return value === undefined ? [] : [[key, value]];
      })) },
    }]),
    ...Object.entries(launch.remoteMcpServers ?? {}).map(([name, server]) => [name, { ...server, tools: ['*'] }]),
  ]) as Record<string, MCPServerConfig>;
}

/** Persistent SDK adapter. Shared Waystation services own history, teams, schedules, outputs and guards. */
export class CopilotRunner implements ManagedRunner {
  readonly id: string;
  private client?: CopilotClient;
  private session?: CopilotSession;
  private sid?: string;
  private status: AgentStatus = 'idle';
  private stopped = false;
  private draining = false;
  private intercepting: boolean;
  private pending: string[] = [];
  private permissionAbort = new AbortController();
  private readonly ready: Promise<void>;
  private readonly startedAt = Date.now();
  private lastEventAt = this.startedAt;
  private activity?: string;
  private lastError?: string;
  private selectedModel?: string;
  private contextTokens?: number;
  private contextWindow?: number;
  private tokens: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  private readonly usageIds = new Set<string>();

  constructor(readonly launch: ManagedLaunch, private readonly host: ManagedHost) {
    this.id = launch.agentId ?? `managed:${randomUUID()}`;
    this.sid = launch.resumeSessionId;
    this.selectedModel = launch.model;
    this.status = launch.prompt ? 'busy' : 'idle';
    this.intercepting = launch.intercept === true;
    this.ready = Promise.resolve().then(() => this.open());
    void this.ready.catch(error => this.failStartup(error));
    if (launch.prompt) queueMicrotask(() => { if (!this.stopped) void this.send(launch.prompt); });
  }
  get sessionId() { return this.sid; }
  get model() { return this.selectedModel; }
  snapshot(): Agent {
    return { id: this.id, vendor: 'copilot', providerId: 'copilot', providerLabel: 'GitHub Copilot', tier: 'A',
      name: this.launch.name ?? taskTitle(this.launch.prompt) ?? `Managed Copilot · ${projectName(this.launch.cwd)}`,
      sessionId: this.sid, cwd: this.launch.cwd, project: projectName(this.launch.cwd), status: this.status,
      source: 'Copilot Agent SDK · launched here', currentActivity: this.activity, startedAt: this.startedAt,
      lastEventAt: this.lastEventAt, hooked: false, intercepting: this.intercepting, canInstruct: !this.stopped,
      model: this.selectedModel, usage: { tokens: this.tokens, contextTokens: this.contextTokens, contextWindow: this.contextWindow }, lastError: this.lastError };
  }
  async send(text: string): Promise<void> {
    if (this.stopped) throw new Error('Copilot has stopped.');
    if (this.pending.length >= 20) throw new Error('Copilot already has 20 queued messages.');
    this.pending.push(text);
    this.event('prompt', summarize(extractImageRefs(text, paths.attachmentsDir).text));
    void this.drain();
  }
  async interrupt(): Promise<void> {
    this.pending = [];
    this.permissionAbort.abort();
    await this.session?.abort();
    if (!this.stopped) this.event('system', 'Turn interrupted from Waystation');
  }
  setIntercepting(on: boolean): void { this.intercepting = on; this.publish(); }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; this.pending = []; this.permissionAbort.abort();
    try { await this.session?.abort(); } catch { /* Runtime may already be gone. */ }
    try { await this.ready; } catch { /* Startup failure is already recorded. */ }
    await this.client?.stop();
    this.status = 'stopped'; this.event('stop', 'Stopped from Waystation'); this.host.onExit(this.id);
  }
  private async open(): Promise<void> {
    const { CopilotClient } = await import('@github/copilot-sdk');
    if (this.stopped) return;
    this.client = new CopilotClient({ workingDirectory: this.launch.cwd, logLevel: 'error',
      env: { ...process.env, ...this.launch.env, [MANAGED_ENV_FLAG]: '1' } });
    await this.client.start();
    const auth = await this.client.getAuthStatus();
    if (!auth.isAuthenticated) throw new Error('Sign in to GitHub Copilot in Usage & schedules → Setup checks before launching. VS Code and the Copilot SDK may use separate sign-ins.');
    if (this.stopped) return;
    const config: SessionConfig = {
      model: this.launch.model, workingDirectory: this.launch.cwd, streaming: true,
      systemMessage: { mode: 'append', content: waystationInstructions(this.launch) },
      mcpServers: copilotMcpServers(this.launch),
      hooks: { onPreToolUse: async input => {
        if (this.launch.toolPolicy === 'chat-only') return { permissionDecision: 'deny', permissionDecisionReason: 'Tools are disabled for this conversation-only agent.' };
        const args = input.toolArgs && typeof input.toolArgs === 'object' ? input.toolArgs as Record<string, unknown> : {};
        const filePath = args.path ?? args.file_path ?? args.fileName;
        const reason = this.launch.writeRoot && /^(create|edit|write|insert|replace)/i.test(input.toolName)
          ? writeViolation('Write', { file_path: filePath }, this.launch.writeRoot) : undefined;
        const privateRead = this.launch.readGuard && /^(view|read|grep|glob)/i.test(input.toolName)
          ? readViolation('Read', { file_path: filePath }, this.launch.cwd, this.launch.readGuard) : undefined;
        if (reason || privateRead) return { permissionDecision: 'deny', permissionDecisionReason: reason ?? privateRead };
        if (!this.intercepting && this.launch.toolPolicy !== 'review-tools') return {};
        const decision = await this.decide(input.toolName, args);
        return decision.behavior === 'allow' ? { permissionDecision: 'allow', modifiedArgs: decision.updatedInput ?? args }
          : { permissionDecision: 'deny', permissionDecisionReason: decision.behavior === 'deny' ? decision.message : 'No operator approval; tool skipped.' };
      } },
      onPermissionRequest: async request => {
        if (this.launch.toolPolicy === 'chat-only') return { kind: 'reject', feedback: 'Tools are disabled for this conversation-only agent.' };
        // Enterprise-required human review is never bypassed by the launch's Intercept setting.
        if (request.managedApprovalRequired) {
          const decision = await this.decide(`Copilot ${request.kind}`, request as unknown as Record<string, unknown>);
          if (decision.behavior !== 'allow' || decision.updatedInput) return { kind: 'reject', feedback: 'Permission not approved. Edit the tool call through its pre-tool approval instead.' };
        }
        if (this.stopped || this.permissionAbort.signal.aborted) return { kind: 'reject', feedback: 'Session cancelled.' };
        return { kind: 'approve-once' };
      },
      onUserInputRequest: async request => {
        const decision = await this.decide('AskUserQuestion', { questions: [{ question: request.question, header: 'Copilot', multiSelect: false,
          options: (request.choices ?? []).map(label => ({ label, description: '' })) }] });
        const answers = decision.behavior === 'allow' ? decision.updatedInput?.answers as Record<string, string> | undefined : undefined;
        const answer = answers?.[request.question];
        if (!answer) throw new Error(decision.behavior === 'deny' ? decision.message : 'Operator did not answer the question.');
        return { answer, wasFreeform: !request.choices?.includes(answer) };
      },
    };
    this.session = this.sid ? await this.client.resumeSession(this.sid, config) : await this.client.createSession(config);
    this.sid = this.session.sessionId;
    this.session.on(event => this.onEvent(event));
    this.publish();
  }
  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    this.status = 'busy'; this.publish();
    try {
      await this.ready;
      while (!this.stopped && this.pending.length) {
        this.permissionAbort = new AbortController();
        this.status = 'busy'; this.event('status', 'turn started');
        const { text, images } = extractImageRefs(this.pending.shift()!, paths.attachmentsDir);
        await this.session!.sendAndWait({ prompt: text, attachments: images.map(image => ({ type: 'file' as const, path: image.path })) }, 3_600_000);
        if (!this.stopped) { this.lastError = undefined; this.event('status', 'turn complete'); }
      }
    } catch (error) {
      this.pending = [];
      if (!this.stopped && !this.permissionAbort.signal.aborted) { this.lastError = summarize(String((error as Error).message), 300); this.event('error', this.lastError); }
    } finally { this.draining = false; if (!this.stopped) this.status = 'idle'; this.publish(); }
  }
  private async decide(toolName: string, input: Record<string, unknown>) {
    this.status = 'waiting'; this.publish();
    try { return await this.host.requestDecision({ agentId: this.id, sessionId: this.sid ?? this.id, toolName, input, origin: 'managed' }, this.permissionAbort.signal); }
    finally { if (!this.stopped) this.status = 'busy'; this.publish(); }
  }
  private onEvent(event: SessionEvent): void {
    if (this.stopped) return;
    if (event.type === 'assistant.message') this.event('assistant', summarize(event.data.content));
    if (event.type === 'tool.execution_start') this.event('tool_call', describeToolInput(event.data.toolName, event.data.arguments ?? {}), {
      id: event.data.toolCallId, name: event.data.toolName,
      command: event.data.arguments && typeof event.data.arguments === 'object' && !Array.isArray(event.data.arguments) && typeof event.data.arguments.command === 'string' ? event.data.arguments.command : undefined });
    if (event.type === 'tool.execution_complete') {
      for (const edit of event.data.fileEdits ?? []) this.event('tool_call', `*** Update File: ${edit.path}`);
      this.event('tool_result', event.data.success ? 'Tool finished' : summarize(event.data.error?.message ?? 'Tool failed'), {
        id: event.data.toolCallId, failed: !event.data.success, exitCode: event.data.shellExecution?.exitCode, output: summarize(event.data.result?.content ?? '') });
    }
    if (event.type === 'session.error') { this.lastError = summarize(event.data.message, 300); this.event('error', this.lastError); }
    if (event.type === 'assistant.usage' && !this.usageIds.has(event.id)) {
      this.usageIds.add(event.id);
      const data = event.data;
      this.selectedModel = data.model;
      const tokens = { input: Math.max(0, (data.inputTokens ?? 0) - (data.cacheReadTokens ?? 0)), output: data.outputTokens ?? 0,
        cacheRead: data.cacheReadTokens ?? 0, cacheWrite5m: data.cacheWriteTokens ?? 0, cacheWrite1h: 0 };
      this.tokens = Object.fromEntries(Object.entries(tokens).map(([key, value]) => [key, value + this.tokens[key as keyof TokenCounts]])) as unknown as TokenCounts;
      this.host.onUsage?.({ id: `copilot:${event.id}`, vendor: 'copilot', ts: Date.parse(event.timestamp) || Date.now(), tokens, model: data.model });
      this.publish();
    }
    if (event.type === 'session.usage_info') { this.contextTokens = event.data.currentTokens; this.contextWindow = event.data.tokenLimit; this.publish(); }
  }
  private async failStartup(error: Error): Promise<void> {
    if (this.stopped) return;
    this.lastError = summarize(error.message, 300); this.stopped = true; this.status = 'stopped'; this.pending = [];
    this.event('error', this.lastError); this.host.onExit(this.id); await this.client?.stop().catch(() => undefined);
  }
  private event(kind: EventKind, summary: string, tool?: import('../domain/types.ts').AgentEvent['tool']): void {
    this.lastEventAt = Date.now();
    if (kind !== 'system' && kind !== 'status') this.activity = activityFromEvent({ kind, summary });
    this.host.onEvent({ agentId: this.id, ts: this.lastEventAt, kind, summary, ...(tool ? { tool } : {}) }); this.publish();
  }
  private publish(): void { this.host.onAgent(this.snapshot()); }
}
