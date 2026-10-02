import { describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../daemon/domain/registry.ts';
import { InterceptionManager } from '../daemon/hooks/interceptions.ts';
import { AsyncQueue } from '../daemon/managed/asyncQueue.ts';
import { contentSecurityPolicy, isAllowedHost, isAllowedOrigin, tokenFromProtocols, tokensMatch } from '../daemon/api/security.ts';
import { parseSkillFrontmatter, listSkills, attachSkillToProject, skillInstruction } from '../daemon/actions/skills.ts';
import { TowerStore } from '../daemon/store/db.ts';
import { validateLaunch } from '../daemon/managed/managedAgents.ts';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeAgent, tempDir } from './helpers.ts';

describe('AgentRegistry', () => {
  it('prefers higher-control tiers for the same agent and drops vanished ones', () => {
    const registry = new AgentRegistry();
    registry.replaceSource('observed', [makeAgent({ tier: 'C', name: 'observed' })]);
    registry.replaceSource('hooked', [makeAgent({ tier: 'B', name: 'hooked' })]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].name).toBe('hooked');
    registry.replaceSource('hooked', []);
    expect(registry.list()[0].name).toBe('observed');
    registry.drop('observed', makeAgent().id);
    expect(registry.list()).toEqual([]);
  });

  it('applies and clears overrides key by key', () => {
    const registry = new AgentRegistry();
    registry.upsert('s', makeAgent({ status: 'busy' }));
    registry.setOverride(makeAgent().id, { status: 'waiting', name: 'x' });
    expect(registry.get(makeAgent().id)).toMatchObject({ status: 'waiting', name: 'x' });
    registry.setOverride(makeAgent().id, { status: undefined });
    expect(registry.get(makeAgent().id)).toMatchObject({ status: 'busy', name: 'x' });
  });

  it('only emits when a source actually changes, and dedupes repeated events', () => {
    const registry = new AgentRegistry();
    const onAgents = vi.fn();
    const onEvent = vi.fn();
    registry.on('agents', onAgents);
    registry.on('event', onEvent);
    registry.replaceSource('s', [makeAgent()]);
    registry.replaceSource('s', [makeAgent()]);
    expect(onAgents).toHaveBeenCalledTimes(1);
    const event = { agentId: 'a', ts: 1000, kind: 'tool_call' as const, summary: 'Bash: ls' };
    registry.pushEvent(event);
    registry.pushEvent({ ...event, ts: 1500 });
    registry.pushEvent({ ...event, ts: 9000 });
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(registry.recentEvents('a')).toHaveLength(2);
    expect(registry.findBySessionId(makeAgent().sessionId!)?.id).toBe(makeAgent().id);
  });
});

describe('InterceptionManager', () => {
  it('resolves with the human decision', async () => {
    const manager = new InterceptionManager();
    const { id, decision } = manager.request({ agentId: 'a', sessionId: 's', toolName: 'Bash', input: {}, origin: 'hook' }, 10_000);
    expect(manager.forAgent('a')).toHaveLength(1);
    expect(manager.decide(id, { behavior: 'deny', message: 'no' })).toBe(true);
    await expect(decision).resolves.toEqual({ behavior: 'deny', message: 'no' });
    expect(manager.list()).toEqual([]);
    expect(manager.decide(id, { behavior: 'allow' })).toBe(false);
  });

  it('falls back to ask on timeout or cancel', async () => {
    const manager = new InterceptionManager();
    const timed = manager.request({ agentId: 'a', sessionId: 's', toolName: 'T', input: {}, origin: 'hook' }, 10);
    await expect(timed.decision).resolves.toEqual({ behavior: 'ask' });
    const cancelled = manager.request({ agentId: 'a', sessionId: 's', toolName: 'T', input: {}, origin: 'hook' }, 10_000);
    manager.cancel(cancelled.id);
    await expect(cancelled.decision).resolves.toEqual({ behavior: 'ask' });
  });
});

describe('AsyncQueue', () => {
  it('delivers pushed items in order and ends on close', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    const seen: number[] = [];
    const reader = (async () => { for await (const n of queue) seen.push(n); })();
    queue.push(2);
    await new Promise((r) => setTimeout(r, 5));
    queue.close();
    await reader;
    expect(seen).toEqual([1, 2]);
    expect(() => queue.push(3)).toThrow(/closed/);
  });
});

describe('request security', () => {
  it('accepts only loopback hosts on our port', () => {
    expect(isAllowedHost('127.0.0.1:4317', 4317)).toBe(true);
    expect(isAllowedHost('localhost:4317', 4317)).toBe(true);
    expect(isAllowedHost('evil.com:4317', 4317)).toBe(false);
    expect(isAllowedHost(undefined, 4317)).toBe(false);
  });

  it('accepts no-origin and our own origins only', () => {
    expect(isAllowedOrigin(undefined, 4317)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4317', 4317)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', 4317)).toBe(false);
    expect(isAllowedOrigin('http://localhost:5173', 4317, true)).toBe(true);
    expect(isAllowedOrigin('https://evil.com', 4317)).toBe(false);
    expect(isAllowedOrigin('null', 4317)).toBe(false);
  });

  it('reads the WebSocket token from the subprotocol list and builds a strict CSP', () => {
    expect(tokenFromProtocols('agent-tower, abc123')).toBe('abc123');
    expect(tokenFromProtocols(['agent-tower', 'abc123'])).toBe('abc123');
    expect(tokenFromProtocols('other, abc123')).toBeUndefined();
    expect(tokenFromProtocols(undefined)).toBeUndefined();
    const csp = contentSecurityPolicy(4317);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
  });

  it('compares tokens safely', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abd', 'abc')).toBe(false);
    expect(tokensMatch('ab', 'abc')).toBe(false);
    expect(tokensMatch(undefined, 'abc')).toBe(false);
  });
});

describe('skills', () => {
  it('parses frontmatter', () => {
    expect(parseSkillFrontmatter('---\nname: "my-skill"\ndescription: Does things\n---\nbody')).toEqual({ name: 'my-skill', description: 'Does things' });
    expect(parseSkillFrontmatter('no frontmatter')).toEqual({});
  });

  it('lists skills from a root and attaches one to a project exactly once', () => {
    const root = tempDir();
    const skillDir = join(root, 'skills', 'tidy-up');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: tidy-up\ndescription: Keep things tidy\n---\n');
    const skills = listSkills([join(root, 'skills')]);
    const skill = skills.find((s) => s.name === 'tidy-up');
    expect(skill).toBeDefined();
    const project = tempDir();
    const target = attachSkillToProject(skill!, project);
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
    expect(() => attachSkillToProject(skill!, project)).toThrow(/already present/);
    expect(() => attachSkillToProject(skill!, join(project, 'missing'))).toThrow(/not found/);
    expect(skillInstruction(skill!, target)).toContain('tidy-up');
  });
});

describe('TowerStore', () => {
  it('records redacted events, audits, and prunes', () => {
    const store = new TowerStore(':memory:');
    store.recordEvent({ agentId: 'a', ts: 100, kind: 'prompt', summary: 'token=abcdefghijk' });
    store.recordEvent({ agentId: 'a', ts: 200, kind: 'assistant', summary: 'ok' });
    expect(store.eventsFor('a').map((e) => e.ts)).toEqual([100, 200]);
    expect(store.eventsFor('a')[0].summary).toContain('[REDACTED]');
    store.audit('stop', 'a', { pid: 1 });
    expect(store.auditLog()[0]).toMatchObject({ action: 'stop', target: 'a' });
    store.pruneOlderThan(150);
    expect(store.eventsFor('a')).toHaveLength(1);
    store.close();
  });
});

describe('validateLaunch', () => {
  it('requires vendor, an existing absolute folder and a prompt', () => {
    const dir = tempDir();
    expect(validateLaunch({ vendor: 'claude', cwd: dir, prompt: 'hi' })).toMatchObject({ vendor: 'claude', cwd: dir, fork: true, intercept: false });
    expect(() => validateLaunch({ vendor: 'gpt', cwd: dir, prompt: 'x' })).toThrow(/vendor/);
    expect(() => validateLaunch({ vendor: 'claude', cwd: 'relative', prompt: 'x' })).toThrow(/absolute/);
    expect(() => validateLaunch({ vendor: 'claude', cwd: join(dir, 'nope'), prompt: 'x' })).toThrow(/not found/);
    expect(() => validateLaunch({ vendor: 'codex', cwd: dir, prompt: ' ' })).toThrow(/prompt/);
  });
});
