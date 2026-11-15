import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SESSION_ID, isConsoleKind, type SavedConsoleSpec } from './types.ts';

/** Saved consoles kept at once; a corrupt or hand-edited file cannot grow the board without bound. */
export const MAX_SAVED_CONSOLES = 50;
const MAX_FIELD_CHARS = 1000;

export interface ConsoleStore {
  /** Never throws: a missing or corrupt file simply means nothing was saved. */
  load(): SavedConsoleSpec[];
  /** Replaces the saved list. Failures are logged, not thrown, so a full disk cannot break the board. */
  save(specs: readonly SavedConsoleSpec[]): void;
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_CHARS;

/** Returns the spec when every field has the right shape, otherwise undefined. */
function parseSpec(raw: unknown): SavedConsoleSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Record<string, unknown>;
  if (!text(item.id) || !text(item.name) || !text(item.cwd) || !isConsoleKind(item.kind)) return undefined;
  if (typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)) return undefined;
  // A hand-edited or corrupt id is dropped rather than rejecting the console: it then restores as a fresh session.
  const sessionId = typeof item.sessionId === 'string' && SESSION_ID.test(item.sessionId) ? item.sessionId : undefined;
  return { id: item.id, name: item.name, kind: item.kind, cwd: item.cwd, createdAt: item.createdAt, ...(sessionId ? { sessionId } : {}) };
}

export function createConsoleStore(file: string): ConsoleStore {
  return {
    load() {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return [];
      }
      const list = parsed && typeof parsed === 'object' ? (parsed as { consoles?: unknown }).consoles : undefined;
      if (!Array.isArray(list)) return [];
      const seen = new Set<string>();
      const specs: SavedConsoleSpec[] = [];
      for (const raw of list) {
        const spec = parseSpec(raw);
        if (!spec || seen.has(spec.id)) continue;
        seen.add(spec.id);
        specs.push(spec);
        if (specs.length >= MAX_SAVED_CONSOLES) break;
      }
      return specs;
    },
    save(specs) {
      const temp = `${file}.tmp`;
      const consoles = specs.slice(0, MAX_SAVED_CONSOLES)
        .map(({ id, name, kind, cwd, createdAt, sessionId }) => ({ id, name, kind, cwd, createdAt, ...(sessionId ? { sessionId } : {}) }));
      try {
        mkdirSync(dirname(file), { recursive: true });
        // Write beside the target, then rename, so a crash never leaves half a file.
        writeFileSync(temp, JSON.stringify({ consoles }), 'utf8');
        renameSync(temp, file);
      } catch (error) {
        rmSync(temp, { force: true });
        console.error('Could not save the console list:', (error as Error).message);
      }
    },
  };
}
