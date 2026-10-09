import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Acquire before opening SQLite. Never remove another live process's lock. */
export function acquireInstance(file: string, alive = pidIsAlive): () => void {
  mkdirSync(dirname(file), { recursive: true });
  const contents = JSON.stringify({ pid: process.pid, id: randomUUID() });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor: number;
    try { descriptor = openSync(file, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let previous: string;
      let owner: { pid?: unknown };
      try { previous = readFileSync(file, 'utf8'); owner = JSON.parse(previous); }
      catch { throw new Error('Waystation is starting, or its daemon.lock is unreadable. Try again; see docs/desktop.md for recovery.'); }
      if (!owner || typeof owner !== 'object' || !Number.isInteger(owner.pid) || Number(owner.pid) <= 0 || alive(Number(owner.pid))) {
        throw new Error('Waystation is already running or starting. Open the existing station instead.');
      }
      // Verify it has not been replaced while we checked its owner.
      if (readFileSync(file, 'utf8') === previous) unlinkSync(file);
      continue;
    }
    try { writeFileSync(descriptor, contents); }
    finally { closeSync(descriptor); }
    return () => {
      try { if (readFileSync(file, 'utf8') === contents) unlinkSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    };
  }
  throw new Error('Another Waystation instance is starting. Try again.');
}
