import { randomBytes } from 'node:crypto';
import type { LibraryDeps } from '../library/deps.ts';
import { INBOX_CHANNEL_ID, LibraryInputError, type NotifyChannelView } from '../library/types.ts';
import { CHANNEL_SPECS } from './channels/index.ts';
import {
  parseChannelCreate, parseChannelUpdate, validateChannel, type ChannelChange, type ChannelRecord,
} from './validate.ts';

const TABLE = 'notify_channels';
const secretPrefix = (id: string): string => `notify:${id}:`;

/** Channel records in the store, their secrets in the SecretStore. */
export class ChannelStore {
  constructor(private readonly deps: LibraryDeps) {}

  records(): ChannelRecord[] {
    return this.deps.store.loadRecords<ChannelRecord>(TABLE)
      .filter((record) => Object.hasOwn(CHANNEL_SPECS, record.kind))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  find(id: string): ChannelRecord | undefined {
    return this.records().find((record) => record.id === id);
  }

  require(id: string): ChannelRecord {
    const record = this.find(id);
    if (!record) throw new LibraryInputError(`unknown notification channel: ${id}`);
    return record;
  }

  secretsOf(id: string): Record<string, string> {
    const prefix = secretPrefix(id);
    return Object.fromEntries(this.deps.secrets.namesUnder(prefix).map((name) => [name, this.deps.secrets.get(`${prefix}${name}`) ?? '']));
  }

  view(record: ChannelRecord): NotifyChannelView {
    return { ...record, secretNames: this.deps.secrets.namesUnder(secretPrefix(record.id)) };
  }

  create(raw: unknown, now: number): NotifyChannelView {
    const change = parseChannelCreate(raw);
    const config = change.config ?? {};
    validateChannel(change.kind, config, this.mergedSecrets({}, change));
    const record: ChannelRecord = {
      id: `nch_${randomBytes(4).toString('hex')}`,
      kind: change.kind,
      label: change.label,
      config,
      enabled: change.enabled ?? true,
      createdAt: now,
    };
    this.deps.store.saveRecord(TABLE, record);
    this.writeSecrets(record.id, change.secrets);
    return this.view(record);
  }

  update(id: string, raw: unknown): NotifyChannelView {
    if (id === INBOX_CHANNEL_ID) throw new LibraryInputError('the Updates inbox cannot be changed');
    const current = this.require(id);
    const change = parseChannelUpdate(raw, current.kind);
    const config = change.config ?? current.config;
    validateChannel(current.kind, config, this.mergedSecrets(this.secretsOf(id), change));
    const next: ChannelRecord = {
      ...current,
      label: change.label ?? current.label,
      config,
      enabled: change.enabled ?? current.enabled,
      // New settings deserve a clean slate.
      lastError: change.config || Object.keys(change.secrets).length > 0 ? undefined : current.lastError,
    };
    this.deps.store.saveRecord(TABLE, next);
    this.writeSecrets(id, change.secrets);
    return this.view(next);
  }

  remove(id: string): ChannelRecord {
    if (id === INBOX_CHANNEL_ID) throw new LibraryInputError('the Updates inbox cannot be deleted');
    const current = this.require(id);
    this.deps.store.deleteRecord(TABLE, id);
    this.deps.secrets.deleteUnder(secretPrefix(id));
    return current;
  }

  /** Records the outcome of a delivery, if the channel still exists. */
  noteDelivery(id: string, ok: boolean, error: string | undefined, now: number): void {
    const current = this.find(id);
    if (!current) return;
    this.deps.store.saveRecord(TABLE, ok ? { ...current, lastSentAt: now, lastError: undefined } : { ...current, lastError: error });
  }

  private mergedSecrets(stored: Readonly<Record<string, string>>, change: ChannelChange): Record<string, string | undefined> {
    const merged = { ...stored, ...change.secrets };
    return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== ''));
  }

  private writeSecrets(id: string, secrets: Readonly<Record<string, string>>): void {
    Object.entries(secrets).forEach(([name, value]) => {
      const key = `${secretPrefix(id)}${name}`;
      if (value === '') this.deps.secrets.delete(key);
      else this.deps.secrets.set(key, value);
    });
  }
}
