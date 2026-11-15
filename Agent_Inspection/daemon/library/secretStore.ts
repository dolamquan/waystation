import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SAFE_KEY = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * Secret values (MCP tokens, webhook URLs, SMTP passwords) in one local JSON file outside OneDrive.
 * Keys are namespaced by owner, e.g. "mcp:<id>:GITHUB_TOKEN" or "notify:<id>:webhookUrl".
 * Values never leave the daemon through the API; only key names do.
 */
export class SecretStore {
  private values: Readonly<Record<string, string>>;

  constructor(private readonly filePath: string) {
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

  private load(): Record<string, string> {
    if (this.filePath === ':memory:' || !existsSync(this.filePath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch {
      console.error('[secrets] unreadable secrets file; starting empty');
      return {};
    }
  }

  private write(next: Record<string, string>): void {
    this.values = next;
    if (this.filePath === ':memory:') return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // Windows ignores POSIX modes; the file lives in the user's own LOCALAPPDATA.
    }
  }
}
