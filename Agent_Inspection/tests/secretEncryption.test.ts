import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { replaceSecretFile, SecretStore } from '../daemon/library/secretStore.ts';
import { tempDir } from './helpers.ts';
describe('credential encryption at rest', () => {
  it('retries a transient file lock without deleting the destination, and propagates permanent replacement failures', () => {
    const locked = Object.assign(new Error('locked'), { code: 'EPERM' });
    const move = vi.fn().mockImplementationOnce(() => { throw locked; }).mockImplementationOnce(() => { throw locked; }).mockReturnValue(undefined);
    const pause = vi.fn(); replaceSecretFile('temporary', 'current', move, pause); expect(move).toHaveBeenCalledTimes(3); expect(pause).toHaveBeenCalledTimes(2);
    const permanent = vi.fn(() => { throw locked; }); expect(() => replaceSecretFile('temporary', 'current', permanent, pause)).toThrow('locked'); expect(permanent).toHaveBeenCalledTimes(6);
  });
  it('encrypts current values and backups, and restores aliases with the configured key', () => {
    const path = join(tempDir(), 'secrets.json'); const key = randomBytes(32); const store = new SecretStore(path, key);
    store.set('key', 'secret-that-must-never-be-plaintext'); store.alias('consumer', 'key', 'Bearer ');
    expect(readFileSync(path, 'utf8')).not.toContain('secret-that'); expect(readFileSync(`${path}.bak`, 'utf8')).not.toContain('secret-that');
    expect(new SecretStore(path, key).get('consumer')).toBe('Bearer secret-that-must-never-be-plaintext');
  });
  it('fails closed on a wrong key or modified ciphertext without quarantining valid encrypted data', () => {
    const path = join(tempDir(), 'secrets.json'); const key = randomBytes(32); const store = new SecretStore(path, key); store.set('key', 'protected');
    const wrong = new SecretStore(path, randomBytes(32)); expect(wrong.degraded).toMatch(/authenticated/); expect(() => wrong.set('x', 'y')).toThrow(/read-only/); expect(existsSync(path)).toBe(true);
    const envelope = JSON.parse(readFileSync(path, 'utf8')); envelope.tag = randomBytes(16).toString('base64'); writeFileSync(path, JSON.stringify(envelope));
    expect(new SecretStore(path, key).degraded).toMatch(/authenticated/);
  });
  it('encrypts the backup during a deliberate migration from a previously plaintext store', () => {
    const path = join(tempDir(), 'secrets.json'); writeFileSync(path, JSON.stringify({ old: 'legacy-sensitive-value' }));
    const key = randomBytes(32); const store = new SecretStore(path, key); store.set('new', 'new-value');
    expect(readFileSync(`${path}.bak`, 'utf8')).not.toContain('legacy-sensitive-value'); expect(new SecretStore(path, key).get('old')).toBe('legacy-sensitive-value');
  });
});
