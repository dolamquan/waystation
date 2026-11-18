import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeSecrets, encodeSecrets, secretEncryptionKey } from './secretCipher.ts';

const SAFE_KEY = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * Secret values (MCP tokens, webhook URLs, SMTP passwords) in one local JSON file outside OneDrive.
 * Keys are namespaced by owner, e.g. "mcp:<id>:GITHUB_TOKEN" or "notify:<id>:webhookUrl".
 * Values never leave the daemon through the API; only key names do.
 */
export class SecretStore {
  private values: Readonly<Record<string, string>>;
  private degradedReason: string | undefined;

  constructor(private readonly filePath: string, private readonly encryptionKey = filePath === ':memory:' ? undefined : secretEncryptionKey()) {
    this.values = this.load();
  }

  get(key: string): string | undefined {
    let prefix = ''; const seen = new Set<string>();
    while (this.values[`ref:${key}`]) { if (seen.has(key) || seen.size >= 20) return undefined; seen.add(key); prefix += this.values[`refprefix:${key}`] ?? ''; key = this.values[`ref:${key}`]; }
    return !Object.hasOwn(this.values, key) ? undefined : prefix + this.values[key];
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Keys starting with `prefix`, with the prefix removed. */
  namesUnder(prefix: string): string[] {
    return [...new Set(Object.keys(this.values).filter(key => !key.startsWith('refprefix:')).map(key => key.startsWith('ref:') ? key.slice(4) : key))].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)).sort();
  }
  reference(key: string): string | undefined { return this.values[`ref:${key}`]; }
  referencePrefix(key: string): string { return this.values[`refprefix:${key}`] ?? ''; }
  referencesTo(source: string): string[] { return Object.keys(this.values).filter(key => key.startsWith('ref:') && this.values[key] === source).map(key => key.slice(4)); }
  alias(key: string, source: string, prefix = ''): void {
    if (!SAFE_KEY.test(key) || !SAFE_KEY.test(source) || !['', 'Bearer '].includes(prefix)) throw new Error('Invalid secret reference.');
    if (key === source) return;
    const seen = new Set([key]); let cursor: string | undefined = source;
    while (cursor) { if (seen.has(cursor)) throw new Error('Secret references cannot form a cycle.'); seen.add(cursor); cursor = this.reference(cursor); }
    const values = { ...this.values, [`ref:${key}`]: source, [`refprefix:${key}`]: prefix }; delete values[key]; this.write(values);
  }

  set(key: string, value: string): void {
    if (!SAFE_KEY.test(key)) throw new Error(`invalid secret key: ${key}`);
    const values = { ...this.values, [key]: value }; delete values[`ref:${key}`]; delete values[`refprefix:${key}`]; this.write(values);
  }

  delete(key: string): void {
    this.write(Object.fromEntries(Object.entries(this.values).filter(([k]) => k !== key && k !== `ref:${key}` && k !== `refprefix:${key}`)));
  }

  deleteUnder(prefix: string): void {
    const kept = Object.entries(this.values).filter(([key]) => !key.startsWith(prefix) && !key.startsWith(`ref:${prefix}`) && !key.startsWith(`refprefix:${prefix}`));
    if (kept.length !== Object.keys(this.values).length) this.write(Object.fromEntries(kept));
  }

  /** Why the store is read-only (corrupt or unreadable file), or undefined when writes are allowed. */
  get degraded(): string | undefined { return this.degradedReason; }

  private load(): Record<string, string> {
    if (this.filePath === ':memory:') return {};
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      // The bytes may be fine (locked, permissions): keep them untouched and refuse to write over them.
      this.degradedReason = `secrets file is unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})`;
      console.error(`[secrets] ${this.degradedReason}: ${this.filePath}. Secret changes are disabled until it is fixed.`);
      return this.loadBackup() ?? {};
    }
    let decrypted: string;
    try { decrypted = decodeSecrets(raw, this.encryptionKey); }
    catch { this.degradedReason = 'encrypted secrets could not be authenticated; check the encryption key and restore a valid backup'; return this.loadBackup() ?? {}; }
    const parsed = parseSecrets(decrypted);
    if (parsed) return parsed;
    const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      renameSync(this.filePath, quarantine);
      console.error(`[secrets] secrets file is corrupt; moved it to ${quarantine}. Restore it (or ${this.filePath}.bak) to recover saved secrets.`);
    } catch (error) {
      console.error(`[secrets] secrets file is corrupt and could not be quarantined (${(error as Error).message}); leaving it in place.`);
    }
    const backup = this.loadBackup();
    this.degradedReason = backup
      ? `secrets file was corrupt (kept at ${quarantine}); serving the last good backup read-only`
      : `secrets file was corrupt (kept at ${quarantine})`;
    return backup ?? {};
  }

  private loadBackup(): Record<string, string> | undefined {
    try { return parseSecrets(decodeSecrets(readFileSync(`${this.filePath}.bak`, 'utf8'), this.encryptionKey)); } catch { return undefined; }
  }

  private write(next: Record<string, string>): void {
    if (this.degradedReason) {
      throw new Error(`Secret store is read-only: ${this.degradedReason}. Restart Waystation after restoring or removing the file to make changes.`);
    }
    if (this.filePath === ':memory:') { this.values = next; return; }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(temp, encodeSecrets(next, this.encryptionKey), { encoding: 'utf8', mode: 0o600, flush: true });
      // One rolling backup of the previous good contents (it was loaded or written by this store).
      if (existsSync(this.filePath)) {
        if (this.encryptionKey) writeFileSync(`${this.filePath}.bak`, encodeSecrets(this.values, this.encryptionKey), { encoding: 'utf8', mode: 0o600, flush: true });
        else copyFileSync(this.filePath, `${this.filePath}.bak`);
      }
      restrict(`${this.filePath}.bak`);
      replaceSecretFile(temp, this.filePath);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    restrict(this.filePath);
    this.values = next;
  }
}

/** Antivirus/indexer reads can briefly deny Windows file replacement. Keep the old file and retry atomically. */
export function replaceSecretFile(source: string, destination: string, move = renameSync, pause = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }): void {
  for (let attempt = 0; ; attempt++) {
    try { move(source, destination); return; }
    catch (error) { if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; pause(20 * (attempt + 1)); }
  }
}

function parseSecrets(raw: string): Record<string, string> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return undefined;
  }
}

function restrict(path: string): void {
  try {
    if (existsSync(path)) chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file lives in the user's own LOCALAPPDATA.
  }
}
