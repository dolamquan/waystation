// Pure helpers shared by the Claude Code hook script and its tests. Plain JS so the
// hook runs with bare `node` (no build step, no dependencies).
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Wording matters: models (rightly) ignore imperative text that looks injected into tool
// output. These messages state plainly where the text came from: the user's own hook.
export const INSTRUCTION_PREFIX =
  'Message from the user, sent through their Agent Control Tower hook (configured in their Claude Code settings):';
export const DENY_PREFIX =
  'The user reviewed this tool call in Agent Control Tower (their PreToolUse hook) and declined it. The user\'s feedback:';

/**
 * @param {{behavior: 'allow', updatedInput?: object} | {behavior: 'deny', message: string} | {behavior: 'ask'}} decision
 */
export function buildPreToolUseOutput(decision) {
  const base = { hookEventName: 'PreToolUse' };
  if (decision.behavior === 'allow') {
    return {
      hookSpecificOutput: {
        ...base,
        permissionDecision: 'allow',
        permissionDecisionReason: 'Approved in Agent Control Tower',
        ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
      },
    };
  }
  if (decision.behavior === 'deny') {
    return {
      hookSpecificOutput: {
        ...base,
        permissionDecision: 'deny',
        permissionDecisionReason: `${DENY_PREFIX} ${decision.message}`,
      },
    };
  }
  return {
    hookSpecificOutput: {
      ...base,
      permissionDecision: 'ask',
      permissionDecisionReason: 'Agent Control Tower could not get a decision, so the normal permission prompt applies',
    },
  };
}

/** @param {string[]} instructions */
export function formatInstructions(instructions) {
  return instructions.length === 1
    ? `${INSTRUCTION_PREFIX} ${instructions[0]}`
    : `${INSTRUCTION_PREFIX}\n${instructions.map((text, i) => `${i + 1}. ${text}`).join('\n')}`;
}

/** Stop hook: block the stop (i.e. keep working) only when there are queued instructions. */
export function buildStopOutput(instructions) {
  if (instructions.length === 0) return undefined;
  return { decision: 'block', reason: formatInstructions(instructions) };
}

/** PostToolUse / UserPromptSubmit: inject queued instructions as extra context. */
export function buildContextOutput(eventName, instructions) {
  if (instructions.length === 0) return undefined;
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: formatInstructions(instructions) } };
}

export const SAFE_ID = /^[A-Za-z0-9-]+$/;

/** One file per queued instruction, so writers never rewrite what a reader may be claiming. */
export function inboxDir(towerHome, sessionId) {
  return join(towerHome, 'inbox', sessionId);
}

export function interceptFlagPath(towerHome, sessionId) {
  return join(towerHome, 'intercept', sessionId);
}

export function isIntercepting(towerHome, sessionId) {
  return SAFE_ID.test(sessionId) && existsSync(interceptFlagPath(towerHome, sessionId));
}

/**
 * Claim queued instructions: each file is renamed (atomic) before reading, so two
 * concurrent hooks never deliver the same one. Call commit() only after the output
 * has been written, so a crash in between does not silently drop instructions.
 * @returns {{ instructions: string[], commit: () => void }}
 */
export function claimInbox(towerHome, sessionId) {
  const none = { instructions: [], commit: () => undefined };
  if (!SAFE_ID.test(sessionId)) return none;
  const dir = inboxDir(towerHome, sessionId);
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return none;
  }
  const claimed = [];
  const instructions = [];
  for (const name of names) {
    const from = join(dir, name);
    const to = `${from}.claimed-${process.pid}`;
    try {
      renameSync(from, to);
    } catch {
      continue;
    }
    claimed.push(to);
    try {
      const text = JSON.parse(readFileSync(to, 'utf8'));
      if (typeof text === 'string' && text.trim()) instructions.push(text);
    } catch {
      // corrupt entry: drop it
    }
  }
  const commit = () => {
    for (const path of claimed) {
      try { unlinkSync(path); } catch { /* already gone */ }
    }
  };
  return { instructions, commit };
}

/** Claim and immediately commit (tests / callers without an output step). */
export function takeInbox(towerHome, sessionId) {
  const { instructions, commit } = claimInbox(towerHome, sessionId);
  commit();
  return instructions;
}

export function readDaemonInfo(towerHome) {
  try {
    const info = JSON.parse(readFileSync(join(towerHome, 'daemon.json'), 'utf8'));
    return typeof info.port === 'number' && typeof info.token === 'string' ? info : undefined;
  } catch {
    return undefined;
  }
}
