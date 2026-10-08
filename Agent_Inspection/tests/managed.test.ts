import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, AgentEvent, InterceptionDecision } from '../daemon/domain/types.ts';
import type { ManagedHost } from '../daemon/managed/types.ts';
import { tempDir } from './helpers.ts';

const sdkCalls: Array<{ options: Record<string, unknown> }> = [];
const toolResults: unknown[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: AsyncIterable<{ message: { content: string } }>; options: Record<string, unknown> }) => {
    sdkCalls.push({ options: params.options });
    const canUseTool = params.options.canUseTool as (n: string, i: Record<string, unknown>, o: { signal: AbortSignal }) => Promise<unknown>;
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-session-1', terminal_slash_commands: ['exit'] };
      for await (const msg of params.prompt) {
        if (msg.message.content === 'learn skills') {
          yield { type: 'system', subtype: 'commands_changed', commands: [{ name: 'deploy', description: 'Ship it', argumentHint: '<env>' }] };
        }
        toolResults.push(await canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal }));
        yield { type: 'assistant', message: { content: [{ type: 'text', text: `echo: ${msg.message.content}` }] } };
        if (msg.message.content === 'boom') throw new Error('model exploded');
        yield { type: 'result', subtype: 'success', total_cost_usd: 0.0123 };
      }
    }
    const gen = run() as AsyncGenerator<unknown> & { interrupt: () => Promise<void>; supportedCommands: () => Promise<unknown[]> };
    gen.interrupt = vi.fn(async () => undefined);
    gen.supportedCommands = vi.fn(async () => [
      { name: 'compact', description: 'Clear history but keep a summary', argumentHint: '<instructions>' },
      { name: 'exit', description: 'Exit the REPL', argumentHint: '' },
      { name: 'review', description: 'Review a pull request', argumentHint: '' },
    ]);
    return gen;
  },
}));

const { ClaudeRunner } = await import('../daemon/managed/claudeRunner.ts');
const { CodexRunner, resolveCodexEntry } = await import('../daemon/managed/codexRunner.ts');
const { ManagedAgents } = await import('../daemon/managed/managedAgents.ts');

function makeHost(decision: InterceptionDecision = { behavior: 'allow' }) {
  const agents: Agent[] = [];
  const events: AgentEvent[] = [];
  const exits: string[] = [];
  const host: ManagedHost = {
    onAgent: (a) => agents.push(a),
    onEvent: (e) => events.push(e),
    onExit: (id) => exits.push(id),
    requestDecision: vi.fn(async () => decision),
  };
  return { host, agents, events, exits, last: () => agents[agents.length - 1] };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
async function until(fn: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('ClaudeRunner (mocked SDK)', () => {
  it('streams prompts, records session id, cost and events, and marks the managed env', async () => {
    const { host, events, last } = makeHost();
    const cwd = tempDir();
    const runner = new ClaudeRunner({ vendor: 'claude', cwd, prompt: 'hello' }, host);
    await until(() => last().status === 'idle');
    expect(runner.sessionId).toBe('sdk-session-1');
    expect(last()).toMatchObject({ tier: 'A', vendor: 'claude', canInstruct: true, currentActivity: 'echo: hello' });
    expect(events.some((e) => e.summary.includes('$0.0123'))).toBe(true);
    expect((sdkCalls.at(-1)?.options.env as Record<string, string>).AGENT_TOWER_MANAGED).toBe('1');
    await runner.send('again');
    await until(() => events.some((e) => e.summary === 'echo: again'));
    await runner.interrupt();
    await runner.stop();
    await until(() => last().status === 'stopped');
    await expect(runner.send('late')).rejects.toThrow(/stopped/);
  });

  it('routes tool permission through the operator when intercepting', async () => {
    const { host } = makeHost({ behavior: 'deny', message: 'not now' });
    const runner = new ClaudeRunner({ vendor: 'claude', cwd: tempDir(), prompt: 'x', intercept: true }, host);
    await until(() => toolResults.length > 0 && (host.requestDecision as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(toolResults.at(-1)).toEqual({ behavior: 'deny', message: 'not now' });
    runner.setIntercepting(false);
    await runner.stop();
  });

  it('allows with edits, and turns a missing decision into a deny', async () => {
    const edited = makeHost({ behavior: 'allow', updatedInput: { command: 'pwd' } });
    const a = new ClaudeRunner({ vendor: 'claude', cwd: tempDir(), prompt: 'x', intercept: true }, edited.host);
    await until(() => toolResults.some((r) => JSON.stringify(r).includes('pwd')));
    await a.stop();
    const asked = makeHost({ behavior: 'ask' });
    const b = new ClaudeRunner({ vendor: 'claude', cwd: tempDir(), prompt: 'x', intercept: true, resumeSessionId: 'old', appendSystemPrompt: 'be brief' }, asked.host);
    await until(() => toolResults.some((r) => JSON.stringify(r).includes('No decision')));
    expect(sdkCalls.at(-1)?.options).toMatchObject({ resume: 'old', forkSession: true });
    await b.stop();
  });

  it('publishes the slash commands the session can run, without terminal-only ones', async () => {
    // Arrange
    const { host, last } = makeHost();

    // Act
    const runner = new ClaudeRunner({ vendor: 'claude', cwd: tempDir(), prompt: 'hello' }, host);
    await until(() => (last().slashCommands?.length ?? 0) > 0);

    // Assert
    expect(last().slashCommands).toEqual([
      { name: 'compact', description: 'Clear history but keep a summary', argumentHint: '<instructions>' },
      { name: 'review', description: 'Review a pull request', argumentHint: undefined },
    ]);
    await runner.send('learn skills');
    await until(() => last().slashCommands?.some((command) => command.name === 'deploy') ?? false);
    expect(last().slashCommands).toEqual([{ name: 'deploy', description: 'Ship it', argumentHint: '<env>' }]);
    await runner.stop();
  });

  it('reports SDK errors and exits', async () => {
    const { host, events, exits } = makeHost();
    new ClaudeRunner({ vendor: 'claude', cwd: tempDir(), prompt: 'boom' }, host);
    await until(() => exits.length === 1);
    expect(events.some((e) => e.kind === 'error' && e.summary.includes('model exploded'))).toBe(true);
  });
});

describe('CodexRunner (fake CLI)', () => {
  const entry = join(__dirname, 'fixtures', 'fake-codex.mjs');

  it('runs a turn, captures the thread id, then resumes for follow-ups', async () => {
    const { host, events, last } = makeHost();
    const runner = new CodexRunner({ vendor: 'codex', cwd: tempDir(), prompt: 'build it' }, host, entry);
    await expect(runner.send('too early')).rejects.toThrow(/mid-turn/);
    await until(() => last().status === 'idle');
    expect(runner.sessionId).toBe('thread-123');
    expect(events.map((e) => e.summary)).toEqual(expect.arrayContaining(['shell: ls', 'fresh: build it', 'turn complete']));
    await runner.send('and test it');
    await until(() => events.some((e) => e.summary === 'resumed: and test it'));
    expect(() => runner.setIntercepting()).toThrow(/not available/);
    await until(() => last().status === 'idle');
    await runner.stop();
    expect(last().status).toBe('stopped');
    await expect(runner.send('x')).rejects.toThrow(/stopped/);
  });

  it('surfaces CLI failures', async () => {
    const { host, events, last } = makeHost();
    new CodexRunner({ vendor: 'codex', cwd: tempDir(), prompt: 'FAIL please' }, host, entry);
    await until(() => last().status === 'idle');
    await settle();
    expect(events.some((e) => e.kind === 'error' && e.summary.includes('simulated failure'))).toBe(true);
  });

  it('can be interrupted mid-turn', async () => {
    const { host, events } = makeHost();
    const runner = new CodexRunner({ vendor: 'codex', cwd: tempDir(), prompt: 'SLOW' }, host, entry);
    await until(() => events.some((e) => e.summary === 'turn complete'));
    await runner.interrupt();
    expect(events.some((e) => e.summary.includes('interrupted'))).toBe(true);
    await runner.stop();
  });

  it('resolves the CLI from the override env var', () => {
    process.env.AGENT_TOWER_CODEX_JS = entry;
    expect(resolveCodexEntry()).toBe(entry);
    delete process.env.AGENT_TOWER_CODEX_JS;
  });
});

describe('ManagedAgents', () => {
  it('launches both vendors and tracks session ids', async () => {
    process.env.AGENT_TOWER_CODEX_JS = join(__dirname, 'fixtures', 'fake-codex.mjs');
    const { host } = makeHost();
    const managed = new ManagedAgents(host);
    const claude = managed.launch({ vendor: 'claude', cwd: tempDir(), prompt: 'hi' });
    const codex = managed.launch({ vendor: 'codex', cwd: tempDir(), prompt: 'hi' });
    await until(() => managed.sessionIds().size === 2);
    expect(managed.get(claude.id)).toBe(claude);
    expect(managed.get(codex.id)).toBe(codex);
    await managed.stopAll();
    delete process.env.AGENT_TOWER_CODEX_JS;
  });
});
