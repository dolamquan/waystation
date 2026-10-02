import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DENY_PREFIX, INSTRUCTION_PREFIX, buildContextOutput, buildPreToolUseOutput, buildStopOutput,
  claimInbox, inboxDir, isIntercepting, readDaemonInfo, takeInbox,
} from '../daemon/hooks/hookLogic.mjs';
import { SessionFlags } from '../daemon/hooks/sessionFlags.ts';
import { tempDir } from './helpers.ts';

const SESSION = '0862ffad-c0dd-4138-96b5-778c574d5945';

describe('PreToolUse output', () => {
  it('allows, optionally with edited input', () => {
    expect(buildPreToolUseOutput({ behavior: 'allow' }).hookSpecificOutput).toMatchObject({ permissionDecision: 'allow' });
    const edited = buildPreToolUseOutput({ behavior: 'allow', updatedInput: { command: 'ls' } }).hookSpecificOutput;
    expect(edited.updatedInput).toEqual({ command: 'ls' });
  });

  it('denies, attributing the feedback to the user\'s own hook', () => {
    const out = buildPreToolUseOutput({ behavior: 'deny', message: 'use pnpm instead' }).hookSpecificOutput;
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toBe(`${DENY_PREFIX} use pnpm instead`);
  });

  it('falls back to ask (never a silent allow)', () => {
    expect(buildPreToolUseOutput({ behavior: 'ask' }).hookSpecificOutput.permissionDecision).toBe('ask');
  });
});

describe('Stop and context outputs', () => {
  it('only blocks stopping when instructions are queued', () => {
    expect(buildStopOutput([])).toBeUndefined();
    expect(buildStopOutput(['run the tests'])).toEqual({ decision: 'block', reason: `${INSTRUCTION_PREFIX} run the tests` });
    expect(buildStopOutput(['a', 'b'])?.reason).toContain('1. a\n2. b');
  });

  it('injects additional context for PostToolUse/UserPromptSubmit', () => {
    expect(buildContextOutput('PostToolUse', [])).toBeUndefined();
    expect(buildContextOutput('PostToolUse', ['x'])?.hookSpecificOutput).toEqual({ hookEventName: 'PostToolUse', additionalContext: `${INSTRUCTION_PREFIX} x` });
  });
});

describe('session flags and inbox', () => {
  it('queues instructions in order and the hook consumes them exactly once', () => {
    const home = tempDir();
    const flags = new SessionFlags(home);
    flags.queueInstruction(SESSION, 'first');
    flags.queueInstruction(SESSION, 'second');
    expect(flags.queuedInstructions(SESSION)).toEqual(['first', 'second']);
    expect(takeInbox(home, SESSION)).toEqual(['first', 'second']);
    expect(takeInbox(home, SESSION)).toEqual([]);
    expect(readdirSync(inboxDir(home, SESSION))).toEqual([]);
  });

  it('keeps claimed instructions on disk until commit, and never hands them out twice', () => {
    const home = tempDir();
    const flags = new SessionFlags(home);
    flags.queueInstruction(SESSION, 'only once');
    const first = claimInbox(home, SESSION);
    expect(first.instructions).toEqual(['only once']);
    expect(claimInbox(home, SESSION).instructions).toEqual([]);
    expect(readdirSync(inboxDir(home, SESSION))).toHaveLength(1);
    // A new instruction queued while a claim is in flight is not lost or merged.
    flags.queueInstruction(SESSION, 'later');
    first.commit();
    expect(takeInbox(home, SESSION)).toEqual(['later']);
  });

  it('toggles and lists intercept flags, and forgets ended sessions', () => {
    const home = tempDir();
    const flags = new SessionFlags(home);
    expect(isIntercepting(home, SESSION)).toBe(false);
    expect(flags.interceptedSessions()).toEqual([]);
    flags.setIntercepting(SESSION, true);
    flags.queueInstruction(SESSION, 'pending');
    expect(isIntercepting(home, SESSION)).toBe(true);
    expect(flags.interceptedSessions()).toEqual([SESSION]);
    flags.forget(SESSION);
    flags.forget('../ignored');
    expect(flags.isIntercepting(SESSION)).toBe(false);
    expect(existsSync(inboxDir(home, SESSION))).toBe(false);
  });

  it('rejects path-traversal session ids', () => {
    const home = tempDir();
    expect(() => new SessionFlags(home).queueInstruction('../evil', 'x')).toThrow(/invalid session id/);
    expect(takeInbox(home, '../evil')).toEqual([]);
    expect(isIntercepting(home, '..\\evil')).toBe(false);
  });

  it('drops corrupt entries without failing', () => {
    const home = tempDir();
    mkdirSync(inboxDir(home, SESSION), { recursive: true });
    writeFileSync(join(inboxDir(home, SESSION), '000-a.json'), '{not json');
    writeFileSync(join(inboxDir(home, SESSION), '001-b.json'), JSON.stringify('valid'));
    expect(new SessionFlags(home).queuedInstructions(SESSION)).toEqual(['valid']);
    expect(takeInbox(home, SESSION)).toEqual(['valid']);
    new SessionFlags(home).clearInbox(SESSION);
  });

  it('reads daemon info only when well-formed', () => {
    const home = tempDir();
    expect(readDaemonInfo(home)).toBeUndefined();
    writeFileSync(join(home, 'daemon.json'), JSON.stringify({ port: 1, token: 't' }));
    expect(readDaemonInfo(home)).toEqual({ port: 1, token: 't' });
  });
});
