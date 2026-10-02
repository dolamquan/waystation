import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { paths } from '../config.ts';
import { SAFE_ID, inboxDir, interceptFlagPath } from './hookLogic.mjs';

function assertSafe(sessionId: string): void {
  if (!SAFE_ID.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
}

/** File-based flags the hook script reads without talking to the daemon (keeps the hook fast path cheap). */
export class SessionFlags {
  constructor(private readonly towerHome: string = paths.towerHome) {}

  isIntercepting(sessionId: string): boolean {
    return SAFE_ID.test(sessionId) && existsSync(interceptFlagPath(this.towerHome, sessionId));
  }

  setIntercepting(sessionId: string, on: boolean): void {
    assertSafe(sessionId);
    const flag = interceptFlagPath(this.towerHome, sessionId);
    if (on) {
      mkdirSync(dirname(flag), { recursive: true });
      writeFileSync(flag, String(Date.now()));
    } else {
      rmSync(flag, { force: true });
    }
  }

  /** Session ids with Intercept on. */
  interceptedSessions(): string[] {
    try {
      return readdirSync(join(this.towerHome, 'intercept')).filter((name) => SAFE_ID.test(name));
    } catch {
      return [];
    }
  }

  queuedInstructions(sessionId: string): string[] {
    assertSafe(sessionId);
    const dir = inboxDir(this.towerHome, sessionId);
    try {
      return readdirSync(dir).filter((name) => name.endsWith('.json')).sort().flatMap((name) => {
        try {
          const text: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
          return typeof text === 'string' ? [text] : [];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  /** Each instruction is its own file: writers never touch files a hook may be claiming. */
  queueInstruction(sessionId: string, text: string): void {
    assertSafe(sessionId);
    const dir = inboxDir(this.towerHome, sessionId);
    mkdirSync(dir, { recursive: true });
    const name = `${String(Date.now()).padStart(15, '0')}-${randomBytes(4).toString('hex')}`;
    const tmp = join(dir, `${name}.tmp`);
    writeFileSync(tmp, JSON.stringify(text));
    renameSync(tmp, join(dir, `${name}.json`));
  }

  clearInbox(sessionId: string): void {
    assertSafe(sessionId);
    rmSync(inboxDir(this.towerHome, sessionId), { recursive: true, force: true });
  }

  /** Forget everything about a session (it ended). */
  forget(sessionId: string): void {
    if (!SAFE_ID.test(sessionId)) return;
    this.setIntercepting(sessionId, false);
    this.clearInbox(sessionId);
  }
}
