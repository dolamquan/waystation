import { describe, expect, it, vi } from 'vitest';
import type { ManagedHost } from '../daemon/managed/types.ts';
import { tempDir } from './helpers.ts';

const captured = vi.hoisted(() => ({ claude: undefined as any, copilot: undefined as any }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (input: any) => {
  captured.claude = input.options;
  return { async *[Symbol.asyncIterator]() { for await (const _ of input.prompt) { yield { type: 'result', subtype: 'success' }; } }, interrupt: async () => {} };
} }));
vi.mock('@github/copilot-sdk', () => ({ CopilotClient: class {
  async start() {} async stop() {} async getAuthStatus() { return { isAuthenticated: true }; }
  async createSession(config: any) { captured.copilot = config; return { sessionId: 'restrained-test', on() {}, async sendAndWait() {}, async disconnect() {}, async abort() {} }; }
} }));
const { ClaudeRunner, guardHooks } = await import('../daemon/managed/claudeRunner.ts');
const { CopilotRunner } = await import('../daemon/managed/copilotRunner.ts');
const { validateLaunch } = await import('../daemon/managed/managedAgents.ts');
const { WaystationAutomation } = await import('../daemon/automation/automation.ts');
const { TowerStore } = await import('../daemon/store/db.ts');
const host = (): ManagedHost => ({ onAgent: vi.fn(), onEvent: vi.fn(), onExit: vi.fn(), requestDecision: vi.fn(async () => ({ behavior: 'deny' as const, message: 'Not approved.' })) });

describe('restrained coding runtimes', () => {
  it('disables Claude tools and inherited settings and denies tool calls even with Intercept off', async () => {
    const h = host(); const launch = { vendor: 'claude', cwd: tempDir(), prompt: '', toolPolicy: 'chat-only' as const };
    const runner = new ClaudeRunner(launch, h);
    try {
      expect(captured.claude.tools).toEqual([]); expect(captured.claude.settingSources).toEqual([]); expect(captured.claude.maxTurns).toBe(8);
      expect(await captured.claude.canUseTool('Bash', { command: 'anything' }, {})).toMatchObject({ behavior: 'deny' });
      const hook = guardHooks(launch)[0].hooks[0];
      const decision = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'anything' } } as any, undefined, { signal: new AbortController().signal });
      expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
      expect(h.requestDecision).not.toHaveBeenCalled();
    } finally { await runner.stop(); }
  });
  it('reviews normally preapproved Claude tools in a programmatic hook even after Intercept is switched off', async () => {
    const h = host(); const runner = new ClaudeRunner({ vendor: 'claude', cwd: tempDir(), prompt: '', toolPolicy: 'review-tools' }, h);
    try {
      runner.setIntercepting(false);
      const hook = captured.claude.hooks.PreToolUse[0].hooks[0];
      expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'notes.md' } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
      expect(h.requestDecision).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'Read' }), expect.any(AbortSignal));
    } finally { await runner.stop(); }
  });
  it('blocks Copilot tools and permissions, or requires review regardless of the Intercept toggle', async () => {
    for (const policy of ['chat-only', 'review-tools'] as const) {
      const h = host(); const runner = new CopilotRunner({ vendor: 'copilot', cwd: tempDir(), prompt: 'hello', toolPolicy: policy }, h);
      try {
        await vi.waitFor(() => expect(captured.copilot).toBeDefined()); const config = captured.copilot; runner.setIntercepting(false);
        expect(await config.hooks.onPreToolUse({ toolName: 'powershell', toolArgs: {} })).toMatchObject({ permissionDecision: 'deny' });
        if (policy === 'chat-only') { expect(await config.onPermissionRequest({ kind: 'shell' })).toMatchObject({ kind: 'reject' }); expect(h.requestDecision).not.toHaveBeenCalled(); }
        else expect(h.requestDecision).toHaveBeenCalled();
      } finally { await runner.stop(); captured.copilot = undefined; }
    }
  });
  it('rejects unsupported runtime restraints and omits automatic application tools from restrained agents', () => {
    expect(() => validateLaunch({ vendor: 'codex', cwd: tempDir(), prompt: 'hello', toolPolicy: 'chat-only' })).toThrow(/support Claude and Copilot/);
    const db = new TowerStore(':memory:');
    try {
      const automation = new WaystationAutomation(db); automation.setEndpoint('http://127.0.0.1:4317');
      expect(automation.attachDefaults({ vendor: 'claude', cwd: tempDir(), prompt: '', toolPolicy: 'chat-only' }).mcpServers).toBeUndefined();
    } finally { db.close(); }
  });
});
