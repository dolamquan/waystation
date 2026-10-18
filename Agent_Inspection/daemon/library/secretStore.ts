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
    return this.values[key];
  }

  has(key: string): boolean {
    return key in this.values;
  }

  /** Keys starting with `prefix`, with the prefix removed. */
  namesUnder(prefix: string): string[] {
    return Object.keys(this.values).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)).sort();
  }

  set(key: string, value: string): void {
    if (!SAFE_KEY.test(key)) throw new Error(`invalid secret key: ${key}`);
    this.write({ ...this.values, [key]: value });
  }

  delete(key: string): void {
    if (!(key in this.values)) return;
    this.write(Object.fromEntries(Object.entries(this.values).filter(([k]) => k !== key)));
  }

  deleteUnder(prefix: string): void {
    const kept = Object.entries(this.values).filter(([key]) => !key.startsWith(prefix));
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
