import { randomBytes } from 'node:crypto';
import type { LibraryDeps } from '../library/deps.ts';
import { LibraryInputError, type NotificationEntry, type NotifyResult } from '../library/types.ts';
import type { CleanMessage } from './channels/types.ts';

const TABLE = 'notifications';
export const INBOX_KEEP = 500;
const DEFAULT_LIMIT = 50;
const MAX_IDS = 500;

/** The in-app Updates inbox: the newest INBOX_KEEP entries. */
export class Inbox {
  constructor(private readonly deps: LibraryDeps) {}

  add(message: CleanMessage): NotificationEntry {
    const entry: NotificationEntry = { id: `ntf_${randomBytes(4).toString('hex')}`, ...message, read: false, deliveries: [] };
    this.deps.store.saveRecord(TABLE, entry);
    this.deps.store.pruneRecords(TABLE, INBOX_KEEP);
    return entry;
  }

  setDeliveries(entry: NotificationEntry, deliveries: readonly NotifyResult[]): NotificationEntry {
    const current = this.all().find((candidate) => candidate.id === entry.id) ?? entry;
    const next = { ...current, deliveries };
    this.deps.store.saveRecord(TABLE, next);
    return next;
  }

  /** Newest first. */
  all(): NotificationEntry[] {
    return this.deps.store.loadRecords<NotificationEntry>(TABLE).reverse().sort((a, b) => b.ts - a.ts);
  }

  list(rawLimit: unknown): { notifications: NotificationEntry[]; unread: number } {
    const parsed = Number(rawLimit);
    const limit = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, INBOX_KEEP) : DEFAULT_LIMIT;
    const all = this.all();
    return { notifications: all.slice(0, limit), unread: all.filter((entry) => !entry.read).length };
  }

  latestTs(): number | undefined {
    return this.all()[0]?.ts;
  }

  markRead(raw: unknown): number {
    const body = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const all = body.all === true;
    const ids = body.ids;
    if (!all && !(Array.isArray(ids) && ids.length <= MAX_IDS && ids.every((id) => typeof id === 'string'))) {
      throw new LibraryInputError(`give "ids" (up to ${MAX_IDS}) or "all": true`);
    }
    const wanted = new Set(all ? [] : ids as string[]);
    const changed = this.all().filter((entry) => !entry.read && (all || wanted.has(entry.id)));
    changed.forEach((entry) => this.deps.store.saveRecord(TABLE, { ...entry, read: true }));
    return changed.length;
  }
}
