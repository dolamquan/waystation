import { describe, expect, it } from 'vitest';
import { Breaker, DEFAULT_BREAKER } from '../daemon/guard/breaker.ts';
import type { AgentEvent } from '../daemon/domain/types.ts';

const ev = (kind: AgentEvent['kind'], summary: string, ts = 1000): AgentEvent => ({ agentId: 'a', ts, kind, summary });

function loop(breaker: Breaker, times: number, ts = 1000) {
  let trip;
  for (let i = 0; i < times; i++) trip = breaker.observe(ev('tool_call', 'Bash: npm test', ts + i)) ?? trip;
  return trip;
}

describe('Breaker', () => {
  it('warns on a loop of identical tool calls, then constrains on the next one, and caps there', () => {
    const breaker = new Breaker({ ...DEFAULT_BREAKER, repeatLimit: 3 });
    expect(loop(breaker, 2)).toBeUndefined();
    expect(breaker.observe(ev('tool_call', 'Bash: npm test'))).toMatchObject({ level: 'warned' });
    expect(breaker.state('a')?.reason).toMatch(/3 times/);
    // Fresh evidence is needed for the next rung.
    expect(loop(breaker, 2)).toBeUndefined();
    expect(loop(breaker, 1)).toMatchObject({ level: 'constrained' });
    // hardStop is off: no stop, but the newest reason is kept.
    expect(loop(breaker, 3)).toBeUndefined();
    expect(breaker.state('a')?.level).toBe('constrained');
  });

  it('does not count calls broken up by a different call or a prompt', () => {
    const breaker = new Breaker({ ...DEFAULT_BREAKER, repeatLimit: 3 });
    breaker.observe(ev('tool_call', 'Bash: npm test'));
    breaker.observe(ev('tool_call', 'Bash: npm test'));
    breaker.observe(ev('tool_call', 'Edit: a.ts'));
    breaker.observe(ev('tool_call', 'Bash: npm test'));
    breaker.observe(ev('prompt', 'try again'));
    expect(breaker.observe(ev('tool_call', 'Bash: npm test'))).toBeUndefined();
  });

  it('trips on an error storm inside the window only', () => {
    const breaker = new Breaker({ ...DEFAULT_BREAKER, errorLimit: 3, errorWindowMs: 1000 });
    breaker.observe(ev('error', 'x', 0));
    breaker.observe(ev('error', 'x', 1500));
    expect(breaker.observe(ev('error', 'x', 2000))).toBeUndefined();
    expect(breaker.observe(ev('error', 'x', 2100))).toMatchObject({ level: 'warned', reason: '3 errors within 0 minutes' });
  });

  it('goes straight to constrained once over budget, once, and stops only with hardStop', () => {
    const breaker = new Breaker({ ...DEFAULT_BREAKER, costLimitUsd: 5, hardStop: true, repeatLimit: 2 });
    expect(breaker.observeCost('a', 4.99)).toBeUndefined();
    expect(breaker.observeCost('a', 5.5)).toMatchObject({ level: 'constrained' });
    expect(breaker.observeCost('a', 9)).toBeUndefined();
    expect(loop(breaker, 2)).toMatchObject({ level: 'stopped' });
  });

  it('keeps an over-budget agent acknowledged after Clear guard', () => {
    const breaker = new Breaker({ ...DEFAULT_BREAKER, costLimitUsd: 5 });
    expect(breaker.observeCost('a', 6)).toMatchObject({ level: 'constrained' });
    breaker.reset('a');
    expect(breaker.state('a')).toBeUndefined();
    expect(breaker.observeCost('a', 7)).toBeUndefined();
  });

  it('records the budget reason on an agent already at the top rung, without acting again', () => {
    const breaker = new Breaker({ ...DEFAULT_BREAKER, costLimitUsd: 5, repeatLimit: 1 });
    loop(breaker, 1);
    loop(breaker, 1);
    expect(breaker.state('a')?.level).toBe('constrained');
    expect(breaker.observeCost('a', 6)).toBeUndefined();
    expect(breaker.state('a')?.reason).toMatch(/per-agent limit/);
  });

  it('clears a quiet warning on tick, and reset clears everything', () => {
    const breaker = new Breaker({ ...DEFAULT_BREAKER, repeatLimit: 2, calmMs: 100 });
    loop(breaker, 2, 1000);
    expect(breaker.tick(1050)).toEqual([]);
    expect(breaker.tick(1200)).toEqual(['a']);
    expect(breaker.state('a')).toBeUndefined();
    loop(breaker, 2);
    breaker.reset('a');
    expect(breaker.state('a')).toBeUndefined();
  });
});
