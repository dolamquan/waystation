import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CliHandoffs, takeTicket } from '../daemon/actions/cliHandoffs.ts';
import { tempDir } from './helpers.ts';

const SPEC = { command: 'C:\\bin\\claude.exe', args: ['--resume', 'abc'], cwd: 'C:\\work', env: { AGENT_TOWER_TEAM_TOKEN: 'secret' } };

function registry(opts: { alive?: Set<number> } = {}) {
  let now = 1_000;
  const dir = tempDir('tickets-');
  const handoffs = new CliHandoffs({
    ticketsDir: dir, now: () => now, isAlive: (pid) => opts.alive?.has(pid) ?? false, startTimeoutMs: 60_000,
  });
  return { handoffs, dir, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('tickets', () => {
  it('writes a one-time ticket that the launcher consumes', () => {
    const { handoffs, dir, now } = registry();
    const id = handoffs.create(SPEC, { label: 'lead' }, vi.fn());
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const file = join(dir, `${id}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ ...SPEC, handoffId: id });

    expect(takeTicket(dir, id, now())).toMatchObject(SPEC);
    expect(existsSync(file)).toBe(false);
    expect(() => takeTicket(dir, id, now())).toThrow(/already used|not found/);
  });

  it('refuses expired tickets and ids that are not plain hex', () => {
    const { handoffs, dir, now } = registry();
    const id = handoffs.create(SPEC, { label: 'lead' }, vi.fn());
    expect(() => takeTicket(dir, id, now() + 10 * 60_000)).toThrow(/expired/);
    expect(existsSync(join(dir, `${id}.json`))).toBe(false);
    expect(() => takeTicket(dir, '..\\daemon', now())).toThrow(/ticket/);
  });
});

describe('CliHandoffs', () => {
  it('ends a session once, when its launcher reports the CLI closed', () => {
    const { handoffs } = registry();
    const onEnd = vi.fn();
    const id = handoffs.create(SPEC, { label: 'lead' }, onEnd);
    handoffs.started(id, 4242);
    handoffs.ended(id);
    handoffs.ended(id);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('notices a closed terminal tab from the launcher process disappearing', () => {
    const alive = new Set([4242]);
    const { handoffs } = registry({ alive });
    const onEnd = vi.fn();
    handoffs.started(handoffs.create(SPEC, { label: 'lead' }, onEnd), 4242);
    handoffs.sweep();
    expect(onEnd).not.toHaveBeenCalled();
    alive.delete(4242);
    handoffs.sweep();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('keeps the session while the CLI runs, even if its launcher was killed', () => {
    const alive = new Set([100, 200]);
    const { handoffs } = registry({ alive });
    const onEnd = vi.fn();
    const id = handoffs.create(SPEC, { label: 'lead' }, onEnd);
    handoffs.started(id, 100);
    handoffs.started(id, 200);
    alive.delete(100);
    handoffs.sweep();
    expect(onEnd).not.toHaveBeenCalled();
    alive.delete(200);
    handoffs.sweep();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(handoffs.started(id, 300)).toBe(false);
  });

  it('writes private sidecar files next to the ticket and deletes them when the session ends', () => {
    const { handoffs, dir, now } = registry();
    const id = handoffs.create((sidecar) => ({ ...SPEC, args: ['--mcp-config', sidecar('mcp.json')] }), { label: 'lead' }, vi.fn(), { 'mcp.json': '{"token":"secret"}' });
    const sidecar = join(dir, `${id}.mcp.json`);
    expect(readFileSync(sidecar, 'utf8')).toBe('{"token":"secret"}');
    expect(takeTicket(dir, id, now()).args).toEqual(['--mcp-config', sidecar]);
    handoffs.ended(id);
    expect(existsSync(sidecar)).toBe(false);
  });

  it('gives up on a launcher that never started, and removes its ticket', () => {
    const { handoffs, dir, advance } = registry();
    const onEnd = vi.fn();
    const id = handoffs.create(SPEC, { label: 'lead' }, onEnd);
    advance(30_000);
    handoffs.sweep();
    expect(onEnd).not.toHaveBeenCalled();
    advance(31_000);
    handoffs.sweep();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, `${id}.json`))).toBe(false);
  });

  it('ends sessions by label, for Take back', () => {
    const { handoffs } = registry();
    const lead = vi.fn();
    const other = vi.fn();
    handoffs.create(SPEC, { label: 'team:abc/lead' }, lead);
    handoffs.create(SPEC, { label: 'team:abc/ui' }, other);
    handoffs.endLabel('team:abc/lead');
    expect(lead).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });
});
