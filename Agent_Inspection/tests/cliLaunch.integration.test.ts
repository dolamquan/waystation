import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeRepo, tempDir } from './helpers.ts';

const PORT = 47_321;
const TOKEN = 'cli-token-0123456789abcdef';
const PROJECT_ROOT = join(__dirname, '..');
const towerHome = join(tempDir('tower-'), 'agent-tower');
const ticketsDir = join(towerHome, 'cli-tickets');
mkdirSync(towerHome, { recursive: true });
process.env.AGENT_TOWER_HOME = towerHome;
process.env.CLAUDE_HOME = tempDir('claude-home-');
// The "Claude Code" launched in these tests is node itself: it rejects --resume and exits at once.
process.env.AGENT_TOWER_CLAUDE_EXE = process.execPath;
process.env.AGENT_TOWER_CODEX_JS = join(__dirname, 'fixtures', 'fake-codex.mjs');
writeFileSync(join(towerHome, 'daemon.json'), JSON.stringify({ port: PORT, token: TOKEN }));

let sessions = 0;
/** Every SDK session started: its options, and how many prompts it has received. */
const sdkCalls: Array<{ options: Record<string, unknown>; prompts: number }> = [];
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    sessions += 1;
    const call = { options: params.options, prompts: 0 };
    sdkCalls.push(call);
    // Resuming without a fork keeps the session id, as the real SDK does.
    const resumed = typeof params.options.resume === 'string' && params.options.forkSession === false;
    const sessionId = resumed ? params.options.resume as string : `00000000-0000-0000-0000-${String(sessions).padStart(12, '0')}`;
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: sessionId };
      for await (const _message of params.prompt) {
        call.prompts += 1;
        yield { type: 'result', subtype: 'success' };
      }
    }
    const gen = run() as AsyncGenerator<unknown> & { interrupt: () => Promise<void> };
    gen.interrupt = async () => undefined;
    return gen;
  },
}));

type Tower = import('../daemon/tower.ts').Tower;
let tower: Tower;
let server: Server;
const launched: Array<{ ticketId: string; title: string }> = [];

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-tower-token': TOKEN }) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

async function until<T>(fn: () => T | undefined | false, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Claude Code only writes a transcript once a session has a conversation; --resume needs one. */
function writeTranscript(cwd: string, sessionId: string): void {
  const dir = join(process.env.CLAUDE_HOME!, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n');
}

const memberToken = (mcpConfigPath: string) =>
  (JSON.parse(readFileSync(mcpConfigPath, 'utf8')) as { mcpServers: { team: { env: Record<string, string> } } })
    .mcpServers.team.env.AGENT_TOWER_TEAM_TOKEN;

const ticket = (ticketId: string) => JSON.parse(readFileSync(join(ticketsDir, `${ticketId}.json`), 'utf8')) as {
  command: string; args: string[]; cwd: string; env: Record<string, string>;
};

beforeAll(async () => {
  const { Tower } = await import('../daemon/tower.ts');
  const { startServer } = await import('../daemon/api/server.ts');
  tower = new Tower(':memory:', { openLauncher: async (ticketId, title) => { launched.push({ ticketId, title }); } });
  server = await startServer({ tower, port: PORT, host: '127.0.0.1', token: TOKEN });
});

afterAll(async () => {
  server?.close();
  await tower?.shutdown();
});

describe('continuing an agent in the real CLI', () => {
  async function launchIdleAgent(prompt = 'hello') {
    const cwd = tempDir('project-');
    const { json } = await api('POST', '/api/managed', { vendor: 'claude', cwd, prompt, model: 'claude-haiku-4-5' });
    const id = json.agent.id as string;
    const agent = await until(() => tower.registry.get(id)?.status === 'idle' && tower.registry.get(id));
    return { id, cwd, agent };
  }

  it('hands an idle managed agent to Claude Code, and takes it back idle when the terminal closes', async () => {
    const { id, cwd, agent } = await launchIdleAgent();

    const res = await api('POST', `/api/agents/${encodeURIComponent(id)}/cli`);
    expect(res.status).toBe(200);
    // The agent stays listed while you use it in the terminal.
    expect(tower.registry.get(id)).toMatchObject({ inTerminal: true, sessionId: agent.sessionId });
    const { ticketId, title } = launched.at(-1)!;
    expect(title).toContain('Claude Code');
    expect(ticket(ticketId)).toMatchObject({
      command: process.execPath, cwd, args: ['--resume', agent.sessionId, '--model', 'claude-haiku-4-5'], env: {},
    });

    // Closing the terminal does not end it: Waystation resumes the same session and waits for instructions.
    const before = sdkCalls.length;
    expect((await api('POST', `/api/cli/${ticketId}/ended`)).status).toBe(200);
    const back = await until(() => sdkCalls.length > before && !tower.registry.get(id)?.inTerminal && tower.registry.get(id));
    expect(back).toMatchObject({ status: 'idle', sessionId: agent.sessionId, tier: 'A' });
    expect(sdkCalls.at(-1)!.options).toMatchObject({ resume: agent.sessionId, forkSession: false, model: 'claude-haiku-4-5' });
    await new Promise((r) => setTimeout(r, 200));
    expect(sdkCalls.at(-1)!.prompts).toBe(0);

    // It is still a normal Waystation agent.
    expect((await api('POST', `/api/agents/${encodeURIComponent(id)}/instruct`, { text: 'carry on' })).status).toBe(200);
    await until(() => sdkCalls.at(-1)!.prompts === 1);
  });

  it('Stop in Waystation closes the agent\'s terminal session and ends it for good', async () => {
    const { id } = await launchIdleAgent();
    expect((await api('POST', `/api/agents/${encodeURIComponent(id)}/cli`)).status).toBe(200);
    const { ticketId } = launched.at(-1)!;
    // A stand-in for the launcher running in the terminal tab (same command-line markers as the real one).
    const tab = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'launchCli.ts', ticketId], { stdio: 'ignore' });
    const tabExited = new Promise((resolve) => tab.on('exit', resolve));
    expect((await api('POST', `/api/cli/${ticketId}/started`, { pid: tab.pid })).status).toBe(200);

    const before = sdkCalls.length;
    expect((await api('POST', `/api/agents/${encodeURIComponent(id)}/stop`, { confirm: true })).status).toBe(200);
    await tabExited;
    expect(tower.registry.get(id)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    expect(sdkCalls.length).toBe(before);
  }, 30_000);

  it('opens your own running Claude Code session as a copy, leaving the original alone', async () => {
    const cwd = tempDir('own-session-');
    const sessionId = '11111111-2222-3333-4444-555555555555';
    writeTranscript(cwd, sessionId);
    tower.registry.upsert('test', makeAgent({ id: `claude:${sessionId}`, tier: 'B', sessionId, cwd, name: 'My session' }));
    const res = await api('POST', `/api/agents/claude%3A${sessionId}/cli`);
    expect(res.status).toBe(200);
    expect(res.json.message).toMatch(/copy/);
    const { ticketId, title } = launched.at(-1)!;
    expect(title).toBe('Claude Code · copy of My session');
    expect(ticket(ticketId)).toMatchObject({ command: process.execPath, cwd, args: ['--resume', sessionId, '--fork-session'], env: {} });
    expect(tower.registry.get(`claude:${sessionId}`)).toBeDefined();
  });

  it('opens a fresh Claude Code session in the folder when the session has no conversation yet', async () => {
    const cwd = tempDir('empty-session-');
    const sessionId = '99999999-2222-3333-4444-555555555555';
    tower.registry.upsert('test', makeAgent({ id: `claude:${sessionId}`, tier: 'B', sessionId, cwd, name: 'Empty' }));
    const res = await api('POST', `/api/agents/claude%3A${sessionId}/cli`);
    expect(res.status).toBe(200);
    expect(res.json.message).toMatch(/no conversation yet/);
    expect(ticket(launched.at(-1)!.ticketId)).toMatchObject({ cwd, args: [] });
  });

  it('opens an observed Codex thread as a fork in the Codex CLI', async () => {
    const cwd = tempDir('codex-thread-');
    const threadId = '0199aaaa-bbbb-cccc-dddd-eeeeffff0000';
    tower.registry.upsert('test', makeAgent({ id: `codex:${threadId}`, tier: 'C', vendor: 'codex', sessionId: threadId, cwd, canInstruct: false }));
    expect((await api('POST', `/api/agents/codex%3A${threadId}/cli`)).status).toBe(200);
    const spec = ticket(launched.at(-1)!.ticketId);
    expect(spec.args).toEqual([process.env.AGENT_TOWER_CODEX_JS, 'fork', threadId]);
  });

  it('explains why other agents cannot be opened in a CLI', async () => {
    tower.registry.upsert('test', makeAgent({ id: 'other:aider-1', tier: 'C', vendor: 'other', sessionId: undefined }));
    const res = await api('POST', '/api/agents/other%3Aaider-1/cli');
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/Claude Code and Codex/);
  });
});

describe('team sessions in the real CLI', () => {
  let teamId = '';
  let leadAgentId = '';

  it('hands a team member over with its team tools, and takes it back when the CLI closes', async () => {
    const created = await api('POST', '/api/teams', {
      name: 'CLI team', goal: 'Say hello', cwd: makeRepo(),
      members: [{ name: 'lead', role: 'lead', vendor: 'claude' }, { name: 'writer', role: 'worker', vendor: 'claude' }],
    });
    teamId = created.json.team.id;
    const lead = () => tower.teams.list().find((t) => t.id === teamId)!.members[0];
    leadAgentId = await until(() => lead().agentId);
    await until(() => tower.registry.get(leadAgentId)?.status === 'idle');

    expect((await api('POST', `/api/agents/${encodeURIComponent(leadAgentId)}/cli`)).status).toBe(200);
    expect(lead().terminal?.sessionId).toMatch(/^0000/);
    const { ticketId } = launched.at(-1)!;
    const spec = ticket(ticketId);
    expect(spec.cwd).toBe(lead().worktree);
    expect(spec.args.slice(0, 2)).toEqual(['--resume', lead().terminal!.sessionId]);
    // The team token lives in a private MCP config file next to the ticket, never on the command line.
    const mcpConfigPath = spec.args[spec.args.indexOf('--mcp-config') + 1];
    expect(mcpConfigPath).toBe(join(ticketsDir, `${ticketId}.mcp.json`));
    const token = memberToken(mcpConfigPath);
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(spec.args.join(' ')).not.toContain(token);
    expect(spec.env).toEqual({});
    expect(spec.args[spec.args.indexOf('--append-system-prompt') + 1]).toContain('opened your session in their terminal');

    // The handed-off session reaches the team channel with its own token.
    const tools = await api('POST', '/team/tools', {}, { 'x-team-token': token });
    expect(tools.json.tools.map((t: { name: string }) => t.name)).toContain('post_message');

    // Run the real launcher: it consumes the ticket, runs the "CLI", and reports back when it exits.
    const child = spawn(process.execPath, ['--import', 'tsx', join(PROJECT_ROOT, 'daemon', 'cli', 'launchCli.ts'), ticketId, '--home', towerHome], {
      cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).not.toBe(0);
    expect(existsSync(join(ticketsDir, `${ticketId}.json`))).toBe(false);
    await until(() => lead().terminal === undefined);
    expect(existsSync(mcpConfigPath)).toBe(false);
    expect((await api('POST', '/team/tools', {}, { 'x-team-token': token })).status).toBe(401);
  });

  it('a launcher the tower does not know refuses to start the CLI', async () => {
    const lead = () => tower.teams.list().find((t) => t.id === teamId)!.members[0];
    await api('POST', `/api/teams/${teamId}/resume`);
    const agentId = await until(() => lead().agentId);
    await until(() => tower.registry.get(agentId)?.status === 'idle');
    expect((await api('POST', `/api/agents/${encodeURIComponent(agentId)}/cli`)).status).toBe(200);
    const { ticketId } = launched.at(-1)!;
    // The tower forgets the session (as if it had restarted) before the launcher checks in.
    tower.cliSessions.discard(ticketId);
    writeFileSync(join(ticketsDir, `${ticketId}.json`), JSON.stringify({
      command: process.execPath, args: ['-e', 'require("fs").writeFileSync(process.argv[1], "ran")', join(ticketsDir, 'ran.txt')],
      cwd: PROJECT_ROOT, env: {}, handoffId: ticketId, expiresAt: Date.now() + 60_000,
    }));
    const child = spawn(process.execPath, ['--import', 'tsx', join(PROJECT_ROOT, 'daemon', 'cli', 'launchCli.ts'), ticketId, '--home', towerHome], {
      cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    expect(await new Promise<number | null>((resolve) => child.on('exit', resolve))).toBe(1);
    expect(stderr).toContain('did not confirm this session');
    expect(existsSync(join(ticketsDir, 'ran.txt'))).toBe(false);
    expect((await api('POST', `/api/teams/${teamId}/members/lead/return`)).status).toBe(200);
  }, 30_000);

  it('Take back returns a member whose terminal is still open', async () => {
    const lead = () => tower.teams.list().find((t) => t.id === teamId)!.members[0];
    // The mocked team went idle and paused itself; resuming relaunches the lead on its session.
    expect((await api('POST', `/api/teams/${teamId}/resume`)).status).toBe(200);
    const agentId = await until(() => lead().agentId);
    await until(() => tower.registry.get(agentId)?.status === 'idle');
    expect((await api('POST', `/api/agents/${encodeURIComponent(agentId)}/cli`)).status).toBe(200);
    expect(lead().terminal).toBeDefined();

    expect((await api('POST', `/api/teams/${teamId}/members/lead/return`)).status).toBe(200);
    expect(lead().terminal).toBeUndefined();
  });

  it('opens an operator Claude session with scoped team tools that end with the session', async () => {
    const res = await api('POST', `/api/teams/${teamId}/operator-cli`);
    expect(res.status).toBe(200);
    const { ticketId, title } = launched.at(-1)!;
    expect(title).toContain('operator');
    const spec = ticket(ticketId);
    expect(spec.args).not.toContain('--resume');
    expect(spec.cwd).toBe(tower.teams.list().find((t) => t.id === teamId)!.repoRoot);
    const token = memberToken(spec.args[spec.args.indexOf('--mcp-config') + 1]);

    const tools = await api('POST', '/team/tools', {}, { 'x-team-token': token });
    expect(tools.json.tools.map((t: { name: string }) => t.name)).toContain('team_status');
    const status = await api('POST', '/team/call', { name: 'team_status', arguments: {} }, { 'x-team-token': token });
    expect(status.json.text).toContain('Say hello');

    expect((await api('POST', `/api/cli/${ticketId}/ended`)).status).toBe(200);
    expect((await api('POST', '/team/tools', {}, { 'x-team-token': token })).status).toBe(401);
  });
});
