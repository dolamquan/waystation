import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ManagedHost, ManagedLaunch, ManagedRunner } from './types.ts';
import { ClaudeRunner } from './claudeRunner.ts';
import { CodexRunner, resolveCodexEntry } from './codexRunner.ts';
import { isValidModelName } from './modelName.ts';

const MAX_PROMPT_CHARS = 20_000;
const MAX_INSTRUCTIONS_CHARS = 8000;

export function validateLaunch(raw: unknown): ManagedLaunch {
  const body = (raw ?? {}) as Record<string, unknown>;
  const vendor = body.vendor === 'codex' ? 'codex' : body.vendor === 'claude' ? 'claude' : undefined;
  if (!vendor) throw new Error('vendor must be "claude" or "codex"');
  if (typeof body.cwd !== 'string' || !isAbsolute(body.cwd)) throw new Error('cwd must be an absolute path');
  if (!existsSync(body.cwd) || !statSync(body.cwd).isDirectory()) throw new Error(`folder not found: ${body.cwd}`);
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new Error('prompt is required');
  if (body.prompt.length > MAX_PROMPT_CHARS) throw new Error('prompt is too long');
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
  if (model && !isValidModelName(model)) throw new Error('model name looks invalid');
  if (typeof body.appendSystemPrompt === 'string' && body.appendSystemPrompt.length > MAX_INSTRUCTIONS_CHARS) {
    throw new Error('role instructions are too long');
  }
  return {
    vendor,
    cwd: body.cwd,
    prompt: body.prompt,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : undefined,
    model,
    intercept: body.intercept === true,
    resumeSessionId: typeof body.resumeSessionId === 'string' ? body.resumeSessionId : undefined,
    fork: body.fork !== false,
    appendSystemPrompt: typeof body.appendSystemPrompt === 'string' ? body.appendSystemPrompt : undefined,
  };
}

/** Owns every Tier A runner. */
export class ManagedAgents {
  private runners = new Map<string, ManagedRunner>();
  private readonly launches = new Map<string, ManagedLaunch>();

  constructor(private readonly host: ManagedHost) {}

  launch(launch: ManagedLaunch): ManagedRunner {
    // An agent can be relaunched under the same id (back from the operator's terminal). Only the runner
    // currently registered for an id may report on it: a stopped predecessor's last updates are dropped.
    let self: ManagedRunner | undefined;
    const owns = (agentId: string) => {
      const current = this.runners.get(agentId);
      return current === undefined || current === self;
    };
    const host: ManagedHost = {
      ...this.host,
      onAgent: (agent) => { if (owns(agent.id)) this.host.onAgent(agent); },
      onEvent: (event) => { if (owns(event.agentId)) this.host.onEvent(event); },
      onExit: (agentId) => { if (owns(agentId)) this.host.onExit(agentId); },
    };
    let runner: ManagedRunner;
    if (launch.vendor === 'codex') {
      const entry = resolveCodexEntry();
      if (!entry) throw new Error('Codex CLI not found (expected an npm global install of @openai/codex).');
      runner = new CodexRunner(launch, host, entry);
    } else {
      runner = new ClaudeRunner(launch, host);
    }
    self = runner;
    this.runners.set(runner.id, runner);
    this.launches.set(runner.id, launch);
    return runner;
  }

  /** The settings an agent was launched with (for Restart & continue). */
  launchOf(agentId: string): ManagedLaunch | undefined {
    return this.runners.has(agentId) ? this.launches.get(agentId) : undefined;
  }

  /** Drop a finished runner so it no longer counts toward session ids or lookups. */
  forget(agentId: string): void {
    this.runners = new Map([...this.runners].filter(([id]) => id !== agentId));
    this.launches.delete(agentId);
  }

  get(agentId: string): ManagedRunner | undefined {
    return this.runners.get(agentId);
  }

  /** Session ids owned by managed runners, so collectors don't double-list them. */
  sessionIds(): Set<string> {
    return new Set([...this.runners.values()].flatMap((runner) => (runner.sessionId ? [runner.sessionId] : [])));
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.runners.values()].map((runner) => runner.stop()));
  }
}
