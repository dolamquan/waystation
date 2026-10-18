import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TowerStore } from '../daemon/store/db.ts';
import type { AgentEvent } from '../daemon/domain/types.ts';
import { completionReview, recordedChecks, saveCompletionReview } from '../daemon/outputs/review.ts';
import { makeAgent, makeRepo } from './helpers.ts';

describe('completion review evidence', () => {
  it('correlates outcomes to checks and never treats assistant claims or missing exit codes as proof', () => {
    const event = (kind: AgentEvent['kind'], summary: string, tool?: AgentEvent['tool']): AgentEvent => ({ agentId: 'test', ts: 1, kind, summary, tool });
    expect(recordedChecks([
      event('assistant', 'All tests passed'),
      event('tool_call', 'Bash: npm test', { id: 'test-1', command: 'npm test' }),
      event('tool_result', 'done', { id: 'test-1', exitCode: 0, output: '24 passed' }),
      event('tool_result', 'done', { command: 'npm run build', exitCode: 1 }),
      event('tool_result', 'done', { command: 'python -m pytest', output: 'No outcome recorded' }),
    ]).map(check => check.outcome)).toEqual(['passed', 'failed', 'unknown']);
  });

  it('persists human verification and invalidates it on same-size file changes', async () => {
    const store = new TowerStore(':memory:');
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'app.txt'), 'first\n');
    const agent = makeAgent({ id: 'review-test', cwd, status: 'idle', pid: undefined, startedAt: Date.now() - 1000 });
    const events: AgentEvent[] = [
      { agentId: agent.id, ts: 1, kind: 'prompt', summary: 'Change the greeting' },
      { agentId: agent.id, ts: 2, kind: 'tool_call', summary: 'Edit: app.txt' },
      { agentId: agent.id, ts: 3, kind: 'tool_result', summary: 'done', tool: { command: 'npm test', exitCode: 0, output: 'Passed' } },
      { agentId: agent.id, ts: 4, kind: 'assistant', summary: 'Changed the greeting' },
      { agentId: agent.id, ts: 5, kind: 'status', summary: 'turn complete' },
    ];
    const deps = { agent: () => agent, events: () => events };
    const initial = await completionReview(deps, store, agent.id);
    expect(initial).toMatchObject({ agentFinished: true, status: 'needs-review', originalRequest: 'Change the greeting' });
    const decision = { fingerprint: initial.fingerprint, decision: 'verified', acceptance: 'Checked the new greeting and tests.', unresolved: '', checksReviewed: true };
    const saved = await saveCompletionReview(deps, store, agent.id, decision);
    expect(saved.status).toBe('verified');
    writeFileSync(join(cwd, 'app.txt'), 'other\n');
    const changed = await completionReview(deps, store, agent.id);
    expect(changed).toMatchObject({ stale: true, status: 'needs-review' });
    await expect(saveCompletionReview(deps, store, agent.id, decision)).rejects.toThrow(/files changed/);
    store.close();
  });

  it('blocks verification of unresolved issues, failed checks and incomplete turns but allows review notes', async () => {
    const store = new TowerStore(':memory:');
    const agent = makeAgent({ id: 'review-fail', cwd: makeRepo(), status: 'idle', pid: undefined });
    const events: AgentEvent[] = [
      { agentId: agent.id, ts: 1, kind: 'prompt', summary: 'Fix the test' },
      { agentId: agent.id, ts: 2, kind: 'tool_result', summary: 'failed', tool: { command: 'npm test', exitCode: 1 } },
      { agentId: agent.id, ts: 3, kind: 'status', summary: 'turn complete' },
    ];
    const deps = { agent: () => agent, events: () => events };
    let review = await completionReview(deps, store, agent.id);
    const body = { fingerprint: review.fingerprint, decision: 'verified', acceptance: 'Checked manually', checksReviewed: true, unresolved: 'Bug remains' };
    await expect(saveCompletionReview(deps, store, agent.id, body)).rejects.toThrow(/outstanding issues/);
    await expect(saveCompletionReview(deps, store, agent.id, { ...body, unresolved: '' })).rejects.toThrow(/still failing/);
    expect((await saveCompletionReview(deps, store, agent.id, { ...body, decision: 'reviewed' })).status).toBe('reviewed');
    events.pop();
    review = await completionReview(deps, store, agent.id);
    await expect(saveCompletionReview(deps, store, agent.id, { ...body, fingerprint: review.fingerprint, unresolved: '' })).rejects.toThrow(/not finished/);
    store.close();
  });
});
