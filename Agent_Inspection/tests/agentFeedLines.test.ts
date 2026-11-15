import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../web/src/api.ts';
import { MAX_FEED_LINES, MAX_LINE_CHARS, MAX_SUMMARY_CHARS, mergeFeedEvents, toFeedLines } from '../web/src/components/consoles/agentFeedLines.ts';

const ev = (kind: AgentEvent['kind'], summary: string, ts = 1, extra: Partial<AgentEvent> = {}): AgentEvent =>
  ({ agentId: 'a1', ts, kind, summary, ...extra });

describe('toFeedLines', () => {
  it('renders prompts with a > prefix and assistant text plain', () => {
    const lines = toFeedLines([ev('prompt', 'fix it', 1), ev('assistant', 'done', 2)]);
    expect(lines.map(l => [l.tone, l.text])).toEqual([['prompt', '> fix it'], ['assistant', 'done']]);
  });

  it('renders tool calls as $ Tool  detail and pending approvals as approval lines', () => {
    const [call, pending] = toFeedLines([ev('tool_call', 'Bash: npm test', 1), ev('tool_call', '⏸ Edit: a.ts', 2)]);
    expect(call).toMatchObject({ tone: 'tool', text: '$ Bash  npm test' });
    expect(pending).toMatchObject({ tone: 'approval' });
    expect(pending.text).toContain('awaiting approval');
  });

  it('marks failed tool results as errors and others as dim', () => {
    const [ok, bad, exit] = toFeedLines([
      ev('tool_result', 'ok', 1),
      ev('tool_result', 'boom', 2, { tool: { failed: true } }),
      ev('tool_result', 'x', 3, { tool: { exitCode: 2 } }),
    ]);
    expect(ok.tone).toBe('result');
    expect(bad.tone).toBe('error');
    expect(exit.tone).toBe('error');
  });

  it('renders status, system, stop and error kinds', () => {
    const tones = toFeedLines([ev('status', 'turn complete', 1), ev('system', 'hi', 2), ev('stop', 'bye', 3), ev('error', 'no', 4)]).map(l => l.tone);
    expect(tones).toEqual(['status', 'status', 'status', 'error']);
  });

  it('hides internal approval-review JSON', () => {
    const review = JSON.stringify({ risk_level: 'low', user_authorization: 'high', outcome: 'allow', rationale: 'x' });
    expect(toFeedLines([ev('assistant', review)])).toEqual([]);
  });

  it('never throws on unknown kinds, empty or missing summaries', () => {
    const odd = { agentId: 'a1', ts: 1, kind: 'weird', summary: undefined } as unknown as AgentEvent;
    const lines = toFeedLines([odd]);
    expect(lines).toHaveLength(1);
    expect(lines[0].tone).toBe('status');
  });

  it('caps long lines and multi-line text', () => {
    const [line] = toFeedLines([ev('assistant', 'x'.repeat(MAX_LINE_CHARS + 50))]);
    expect(line.text.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
    expect(line.text.endsWith('…')).toBe(true);
    const multi = toFeedLines([ev('assistant', 'a\nb\nc')]);
    expect(multi.map(l => l.text)).toEqual(['a', 'b', 'c']);
  });

  it('keeps only the newest lines', () => {
    const events = Array.from({ length: MAX_FEED_LINES + 25 }, (_, i) => ev('assistant', `m${i}`, i));
    const lines = toFeedLines(events);
    expect(lines).toHaveLength(MAX_FEED_LINES);
    expect(lines[lines.length - 1].text).toBe(`m${MAX_FEED_LINES + 24}`);
  });
});

describe('mergeFeedEvents', () => {
  it('dedupes by identity and sorts by time without mutating inputs', () => {
    const a = ev('prompt', 'one', 2);
    const b = ev('assistant', 'two', 1);
    const existing = [a];
    const merged = mergeFeedEvents(existing, [b, { ...a }]);
    expect(merged.map(e => e.summary)).toEqual(['two', 'one']);
    expect(existing).toHaveLength(1);
  });

  it('ignores events of other agents', () => {
    expect(mergeFeedEvents([], [ev('prompt', 'x')], 'other')).toEqual([]);
  });

  it('keeps distinct events that share a timestamp', () => {
    expect(mergeFeedEvents([], [ev('assistant', 'a', 5), ev('assistant', 'b', 5)])).toHaveLength(2);
  });
});

describe('summary sanitising', () => {
  it('clips a huge summary before splitting it into lines', () => {
    const huge = 'x\n'.repeat(MAX_SUMMARY_CHARS);
    const lines = toFeedLines([ev('assistant', huge)]);
    expect(lines.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS / 2 + 1);
    expect(lines.length).toBeLessThanOrEqual(MAX_FEED_LINES);
  });
  it('strips bidi control characters', () => {
    const [line] = toFeedLines([ev('assistant', 'a‮b⁦c⁩d')]);
    expect(line!.text).toBe('abcd');
  });
  it('strips them from tool calls too', () => {
    const [line] = toFeedLines([ev('tool_call', 'Bash: ls ‮gpj')]);
    expect(line!.text).not.toMatch(/[‪-‮]/);
  });
});
