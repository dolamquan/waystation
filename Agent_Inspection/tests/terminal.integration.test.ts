import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TerminalTarget } from '../daemon/actions/terminal.ts';
import { makeAgent, makeRepo, tempDir } from './helpers.ts';

const PORT = 47_320;
const TOKEN = 'terminal-token-0123456789';
const PROJECT_ROOT = join(__dirname, '..');
const ATTACH_SCRIPT = join(PROJECT_ROOT, 'daemon', 'cli', 'attach.ts');
const towerHome = join(tempDir('tower-'), 'agent-tower');
mkdirSync(towerHome, { recursive: true });
process.env.AGENT_TOWER_HOME = towerHome;
process.env.CLAUDE_HOME = tempDir('claude-home-');
writeFileSync(join(towerHome, 'daemon.json'), JSON.stringify({ port: PORT, token: TOKEN }));

// Team members stay mid-turn, so the idle check never pauses the team while the console drives it.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: AsyncIterable<unknown> }) => {
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-team' };
      for await (const _message of params.prompt) { /* never finishes a turn */ }
    }
    const gen = run() as AsyncGenerator<unknown> & { interrupt: () => Promise<void> };
    gen.interrupt = async () => undefined;
    return gen;
  },
}));

type Tower = import('../daemon/tower.ts').Tower;
let tower: Tower;
let server: Server;
const opened: TerminalTarget[] = [];
let launchError: Error | undefined;

const AGENT_ID = 'claude:aaaaaaaa-0000-0000-0000-000000000001';

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-tower-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

/** Runs the real attach console against the test daemon and lets the test type into it. */
function startConsole(...args: string[]) {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', ATTACH_SCRIPT, ...args, '--home', towerHome], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const waitFor = async (text: string, ms = 15_000) => {
    const start = Date.now();
    while (!output.includes(text)) {
      if (Date.now() - start > ms) throw new Error(`timed out waiting for "${text}". Output so far:\n${output}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { type: (line: string) => child.stdin!.write(`${line}\n`), waitFor, exited, output: () => output, child };
}

beforeAll(async () => {
  const { Tower } = await import('../daemon/tower.ts');
  const { startServer } = await import('../daemon/api/server.ts');
  tower = new Tower(':memory:', {
    openTerminal: async (target) => {
      if (launchError) throw launchError;
      opened.push(target);
    },
  });
  server = await startServer({ tower, port: PORT, host: '127.0.0.1', token: TOKEN });
  tower.registry.upsert('test', makeAgent({ id: AGENT_ID, name: 'Console agent', status: 'idle' }));
});

afterAll(async () => {
  server?.close();
  await tower?.shutdown();
});

describe('POST /api/terminal', () => {
  it('opens a console for a known agent and audits it', async () => {
    const res = await api('POST', '/api/terminal', { kind: 'agent', id: AGENT_ID });
    expect(res.status).toBe(200);
    expect(res.json.command).toBe(`npm run attach -- agent ${AGENT_ID}`);
    expect(opened.at(-1)).toEqual({ kind: 'agent', id: AGENT_ID, title: 'Waystation · Console agent' });
    expect(tower.store.auditLog().some((entry) => entry.action === 'open_terminal')).toBe(true);
  });

  it('rejects unknown kinds and targets', async () => {
    expect((await api('POST', '/api/terminal', { kind: 'robot', id: AGENT_ID })).status).toBe(400);
    expect((await api('POST', '/api/terminal', { kind: 'agent', id: 'claude:missing' })).json.error).toMatch(/not found/i);
    expect((await api('POST', '/api/terminal', { kind: 'team', id: 'nope' })).json.error).toMatch(/not found/i);
  });

  it('falls back to the manual command when Windows Terminal cannot start', async () => {
    launchError = new Error('spawn wt.exe ENOENT');
    try {
      const res = await api('POST', '/api/terminal', { kind: 'agent', id: AGENT_ID });
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('ENOENT');
      expect(res.json.error).toContain(`npm run attach -- agent ${AGENT_ID}`);
    } finally {
      launchError = undefined;
    }
  });

  it('requires the operator token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/terminal`, { method: 'POST', body: JSON.stringify({ kind: 'agent', id: AGENT_ID }) });
    expect(res.status).toBe(401);
  });
});

describe('attach console', () => {
  it('streams an agent live and answers its held tool call', async () => {
    tower.registry.pushEvent({ agentId: AGENT_ID, ts: Date.now(), kind: 'assistant', summary: 'earlier work' });
    const term = startConsole('agent', 'console agent');
    try {
      await term.waitFor('Console agent');
      await term.waitFor('earlier work');

      tower.registry.pushEvent({ agentId: AGENT_ID, ts: Date.now(), kind: 'tool_call', summary: 'Bash: npm test' });
      await term.waitFor('⚙ Bash: npm test');

      term.type('/approve');
      await term.waitFor('Nothing is waiting');

      const { decision } = tower.interceptions.request(
        { agentId: AGENT_ID, sessionId: 's', toolName: 'Bash', input: { command: 'rm -rf build' }, origin: 'hook' }, 60_000,
      );
      await term.waitFor('Bash: rm -rf build');
      term.type('/deny keep the build folder');
      await expect(decision).resolves.toEqual({ behavior: 'deny', message: 'keep the build folder' });

      // Hooks are not installed in this test home, so the daemon's explanation is shown instead of a crash.
      term.type('please continue');
      await term.waitFor('Install the tower hooks first');

      term.type('/quit');
      expect(await term.exited).toBe(0);
    } finally {
      term.child.kill();
    }
  });

  it('runs a team session from the terminal', async () => {
    const created = await api('POST', '/api/teams', {
      name: 'Console team',
      goal: 'Say hello',
      cwd: makeRepo(),
      members: [{ name: 'lead', role: 'lead', vendor: 'claude' }, { name: 'writer', role: 'worker', vendor: 'claude' }],
    });
    expect(created.status).toBe(200);
    const teamId = created.json.team.id as string;
    const term = startConsole('team', teamId);
    try {
      await term.waitFor('Console team');
      await term.waitFor('Team goal: Say hello');

      term.type('@writer draft the greeting');
      await term.waitFor('operator → writer: draft the greeting');

      term.type('/tasks');
      await term.waitFor('No tasks yet');

      term.type('/members');
      await term.waitFor('team/console-team');

      term.type('/pause');
      await term.waitFor('Paused by the operator');

      term.type('/attach writer');
      await term.waitFor('Opened');
      expect(opened.at(-1)?.kind).toBe('agent');

      term.type('/quit');
      expect(await term.exited).toBe(0);
    } finally {
      term.child.kill();
    }
  });

  it('explains when the tower is not running', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', ATTACH_SCRIPT, 'agent', 'x', '--home', tempDir('no-tower-')], {
      cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(1);
    expect(output).toContain('not running');
  });
});
