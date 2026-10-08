import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { MANAGED_ENV_FLAG } from '../config.ts';
import { AsyncQueue } from '../managed/asyncQueue.ts';
import { claudeUsageLimits, type ClaudePlanReading } from './planLimits.ts';

const READ_TIMEOUT_MS = 10_000;

/** Read the CLI's structured /usage data without a user prompt or model turn. */
export async function readClaudePlanUsage(): Promise<ClaudePlanReading | undefined> {
  const input = new AsyncQueue<SDKUserMessage>();
  let session: Query | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    session = query({
      prompt: input,
      options: {
        tools: [],
        settingSources: [],
        persistSession: false,
        env: { ...process.env, [MANAGED_ENV_FLAG]: '1' },
      },
    });
    // Experimental in the installed SDK; older CLIs may not implement this control request.
    if (typeof session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') return undefined;
    const result = await Promise.race([
      session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Usage read timed out')), READ_TIMEOUT_MS); }),
    ]);
    return claudeUsageLimits(result, Date.now());
  } catch {
    // Missing login, offline, or an older CLI: keep local usage and any existing vendor readings.
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
    input.close();
    session?.close();
  }
}
