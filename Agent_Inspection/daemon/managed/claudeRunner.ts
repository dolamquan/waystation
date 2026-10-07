import { randomUUID } from 'node:crypto';
import {
  query, type CanUseTool, type HookCallbackMatcher, type McpServerConfig, type McpStdioServerConfig, type Query, type SDKMessage,
  type SdkPluginConfig, type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { READ_TOOL_MATCHER, WRITE_TOOL_MATCHER, readViolation, writeViolation } from './writeGuard.ts';
import { MANAGED_ENV_FLAG } from '../config.ts';
import type { Agent, AgentStatus } from '../domain/types.ts';
import { projectName, summarize } from '../domain/text.ts';
import { normalizeClaudeLine } from '../collectors/normalizers.ts';
import { AsyncQueue } from './asyncQueue.ts';
import type { ManagedHost, ManagedLaunch, ManagedRunner } from './types.ts';
import { UsageMeter, claudeUsageSample } from '../usage/usageMeter.ts';
import { remoteHeaderPlan } from './cliCommands.ts';

/** Claude Code's built-in "ask the user" tool. Managed agents have no terminal, so the tower answers. */
export const ASK_TOOL = 'AskUserQuestion';

const userMessage = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
} as SDKUserMessage);

/** Team tools must be visible from the first turn, not deferred behind tool search. Library servers load as usual. */
const ALWAYS_LOAD = new Set(['team']);

export interface ClaudeSdkMcp {
  readonly mcpServers?: Record<string, McpServerConfig>;
  /** Secret values the CLI expands from its own environment (`${VAR}` in `--mcp-config`). */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The SDK passes MCP config to the CLI on its command line, readable by any local process. So secrets never
 * go into it: stdio secrets are inherited by name and remote header values become `${VAR}` placeholders
 * the CLI expands from its environment.
 */
export function claudeSdkMcp(launch: Pick<ManagedLaunch, 'mcpServers' | 'remoteMcpServers'>): ClaudeSdkMcp {
  const plan = remoteHeaderPlan(launch.remoteMcpServers);
  const stdio = Object.entries(launch.mcpServers ?? {}).map(([name, server]): [string, McpServerConfig] => [name, {
    type: 'stdio',
    command: server.command,
    args: [...server.args],
    env: { ...server.env, ...Object.fromEntries((server.inheritEnv ?? []).map((key) => [key, `\${${key}}`])) },
    ...(ALWAYS_LOAD.has(name) ? { alwaysLoad: true } : {}),
  } satisfies McpStdioServerConfig]);
  const remote = Object.entries(launch.remoteMcpServers ?? {}).map(([name, server]): [string, McpServerConfig] => {
    const headers = Object.fromEntries(Object.entries(plan.vars[name] ?? {}).map(([header, variable]) => [header, `\${${variable}}`]));
    return [name, { type: server.type, url: server.url, ...(Object.keys(headers).length ? { headers } : {}) }];
  });
  const all = [...stdio, ...remote];
  return { mcpServers: all.length ? Object.fromEntries(all) : undefined, env: plan.env };
}

export function sdkPlugins(plugins: ManagedLaunch['plugins']): SdkPluginConfig[] | undefined {
  return plugins?.length ? [...new Set(plugins)].map((path) => ({ type: 'local' as const, path })) : undefined;
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
  readonly id: string;
  private sid: string | undefined;
  private status: AgentStatus = 'busy';
  private activity: string | undefined;
  private lastEventAt = Date.now();
  private readonly startedAt = Date.now();
  private intercepting: boolean;
  private readonly input = new AsyncQueue<SDKUserMessage>();
  private readonly abort = new AbortController();
  private readonly q: Query;
  private readonly meter: UsageMeter;
  private lastError: string | undefined;

  constructor(readonly launch: ManagedLaunch, private readonly host: ManagedHost) {
    this.id = launch.agentId ?? `managed:${randomUUID()}`;
    this.meter = new UsageMeter(launch.model);
    this.intercepting = launch.intercept ?? false;
    // Continuing a session without a fork keeps its id, so it is known before the SDK reports it.
    if (launch.resumeSessionId && launch.fork === false) this.sid = launch.resumeSessionId;
    if (launch.prompt) this.input.push(userMessage(launch.prompt));
    else this.status = 'idle';
    const mcp = claudeSdkMcp(launch);
    const plugins = sdkPlugins(launch.plugins);
    this.q = query({
      prompt: this.input,
      options: {
        cwd: launch.cwd,
        abortController: this.abort,
        canUseTool: this.canUseTool,
        permissionMode: 'default',
        settingSources: ['user', 'project', 'local'],
        // Secrets in launch.env stay in the environment (inherited by stdio MCP servers), never in argv.
        env: { ...process.env, ...launch.env, ...mcp.env, [MANAGED_ENV_FLAG]: '1' } as Record<string, string>,
        ...(launch.model ? { model: launch.model } : {}),
        ...(mcp.mcpServers ? { mcpServers: mcp.mcpServers } : {}),
        ...(plugins ? { plugins } : {}),
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

  get model(): string | undefined {
    return this.launch.model;
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
      model: this.meter.model,
      usage: this.meter.snapshot(),
      lastError: this.lastError,
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
    // A question for the operator is always held for an answer, intercepting or not.
    if (toolName === ASK_TOOL) return this.askOperator(input, options?.signal);
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

  /** The operator answers in the tower; the answers ride back in the tool input, as Claude Code's own prompt does. */
  private async askOperator(input: Record<string, unknown>, signal?: AbortSignal) {
    this.status = 'waiting';
    this.publish();
    const decision = await this.host.requestDecision({
      agentId: this.id, sessionId: this.sid ?? this.id, toolName: ASK_TOOL, input, origin: 'managed',
    }, signal);
    this.status = 'busy';
    this.publish();
    if (decision.behavior === 'allow') return { behavior: 'allow' as const, updatedInput: decision.updatedInput ?? input };
    if (decision.behavior === 'deny') return { behavior: 'deny' as const, message: decision.message };
    return { behavior: 'deny' as const, message: 'The operator did not answer in time. Continue with your best judgement and say which option you chose.' };
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.q) this.handle(message);
    } catch (error) {
      if (!this.abort.signal.aborted) {
        this.lastError = summarize((error as Error).message, 300);
        this.event('error', summarize((error as Error).message));
      }
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
    if (message.type === 'system' && message.subtype === 'init' && typeof message.model === 'string') {
      this.meter.setModel(message.model);
    }
    if (message.type === 'assistant') {
      const sample = claudeUsageSample(message);
      if (sample) this.meter.addClaude(sample);
      for (const event of normalizeClaudeLine(this.id, message).events) this.event(event.kind, event.summary);
    }
    if (message.type === 'result') {
      this.status = 'idle';
      const window = this.meter.model ? message.modelUsage?.[this.meter.model]?.contextWindow : undefined;
      this.meter.setContext(undefined, window);
      this.lastError = message.subtype === 'success' ? undefined : `Turn ended: ${message.subtype.replace(/_/g, ' ')}`;
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
