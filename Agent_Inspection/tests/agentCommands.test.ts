import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runAgentCommand, untilText, type CommandDeps } from '../daemon/commands/agentCommands.ts';
import type { ClaudeControl } from '../daemon/commands/types.ts';
import type { Agent } from '../daemon/domain/types.ts';
import type { UsageWindowsReport } from '../daemon/usage/windowTypes.ts';
import { makeAgent, tempDir } from './helpers.ts';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const tokens = { input: 100, output: 2000, cacheRead: 50_000, cacheWrite5m: 1000, cacheWrite1h: 0 };
const window = (start: number) => ({ start, end: start + 5 * 3_600_000, tokens, totalTokens: 53_100, costUsd: 1.25, unpricedTokens: 0, requests: 9 });

const report: UsageWindowsReport = {
  generatedAt: NOW, files: 3, filesRead: 0, scanMs: 5,
  vendors: [{
    vendor: 'claude',
    limits: [{ window: 'five_hour', label: '5-hour', usedPercent: 42, resetsAt: NOW + 2 * 3_600_000 + 14 * 60_000, observedAt: NOW, source: 'claude-sdk' }],
    block: window(NOW - 3_600_000),
    week: window(NOW - 7 * 86_400_000),
  }],
};

function fakeControl(overrides: Partial<ClaudeControl> = {}): ClaudeControl {
  return {
    mode: 'default', version: '2.9.0', currentModel: 'claude-opus-5-5',
    models: vi.fn(async () => [
      { value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Most capable' },
      { value: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Fast' },
    ]),
    setModel: vi.fn(async () => undefined),
    mcpStatus: vi.fn(async () => [{ name: 'github', status: 'connected', scope: 'user' }, { name: 'figma', status: 'disabled' }]),
    mcpReconnect: vi.fn(async () => undefined),
    mcpToggle: vi.fn(async () => undefined),
    contextUsage: vi.fn(async () => ({ totalTokens: 54_000, maxTokens: 200_000, percentage: 27, categories: [{ name: 'Messages', tokens: 40_000 }] })),
    setPermissionMode: vi.fn(async () => undefined),
    agentTypes: vi.fn(async () => [{ name: 'Explore', description: 'Searches code' }]),
    account: vi.fn(async () => ({ subscriptionType: 'max' })),
    ...overrides,
  };
}

function setup(agent: Agent, control?: ClaudeControl) {
  const home = tempDir();
  const audit = vi.fn();
  const restartWithModel = vi.fn(async () => undefined);
  const deps: CommandDeps = {
    agent: (id) => (id === agent.id ? agent : undefined),
    control: () => control,
    usageWindows: async () => report,
    restartWithModel,
    claudeHome: join(home, '.claude'),
    userConfigFile: join(home, '.claude.json'),
    audit,
    now: () => NOW,
  };
  return { deps, home, audit, restartWithModel };
}

const hooked = (overrides: Partial<Agent> = {}) => makeAgent({ id: 'claude:s1', vendor: 'claude', tier: 'B', hooked: true, model: 'claude-opus-5-5', ...overrides });
const managed = (overrides: Partial<Agent> = {}) => makeAgent({ id: 'managed:1', vendor: 'claude', tier: 'A', ...overrides });

describe('/usage and /cost', () => {
  it('shows the reported plan window, the local estimates and this session', async () => {
    // Arrange
    const { deps } = setup(hooked({ usage: { tokens, costUsd: 3.5 } }));

    // Act
    const result = await runAgentCommand(deps, 'claude:s1', 'usage', '');

    // Assert
    const rows = result.sections.flatMap(section => section.rows);
    expect(rows[0]).toMatchObject({ label: '5-hour window', value: '42% used', meter: 42, detail: 'resets in 2h 14m' });
    expect(rows.some(row => row.label === 'Current 5-hour block (estimate)' && row.value === '53.1k tokens')).toBe(true);
    expect(rows.some(row => row.label === 'Estimated cost' && row.value === '$3.50')).toBe(true);
  });

  it('says so when a session has no usage yet', async () => {
    const { deps } = setup(hooked());
    const result = await runAgentCommand(deps, 'claude:s1', '/cost', '');
    expect(result.sections[0].rows[0]).toMatchObject({ value: 'No usage recorded yet', tone: 'muted' });
  });
});

describe('/model', () => {
  it('lists models with switch actions and switches live for an agent launched here', async () => {
    // Arrange
    const control = fakeControl();
    const { deps, audit } = setup(managed(), control);

    // Act
    const list = await runAgentCommand(deps, 'managed:1', 'model', '');
    const switched = await runAgentCommand(deps, 'managed:1', 'model', 'claude-sonnet-5-5');

    // Assert
    const options = list.sections[1].rows;
    expect(options.find(row => row.label === 'Sonnet 5.5')?.actions).toEqual([{ label: 'Use', command: '/model claude-sonnet-5-5' }]);
    expect(options.find(row => row.label === 'Opus 5.5')?.actions).toEqual([]);
    expect(control.setModel).toHaveBeenCalledWith('claude-sonnet-5-5');
    expect(audit).toHaveBeenCalledWith('set_model', 'managed:1', { model: 'claude-sonnet-5-5' });
    expect(switched.done).toBe('Switched to claude-sonnet-5-5');
  });

  it('shows the model of a session outside Waystation but refuses to switch it', async () => {
    const { deps } = setup(hooked());
    const shown = await runAgentCommand(deps, 'claude:s1', 'model', '');
    expect(shown.sections[0].rows[0].value).toBe('claude-opus-5-5');
    await expect(runAgentCommand(deps, 'claude:s1', 'model', 'claude-sonnet-5-5')).rejects.toThrow(/\/cli/);
  });

  it('restarts a Codex agent launched here on the new model, and rejects odd names', async () => {
    const { deps, restartWithModel } = setup(makeAgent({ id: 'managed:c', vendor: 'codex', tier: 'A' }));
    await runAgentCommand(deps, 'managed:c', 'model', 'gpt-5.5-codex');
    expect(restartWithModel).toHaveBeenCalledWith('managed:c', 'gpt-5.5-codex');
    await expect(runAgentCommand(deps, 'managed:c', 'model', 'rm -rf /')).rejects.toThrow(/model name/);
  });
});

describe('/mcp', () => {
  it('reports live status with actions, and reconnects or disables a known server', async () => {
    // Arrange
    const control = fakeControl();
    const { deps, audit } = setup(managed(), control);

    // Act
    const list = await runAgentCommand(deps, 'managed:1', 'mcp', '');
    const disabled = await runAgentCommand(deps, 'managed:1', 'mcp', 'disable github');

    // Assert
    expect(list.sections[0].rows[0]).toMatchObject({ label: 'github', value: 'connected', tone: 'ok' });
    expect(list.sections[0].rows[1].actions).toEqual([{ label: 'Enable', command: '/mcp enable figma' }]);
    expect(control.mcpToggle).toHaveBeenCalledWith('github', false);
    expect(audit).toHaveBeenCalledWith('mcp_disable', 'managed:1', { server: 'github' });
    expect(disabled.done).toBe('Disabled github');
    await expect(runAgentCommand(deps, 'managed:1', 'mcp', 'reconnect nope')).rejects.toThrow(/No MCP server/);
  });

  it('lists configured servers for a session outside Waystation without leaking commands or env', async () => {
    // Arrange
    const cwd = tempDir();
    const agent = hooked({ cwd });
    const { deps } = setup(agent);
    writeFileSync(deps.userConfigFile, JSON.stringify({
      mcpServers: { github: { command: 'npx', args: ['gh-mcp'], env: { GITHUB_TOKEN: 'secret-token-value' } } },
      projects: { [cwd.replace(/\\/g, '/')]: { mcpServers: { local: { type: 'sse', url: 'http://localhost:9' } } } },
    }));
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abc' } } } }));

    // Act
    const result = await runAgentCommand(deps, 'claude:s1', 'mcp', '');

    // Assert
    const rows = result.sections[0].rows;
    expect(rows.map(row => [row.label, row.value, row.detail])).toEqual([
      ['github', 'stdio', 'user scope'], ['local', 'sse', 'local scope'], ['docs', 'http', 'project scope'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret-token-value|Bearer abc|gh-mcp/);
    await expect(runAgentCommand(deps, 'claude:s1', 'mcp', 'reconnect github')).rejects.toThrow(/outside/);
  });
});

describe('/context, /status, /memory, /agents, /mode', () => {
  it('uses the SDK breakdown when available, and the last request otherwise', async () => {
    const live = setup(managed(), fakeControl());
    expect((await runAgentCommand(live.deps, 'managed:1', 'context', '')).sections[0].rows[0]).toMatchObject({ meter: 27, value: '54.0k of 200.0k tokens' });
    const observed = setup(hooked({ usage: { tokens, contextTokens: 150_000, contextWindow: 200_000 } }));
    expect((await runAgentCommand(observed.deps, 'claude:s1', 'context', '')).sections[0].rows[0]).toMatchObject({ meter: 75, tone: 'warn' });
  });

  it('shows status with mode switches for an agent launched here', async () => {
    const { deps } = setup(managed({ cwd: 'C:/repo', sessionId: 'abc' }), fakeControl());
    const rows = (await runAgentCommand(deps, 'managed:1', 'status', '')).sections[0].rows;
    expect(rows.find(row => row.label === 'Permission mode')?.actions?.map(action => action.command)).toEqual(['/mode acceptEdits', '/mode plan']);
    expect(rows.find(row => row.label === 'Plan')?.value).toBe('max');
  });

  it('lists CLAUDE.md files and subagent definitions from disk', async () => {
    // Arrange
    const cwd = tempDir();
    const { deps } = setup(hooked({ cwd }));
    mkdirSync(join(deps.claudeHome, 'agents'), { recursive: true });
    writeFileSync(join(deps.claudeHome, 'CLAUDE.md'), '# me');
    writeFileSync(join(deps.claudeHome, 'agents', 'reviewer.md'), '---');
    writeFileSync(join(cwd, 'CLAUDE.md'), '# project');

    // Act
    const memory = await runAgentCommand(deps, 'claude:s1', 'memory', '');
    const agents = await runAgentCommand(deps, 'claude:s1', 'agents', '');

    // Assert
    expect(memory.sections[0].rows.map(row => row.label)).toEqual(['User memory', 'Project memory']);
    expect(agents.sections[0].rows).toEqual([{ label: 'reviewer', detail: 'user agent' }]);
  });

  it('changes permission mode only for agents launched here, and only to safe modes', async () => {
    const control = fakeControl();
    const { deps } = setup(managed(), control);
    await runAgentCommand(deps, 'managed:1', 'mode', 'plan');
    expect(control.setPermissionMode).toHaveBeenCalledWith('plan');
    await expect(runAgentCommand(deps, 'managed:1', 'mode', 'bypassPermissions')).rejects.toThrow(/Use \/mode/);
    const outside = setup(hooked());
    await expect(runAgentCommand(outside.deps, 'claude:s1', 'mode', 'plan')).rejects.toThrow(/launched in Waystation/);
  });

  it('rejects unknown commands, Claude-only commands for Codex, and missing agents', async () => {
    const { deps } = setup(makeAgent({ id: 'codex:1', vendor: 'codex', tier: 'C' }));
    await expect(runAgentCommand(deps, 'codex:1', 'compact', '')).rejects.toThrow(/not a command/);
    await expect(runAgentCommand(deps, 'codex:1', 'mcp', '')).rejects.toThrow(/Claude Code command/);
    await expect(runAgentCommand(deps, 'gone', 'usage', '')).rejects.toThrow(/not found/);
  });

  it('formats reset times', () => {
    expect(untilText(NOW + 45 * 60_000, NOW)).toBe('resets in 45m');
    expect(untilText(NOW + 3 * 86_400_000 + 5 * 3_600_000, NOW)).toBe('resets in 3d 5h');
  });
});
