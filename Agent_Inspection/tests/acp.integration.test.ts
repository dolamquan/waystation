import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRepo, tempDir } from './helpers.ts';
import type { AcpRunner as AcpRunnerType } from '../daemon/managed/acpRunner.ts';
import type { AgentEvent, PendingInterception, TokenCounts } from '../daemon/domain/types.ts';
import type { ManagedHost } from '../daemon/managed/types.ts';

process.env.AGENT_TOWER_HOME = tempDir('acp-tower-');
process.env.CLAUDE_HOME = tempDir('acp-claude-');
process.env.CODEX_HOME = tempDir('acp-codex-');
const { Tower } = await import('../daemon/tower.ts');
const { AcpRunner } = await import('../daemon/managed/acpRunner.ts');
const { startServer } = await import('../daemon/api/server.ts');
const fixture = resolve('tests/fixtures/acp-agent.mjs');
const TOKEN = 'acp-test-token-0123456789';
let tower: InstanceType<typeof Tower> | undefined;
let server: Server | undefined, port: number;
const runners: AcpRunnerType[] = [];
async function until(predicate: () => boolean) { for (let n = 0; n < 300; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Timed out waiting for ACP'); }
async function open() {
  tower = new Tower(':memory:');
  vi.spyOn(tower.copilotAccount, 'read').mockResolvedValue({ authenticated: false, limits: [], models: [] });
  server = await startServer({ tower, port: 47453, host: '127.0.0.1', token: TOKEN });
  port = (server.address() as { port: number }).port;
}
const api = async (method: string, path: string, body?: unknown, token = TOKEN) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-tower-token': token, 'content-type': 'application/json', connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, json: await response.json() as any };
};
const registration = { id: 'acp-fixture', label: 'Fixture Agent', command: process.execPath, args: [fixture], usageMode: 'session' as const };
afterEach(async () => {
  await Promise.all(runners.splice(0).map(runner => runner.stop()));
  for (const team of tower?.teams.list() ?? []) await tower!.disbandTeam(team.id, true);
  server?.close(); if (tower) { await tower.shutdown(); tower = undefined; }
  writeFileSync(join(process.env.AGENT_TOWER_HOME!, 'providers.json'), '{"providers":[]}');
});

describe('runtime ACP integrations', () => {
  it('registers an arbitrary provider after startup and shares launch, chat, usage, templates, schedules and recovery', async () => {
    await open();
    expect((await api('POST', '/api/providers/acp', registration, 'wrong-token')).status).toBe(401);
    expect((await api('POST', '/api/providers/acp', registration)).status).toBe(200);
    expect((await api('GET', '/api/providers')).json.providers).toContainEqual(expect.objectContaining({ id: registration.id, adapter: 'acp' }));
    const launched = await api('POST', '/api/managed', { vendor: registration.id, cwd: tempDir(), prompt: 'hello', model: 'test-model' });
    expect(launched.status, JSON.stringify(launched.json)).toBe(200);
    const id = launched.json.agent.id;
    await until(() => tower!.registry.get(id)?.status === 'idle' && !!tower!.registry.get(id)?.sessionId);
    const agent = tower!.registry.get(id)!;
    expect(agent).toMatchObject({ vendor: registration.id, providerLabel: registration.label, tier: 'A', capabilities: { resume: true }, usage: { tokens: { input: 100, output: 20 }, contextTokens: 1234, contextWindow: 100000 } });
    expect(tower!.events(id).some(event => event.summary === 'Reply to hello')).toBe(true);
    await api('POST', `/api/agents/${id}/instruct`, { text: 'follow up' });
    await until(() => tower!.registry.get(id)?.usage?.tokens.input === 200);
    const report = (await api('GET', '/api/usage/windows')).json.windows.vendors.find((vendor: any) => vendor.vendor === registration.id);
    expect(report.week).toMatchObject({ totalTokens: 240, requests: 2 }); expect(report.week.costUsd).toBeUndefined(); expect(report.limits).toEqual([]);
    expect((await api('POST', '/api/templates', { label: 'Custom builder', vendor: registration.id })).status).toBe(200);
    expect((await api('POST', `/api/agents/${id}/stop`, { confirm: true })).status).toBe(200);
    expect((await api('GET', '/api/sessions')).json.sessions.find((session: any) => session.id === id).canResume).toBe(true);
    expect((await api('POST', `/api/sessions/${id}/resume`)).status).toBe(200);
    await until(() => tower!.registry.get(id)?.status === 'idle' && tower!.registry.get(id)?.capabilities?.resume === true);
    // Recovery itself sends no prompt and records no new usage.
    expect(tower!.store.loadRecords('provider_usage')).toHaveLength(2);
    const schedule = await api('POST', '/api/schedules', { label: 'Dynamic daily', time: '09:00', days: [1], enabled: false, launch: { vendor: registration.id, cwd: tempDir(), prompt: 'scheduled' } });
    expect(schedule.status, JSON.stringify(schedule.json)).toBe(200);
    expect((await api('POST', `/api/schedules/${schedule.json.schedule.id}/run`)).status).toBe(200);
    await until(() => tower!.registry.list().some(agent => tower!.events(agent.id).some(event => event.summary === 'Reply to scheduled')));
    // Removing a registration prevents future launches without stopping an existing session.
    expect((await api('POST', `/api/providers/${registration.id}/remove`)).status).toBe(200);
    expect(tower!.registry.get(id)?.status).toBe('idle');
    expect((await api('POST', '/api/managed', { vendor: registration.id, cwd: tempDir(), prompt: 'hello' })).status).toBe(400);
  });
  it('uses the shared team bridge for dynamically registered members without putting secrets in argv', async () => {
    await open(); const capture = join(tempDir(), 'config.json');
    await api('POST', '/api/providers/acp', { ...registration, env: { CAPTURE_ACP_CONFIG: capture, HOLD_ACP_PROMPTS: '1', PRIVATE_AUTH: 'never-public' } });
    expect(JSON.stringify((await api('GET', '/api/providers')).json)).not.toContain('never-public');
    const created = await api('POST', '/api/teams', { name: 'ACP team', goal: 'Build greeting', cwd: makeRepo(), requirePlanApproval: false,
      members: [{ name: 'lead', role: 'lead', vendor: registration.id }, { name: 'worker', vendor: registration.id }] });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    await until(() => { try { return JSON.parse(readFileSync(capture, 'utf8')).mcpServers.length > 0; } catch { return false; } });
    const config = JSON.parse(readFileSync(capture, 'utf8'));
    const bridge = config.mcpServers.find((server: any) => server.env?.some((entry: any) => entry.name === 'AGENT_TOWER_TEAM_TOKEN'));
    expect(bridge).toBeDefined();
    const secret = bridge.env.find((entry: any) => entry.name === 'AGENT_TOWER_TEAM_TOKEN').value;
    expect(bridge.args.join(' ')).not.toContain(secret);
    const task = await api('POST', `/api/teams/${created.json.team.id}/tasks`, { title: 'Write greeting', assignee: 'worker' }); expect(task.status).toBe(200);
    await until(() => tower!.teams.list()[0].members.some(member => member.name === 'worker' && !!member.agentId));
  });
  it('handles permissions, protected file requests, cancellation and cumulative usage over a real subprocess', async () => {
    const events: AgentEvent[] = [], samples: any[] = [];
    const decisions: Omit<PendingInterception, 'id' | 'createdAt'>[] = [];
    const cwd = tempDir();
    const host: ManagedHost = { onAgent() {}, onEvent: event => events.push(event), onExit() {}, onUsage: sample => samples.push(sample),
      requestDecision: async request => { decisions.push(request); return { behavior: 'allow' }; } };
    const runner = new AcpRunner({ vendor: registration.id, cwd, prompt: 'approval', intercept: true, writeRoot: cwd, readGuard: { deny: process.env.AGENT_TOWER_HOME!, allow: cwd } }, host, registration, { command: process.execPath, args: [fixture] }); runners.push(runner);
    await until(() => runner.snapshot().status === 'idle' && events.some(event => event.summary === 'Permission: yes'));
    expect(decisions).toHaveLength(1);
    await runner.send(`write:${join(tempDir(), 'outside.txt')}`);
    await until(() => events.some(event => event.summary === 'File request denied'));
    await until(() => runner.snapshot().status === 'idle');
    const file = join(cwd, 'inside.txt'); await runner.send(`write:${file}`);
    await until(() => events.some(event => event.summary === 'File request succeeded'));
    expect(readFileSync(file, 'utf8')).toBe('written by ACP fixture');
    await until(() => runner.snapshot().status === 'idle');
    expect(samples.map(sample => sample.tokens.input)).toEqual([100, 100, 100]);
    await runner.send('wait forever'); await until(() => runner.snapshot().status === 'busy');
    await runner.interrupt(); await until(() => runner.snapshot().status === 'idle');
    await runner.stop(); expect(runner.snapshot().status).toBe('stopped');
  });
  it('explains missing authentication and does not offer unsupported recovery', async () => {
    await open(); await api('POST', '/api/providers/acp', { ...registration, args: [fixture, '--no-resume'] });
    const launched = await api('POST', '/api/managed', { vendor: registration.id, cwd: tempDir(), prompt: 'no usage' }); const id = launched.json.agent.id;
    await until(() => tower!.registry.get(id)?.status === 'idle' && !!tower!.registry.get(id)?.sessionId);
    expect(tower!.store.loadRecords('provider_usage')).toEqual([]);
    expect((await api('POST', `/api/agents/${id}/restart`, {})).status).toBe(400);
    await api('POST', `/api/agents/${id}/stop`, { confirm: true });
    expect((await api('GET', '/api/sessions')).json.sessions.find((session: any) => session.id === id)).toMatchObject({ canResume: false });
    await api('POST', '/api/providers/acp', { ...registration, id: 'signed-out', args: [fixture, '--signed-out'] });
    const failure = await api('POST', '/api/managed', { vendor: 'signed-out', cwd: tempDir(), prompt: 'hello' });
    await until(() => tower!.registry.get(failure.json.agent.id)?.status === 'stopped');
    expect(tower!.registry.get(failure.json.agent.id)?.lastError).toMatch(/Sign in/);
  });
  it('counts equal per-turn reports separately and keeps unspecified usage readings out of totals', async () => {
    const samples: any[] = [];
    const host: ManagedHost = { onAgent() {}, onEvent() {}, onExit() {}, onUsage: sample => samples.push(sample), requestDecision: async () => ({ behavior: 'deny', message: 'No' }) };
    const executable = { command: process.execPath, args: [fixture, '--turn-usage'] };
    const runner = new AcpRunner({ vendor: registration.id, cwd: tempDir(), prompt: 'hello' }, host, { ...registration, usageMode: 'turn' }, executable); runners.push(runner);
    await until(() => runner.snapshot().status === 'idle' && samples.length === 1);
    await runner.send('hello again'); await until(() => runner.snapshot().status === 'idle' && samples.length === 2);
    expect(runner.snapshot().usage?.tokens).toMatchObject({ input: 200, output: 40 });
    expect(samples[0].id).not.toBe(samples[1].id);
    const unknown = new AcpRunner({ vendor: registration.id, cwd: tempDir(), prompt: 'hello' }, host, { ...registration, usageMode: undefined }, executable); runners.push(unknown);
    await until(() => unknown.snapshot().status === 'idle' && !!unknown.snapshot().usage?.reportedTokens);
    expect(unknown.snapshot().usage).toMatchObject({ tokensReported: false, reportedTokens: { input: 100, output: 20 } });
    expect(samples).toHaveLength(2);
  });
});
