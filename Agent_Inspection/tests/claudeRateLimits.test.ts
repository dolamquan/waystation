import { describe, expect, it, vi } from 'vitest';
import type { ManagedHost } from '../daemon/managed/types.ts';
import { tempDir } from './helpers.ts';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-limits-1' };
      yield {
        type: 'rate_limit_event', uuid: 'u1', session_id: 'sdk-limits-1',
        rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.91, resetsAt: 1_791_300_000 },
      };
      yield { type: 'result', subtype: 'success' };
    }
    const gen = run() as AsyncGenerator<unknown> & { interrupt: () => Promise<void>; supportedCommands: () => Promise<unknown[]> };
    gen.interrupt = vi.fn(async () => undefined);
    gen.supportedCommands = vi.fn(async () => []);
    return gen;
  },
}));

const { ClaudeRunner } = await import('../daemon/managed/claudeRunner.ts');
const { claudeSdkLimits } = await import('../daemon/usage/planLimits.ts');

describe('ClaudeRunner plan limits', () => {
  it('records Agent SDK rate_limit_event readings for the Usage page', async () => {
    // Arrange
    const exits: string[] = [];
    const host: ManagedHost = {
      onAgent: () => undefined,
      onEvent: () => undefined,
      onExit: (id) => exits.push(id),
      requestDecision: vi.fn(async () => ({ behavior: 'allow' as const })),
    };

    // Act
    new ClaudeRunner({ vendor: 'claude', cwd: tempDir(), prompt: 'hi' }, host);
    const started = Date.now();
    while (exits.length === 0 && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 10));

    // Assert
    expect(claudeSdkLimits.list()).toEqual([expect.objectContaining({
      window: 'five_hour', label: '5-hour', status: 'allowed_warning', usedPercent: 91, resetsAt: 1_791_300_000_000, source: 'claude-sdk',
    })]);
  });
});
