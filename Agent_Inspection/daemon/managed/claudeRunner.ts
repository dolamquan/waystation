import { randomUUID } from 'node:crypto';
import {
  query, type CanUseTool, type HookCallbackMatcher, type McpStdioServerConfig, type Query, type SDKMessage, type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { READ_TOOL_MATCHER, WRITE_TOOL_MATCHER, readViolation, writeViolation } from './writeGuard.ts';
import { MANAGED_ENV_FLAG } from '../config.ts';
import type { Agent, AgentStatus } from '../domain/types.ts';
import { projectName, summarize } from '../domain/text.ts';
import { normalizeClaudeLine } from '../collectors/normalizers.ts';
import { AsyncQueue } from './asyncQueue.ts';
import type { ManagedHost, ManagedLaunch, ManagedRunner } from './types.ts';

const userMessage = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
} as SDKUserMessage);

function sdkMcpServers(servers: NonNullable<ManagedLaunch['mcpServers']>): Record<string, McpStdioServerConfig> {
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, {
    type: 'stdio',
    command: server.command,
    args: [...server.args],
    env: { ...server.env },
    // Team tools must be visible from the first turn, not deferred behind tool search.
    alwaysLoad: true,
  } satisfies McpStdioServerConfig]));
}

type Violation = (toolName: string, input: Record<string, unknown>) => string | undefined;

function denyHook(matcher: string, violation: Violation): HookCallbackMatcher {
  return {
    matcher,
    hooks: [async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const reason = violation(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
      return reason
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
        : {};
    }],
  };
}

/** Programmatic hooks run even when user settings pre-approve a tool, unlike canUseTool. */
export function guardHooks(launch: ManagedLaunch): HookCallbackMatcher[] {
  const { writeRoot, readGuard, cwd } = launch;
  return [
    ...(writeRoot ? [denyHook(WRITE_TOOL_MATCHER, (tool, input) => writeViolation(tool, input, writeRoot))] : []),
    ...(readGuard ? [denyHook(READ_TOOL_MATCHER, (tool, input) => readViolation(tool, input, cwd, readGuard))] : []),
  ];
}

/** Tier A Claude agent driven through the Claude Agent SDK with streaming input. */
export class ClaudeRunner implements ManagedRunner {
  readonly id = `managed:${randomUUID()}`;
  private sid: string | undefined;
  private status: AgentStatus = 'busy';
  private activity: string | undefined;
  private lastEventAt = Date.now();
  private readonly startedAt = Date.now();
  private intercepting: boolean;
  private readonly input = new AsyncQueue<SDKUserMessage>();
  private readonly abort = new AbortController();
  private readonly q: Query;

  constructor(private readonly launch: ManagedLaunch, private readonly host: ManagedHost) {
    this.intercepting = launch.intercept ?? false;
    this.input.push(userMessage(launch.prompt));
    this.q = query({
      prompt: this.input,
      options: {
        cwd: launch.cwd,
        abortController: this.abort,
        canUseTool: this.canUseTool,
        permissionMode: 'default',
        settingSources: ['user', 'project', 'local'],
        // Secrets in launch.env stay in the environment (inherited by stdio MCP servers), never in argv.
        env: { ...process.env, ...launch.env, [MANAGED_ENV_FLAG]: '1' } as Record<string, string>,
        ...(launch.model ? { model: launch.model } : {}),
        ...(launch.mcpServers ? { mcpServers: sdkMcpServers(launch.mcpServers) } : {}),
        ...(launch.writeRoot || launch.readGuard ? { hooks: { PreToolUse: guardHooks(launch) } } : {}),
        ...(launch.resumeSessionId ? { resume: launch.resumeSessionId, forkSession: launch.fork ?? true } : {}),
        ...(launch.appendSystemPrompt
          ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: launch.appendSystemPrompt } }
          : {}),
      },
    });
    this.publish();
    void this.pump();
  }

  get sessionId(): string | undefined {
    return this.sid;
  }

  snapshot(): Agent {
    return {
      id: this.id,
      vendor: 'claude',
      tier: 'A',
      name: this.launch.name ?? `Managed Claude · ${projectName(this.launch.cwd)}`,
      sessionId: this.sid,
      cwd: this.launch.cwd,
      project: projectName(this.launch.cwd),
      status: this.status,
      source: `Claude Agent SDK${this.launch.model ? ` · ${this.launch.model}` : ''} · launched here`,
      currentActivity: this.activity,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      hooked: false,
      intercepting: this.intercepting,
      canInstruct: this.status !== 'stopped',
    };
  }

  async send(text: string): Promise<void> {
    if (this.input.isClosed) throw new Error('agent has stopped');
    this.input.push(userMessage(text));
    this.status = 'busy';
    this.event('prompt', summarize(text));
  }

  async interrupt(): Promise<void> {
    if (this.status === 'stopped') throw new Error('agent has stopped');
    await this.q.interrupt();
    this.event('system', 'Interrupted from the tower');
  }

  setIntercepting(on: boolean): void {
    this.intercepting = on;
    this.publish();
  }

  async stop(): Promise<void> {
    this.input.close();
    this.abort.abort();
    this.status = 'stopped';
    this.event('stop', 'Stopped from the tower');
  }

  private canUseTool: CanUseTool = async (toolName, input, options) => {
    if (!this.intercepting) return { behavior: 'allow', updatedInput: input };
    this.status = 'waiting';
    this.publish();
    const decision = await this.host.requestDecision({
      agentId: this.id,
      sessionId: this.sid ?? this.id,
      toolName,
      input,
      origin: 'managed',
    }, options?.signal);
    this.status = 'busy';
    this.publish();
    if (decision.behavior === 'allow') return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
    if (decision.behavior === 'deny') return { behavior: 'deny', message: decision.message };
    return { behavior: 'deny', message: 'No decision from the operator in time; tool call skipped.' };
  };

  private async pump(): Promise<void> {
    try {
      for await (const message of this.q) this.handle(message);
    } catch (error) {
      if (!this.abort.signal.aborted) this.event('error', summarize((error as Error).message));
    } finally {
      this.status = 'stopped';
      this.input.close();
      this.publish();
      this.host.onExit(this.id);
    }
  }

  private handle(message: SDKMessage): void {
    if (message.type === 'system' && 'session_id' in message && typeof message.session_id === 'string') {
      this.sid = message.session_id;
    }
    if (message.type === 'assistant') {
      for (const event of normalizeClaudeLine(this.id, message).events) this.event(event.kind, event.summary);
    }
    if (message.type === 'result') {
      this.status = 'idle';
      const cost = 'total_cost_usd' in message && typeof message.total_cost_usd === 'number'
        ? ` · $${message.total_cost_usd.toFixed(4)}` : '';
      this.event('status', `turn complete (${message.subtype})${cost}`);
    }
  }

  private event(kind: Parameters<ManagedHost['onEvent']>[0]['kind'], summary: string): void {
    this.lastEventAt = Date.now();
    if (kind !== 'status') this.activity = summary;
    this.host.onEvent({ agentId: this.id, ts: this.lastEventAt, kind, summary });
    this.publish();
  }

  private publish(): void {
    this.host.onAgent(this.snapshot());
  }
}
