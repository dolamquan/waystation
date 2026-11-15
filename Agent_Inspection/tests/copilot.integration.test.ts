import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRepo, tempDir } from './helpers.ts';

const configs: any[] = [];
const clients: any[] = [];
const prompts: string[] = [];
const toolDecisions: any[] = [];
let authenticated = true;
let seq = 0;
vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: class {
    readonly rpc = { account: { getQuota: async () => ({ quotaSnapshots: { premium_interactions: { isUnlimitedEntitlement: false, remainingPercentage: 75, resetDate: '2026-11-01T00:00:00Z' } } }) } };
    constructor(readonly options: any) { clients.push(this); }
    async start() {}
    async stop() {}
    async getAuthStatus() { return { isAuthenticated: authenticated }; }
    async listModels() { return [{ id: 'model-test', name: 'Copilot test model' }, { id: 'disabled-model', name: 'Disabled', policy: { state: 'disabled' } }]; }
    async createSession(config: any) { return this.makeSession(`copilot-${++seq}`, config); }
    async resumeSession(id: string, config: any) { return this.makeSession(id, config); }
    makeSession(sessionId: string, config: any) {
      configs.push({ sessionId, ...config });
      const handlers: any[] = [];
      let aborted = false;
      let release: (() => void) | undefined;
      const emit = (type: string, data: any, id = `${sessionId}-${++seq}`) => handlers.forEach(handler => handler({ id, timestamp: new Date().toISOString(), type, data }));
      return { sessionId, on: (handler: any) => { handlers.push(handler); },
        rpc: { accounts: { login: {
          begin: async () => ({ flowId: 'flow-test', step: { kind: 'open-url', url: 'https://github.com/login/device' } }),
          advance: async () => { authenticated = true; return { kind: 'completed', result: { status: 'success' } }; },
          cancel: async () => {},
        } } },
        async disconnect() {},
        async abort() { aborted = true; release?.(); },
        async sendAndWait(message: any) {
          prompts.push(message.prompt); aborted = false;
          if (message.prompt === 'wait forever' || Object.values(config.mcpServers ?? {}).some((server: any) => server.env?.AGENT_TOWER_TEAM_TOKEN)) await new Promise<void>(resolve => { release = resolve; });
          if (aborted) return;
          if (message.prompt === 'approval') {
            const result = await config.hooks.onPreToolUse({ toolName: 'powershell', toolArgs: { command: 'echo original' } }, { sessionId });
            toolDecisions.push(result);
            if (aborted) return;
          }
          if (message.prompt === 'private read') {
            toolDecisions.push(await config.hooks.onPreToolUse({ toolName: 'view', toolArgs: { path: join(process.env.AGENT_TOWER_HOME!, 'secrets.json') } }, { sessionId }));
          }
          emit('assistant.message', { content: `Reply to ${message.prompt}` });
          const usageId = `${sessionId}-usage-${seq}`;
          const usage = { model: config.model ?? 'model-test', inputTokens: 100, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 0 };
          emit('assistant.usage', usage, usageId); emit('assistant.usage', usage, usageId);
          emit('session.usage_info', { currentTokens: 1234, tokenLimit: 100000 });
          return { data: { content: 'done' } };
        },
      };
    }
  },
}));
process.env.AGENT_TOWER_HOME = tempDir('copilot-tower-');
process.env.CLAUDE_HOME = tempDir('copilot-claude-');
process.env.CODEX_HOME = tempDir('copilot-codex-');
const { Tower } = await import('../daemon/tower.ts');
const { startServer } = await import('../daemon/api/server.ts');
const { MANAGED_PROVIDERS } = await import('../shared/agentProviders.ts');
const { RUNNER_FACTORIES } = await import('../daemon/managed/managedAgents.ts');
const TOKEN = 'copilot-test-token-0123456789';
const port = 47451;
let tower: InstanceType<typeof Tower>;
let server: Server | undefined;
async function open() { tower = new Tower(':memory:'); server = await startServer({ tower, port, host: '127.0.0.1', token: TOKEN }); }
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-tower-token': TOKEN, 'content-type': 'application/json', connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, json: await response.json() as any };
};
async function until(predicate: () => boolean) { for (let n = 0; n < 250; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Timed out waiting for Copilot'); }
afterEach(async () => { for (const team of tower?.teams.list() ?? []) await tower.disbandTeam(team.id, true); server?.close(); await tower?.shutdown(); authenticated = true; });

describe('managed provider registration and Copilot', () => {
  it('registers every provider and supports launch, chat, context, usage, model restart, templates and history recovery', async () => {
    expect(Object.keys(RUNNER_FACTORIES).sort()).toEqual(MANAGED_PROVIDERS.map(provider => provider.id).sort());
    await open();
    const launched = await api('POST', '/api/managed', { vendor: 'copilot', cwd: tempDir(), prompt: 'hello', model: 'model-test', appendSystemPrompt: 'My role instructions' });
    expect(launched.status).toBe(200);
    const id = launched.json.agent.id;
    await until(() => tower.registry.get(id)?.status === 'idle' && tower.registry.get(id)?.sessionId !== undefined);
    const agent = tower.registry.get(id)!;
    expect(agent).toMatchObject({ vendor: 'copilot', tier: 'A', canInstruct: true, model: 'model-test', usage: { tokens: { input: 80, output: 30, cacheRead: 20 }, contextTokens: 1234, contextWindow: 100000 } });
    expect(agent.usage?.costUsd).toBeUndefined();
    expect(configs.at(-1).systemMessage.content).toContain('My role instructions');
    expect((await api('POST', `/api/agents/${id}/instruct`, { text: 'follow up' })).status).toBe(200);
    await until(() => tower.events(id).some(event => event.summary === 'Reply to follow up'));
    expect(tower.registry.get(id)?.sessionId).toBe(agent.sessionId);
    const account = (await api('GET', '/api/providers/copilot')).json;
    expect(account).toMatchObject({ authenticated: true, limits: [{ usedPercent: 25, source: 'copilot' }], models: [{ id: 'model-test' }] });
    const report = (await api('GET', '/api/usage/windows')).json.windows.vendors.find((vendor: any) => vendor.vendor === 'copilot');
    expect(report.week.totalTokens).toBe(260); expect(report.week.costUsd).toBeUndefined();
    expect((await api('POST', `/api/agents/${id}/command`, { name: 'usage' })).json.result.sections[0].heading).toContain('GitHub Copilot');
    expect((await api('POST', '/api/templates', { label: 'Copilot template', vendor: 'copilot', intercept: true })).json.template).toMatchObject({ vendor: 'copilot', intercept: true });
    const restart = await api('POST', `/api/agents/${id}/restart`, { confirm: true, model: 'model-switched' });
    expect(restart.status).toBe(200);
    await until(() => tower.registry.get(id)?.status === 'idle');
    expect(tower.registry.get(id)?.sessionId).toBe(agent.sessionId);
    expect(tower.registry.get(id)?.model).toBe('model-switched');
    expect((await api('POST', `/api/agents/${id}/stop`, { confirm: true })).status).toBe(200);
    tower.registry.drop('managed', id); // Simulates the managed card's linger period expiring.
    expect((await api('POST', `/api/sessions/${id}/resume`)).status).toBe(200);
    await until(() => tower.registry.get(id)?.sessionId === agent.sessionId && tower.registry.get(id)?.status === 'idle');
  });
  it('supports editable tool approvals, cancellation and user-controlled sign-in without a model prompt', async () => {
    await open();
    const launched = await api('POST', '/api/managed', { vendor: 'copilot', cwd: tempDir(), prompt: 'approval', intercept: true });
    const id = launched.json.agent.id;
    await until(() => tower.interceptions.list().some(item => item.agentId === id));
    const item = tower.interceptions.list().find(item => item.agentId === id)!;
    tower.decide(item.id, { behavior: 'allow', updatedInput: { command: 'echo edited' } });
    await until(() => tower.registry.get(id)?.status === 'idle');
    expect(toolDecisions.at(-1)).toMatchObject({ permissionDecision: 'allow', modifiedArgs: { command: 'echo edited' } });
    await api('POST', `/api/agents/${id}/instruct`, { text: 'wait forever' });
    await until(() => tower.registry.get(id)?.status === 'busy');
    expect((await api('POST', `/api/agents/${id}/interrupt`)).status).toBe(200);
    await until(() => tower.registry.get(id)?.status === 'idle');
    authenticated = false;
    const count = prompts.length;
    const begin = (await api('POST', '/api/providers/copilot/auth/begin')).json;
    expect(begin.step.kind).toBe('open-url');
    expect(configs.at(-1).availableTools).toEqual([]);
    expect((await api('POST', '/api/providers/copilot/auth/advance', { flowId: begin.flowId })).json.kind).toBe('completed');
    expect(prompts).toHaveLength(count);
    expect((await api('GET', '/api/providers/copilot?refresh=1')).json.authenticated).toBe(true);
  });
  it('runs Copilot team members through the shared MCP bridge and launches scheduled Copilot tasks', async () => {
    await open();
    const created = await api('POST', '/api/teams', { name: 'Copilot team', goal: 'Build a greeting', cwd: makeRepo(), requirePlanApproval: false,
      members: [{ name: 'lead', role: 'lead', vendor: 'copilot' }, { name: 'worker', vendor: 'copilot' }] });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    await until(() => tower.registry.list().some(agent => agent.vendor === 'copilot'));
    const team = created.json.team;
    const config = configs.find(config => Object.keys(config.mcpServers ?? {}).some(name => name.includes('team')))!;
    expect(config).toBeDefined();
    const bridge = Object.values(config.mcpServers).find((server: any) => server.env?.AGENT_TOWER_TEAM_TOKEN) as any;
    expect(bridge.env.AGENT_TOWER_TEAM_TOKEN).toBeTruthy();
    expect(bridge.args.join(' ')).not.toContain(bridge.env.AGENT_TOWER_TEAM_TOKEN);
    const task = await api('POST', `/api/teams/${team.id}/tasks`, { title: 'Write greeting', assignee: 'worker' });
    expect(task.status).toBe(200);
    await until(() => tower.teams.list().find(item => item.id === team.id)!.members.some(member => member.name === 'worker' && !!member.agentId));
    const schedule = await api('POST', '/api/schedules', { label: 'Copilot daily', time: '09:00', days: [1], enabled: false,
      launch: { vendor: 'copilot', cwd: tempDir(), prompt: 'scheduled task' } });
    expect(schedule.status, JSON.stringify(schedule.json)).toBe(200);
    expect((await api('POST', `/api/schedules/${schedule.json.schedule.id}/run`)).status).toBe(200);
    await until(() => prompts.includes('scheduled task'));
  });
  it('fails a signed-out launch clearly instead of leaving a fake working agent', async () => {
    authenticated = false; await open();
    const launched = await api('POST', '/api/managed', { vendor: 'copilot', cwd: tempDir(), prompt: 'do work' });
    const id = launched.json.agent.id;
    await until(() => tower.registry.get(id)?.status === 'stopped');
    expect(tower.registry.get(id)?.lastError).toMatch(/Sign in/);
    expect(tower.registry.get(id)?.canInstruct).toBe(false);
  });
});
