import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretStore } from '../daemon/library/secretStore.ts';
import { tempDir } from './helpers.ts';

let dir: string;
let file: string;
beforeEach(() => { dir = tempDir('secret-store-'); file = join(dir, 'secrets.json'); vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });

const quarantined = (): string[] => readdirSync(dir).filter(name => name.startsWith('secrets.json.corrupt-'));

describe('SecretStore persistence', () => {
  it('round-trips values, aliases and deletes through the file', () => {
    const store = new SecretStore(file);
    store.set('mcp:a:TOKEN', 'one');
    store.alias('mcp:b:TOKEN', 'mcp:a:TOKEN', 'Bearer ');
    const reloaded = new SecretStore(file);
    expect(reloaded.get('mcp:b:TOKEN')).toBe('Bearer one');
    reloaded.delete('mcp:a:TOKEN');
    expect(new SecretStore(file).get('mcp:a:TOKEN')).toBeUndefined();
  });

  it('starts empty and writable when the file does not exist', () => {
    const store = new SecretStore(join(dir, 'nested', 'secrets.json'));
    expect(store.degraded).toBeUndefined();
    store.set('k', 'v');
    expect(new SecretStore(join(dir, 'nested', 'secrets.json')).get('k')).toBe('v');
  });

  it('keeps a rolling .bak of the previous good contents and leaves no temp files', () => {
    const store = new SecretStore(file);
    store.set('a', '1');
    expect(existsSync(`${file}.bak`)).toBe(false);
    store.set('b', '2');
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8'))).toEqual({ a: '1' });
    store.set('c', '3');
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8'))).toEqual({ a: '1', b: '2' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: '1', b: '2', c: '3' });
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('quarantines a corrupt file instead of overwriting it, and refuses writes', () => {
    const corrupt = '{"mcp:a:TOKEN": "precious", truncated';
    writeFileSync(file, corrupt);
    const store = new SecretStore(file);
    expect(quarantined()).toHaveLength(1);
    expect(readFileSync(join(dir, quarantined()[0]), 'utf8')).toBe(corrupt);
    expect(store.degraded).toMatch(/corrupt/i);
    expect(console.error).toHaveBeenCalled();
    expect(() => store.set('x', 'y')).toThrow(/read-only/i);
    expect(() => store.delete('x')).toThrow(/read-only/i);
    expect(() => store.alias('x', 'y')).toThrow(/read-only/i);
    expect(() => store.deleteUnder('nothing-here:')).not.toThrow(); // nothing to remove, nothing written
    expect(existsSync(file)).toBe(false); // nothing silently written in its place
    expect(readFileSync(join(dir, quarantined()[0]), 'utf8')).toBe(corrupt);
  });

  it('treats a non-object JSON document as corrupt too', () => {
    writeFileSync(file, '["not", "a", "map"]');
    const store = new SecretStore(file);
    expect(store.degraded).toBeDefined();
    expect(quarantined()).toHaveLength(1);
  });

  it('serves the last good backup read-only when the main file is corrupt', () => {
    const store = new SecretStore(file);
    store.set('a', '1');
    store.set('b', '2'); // .bak now holds { a: '1' }
    writeFileSync(file, 'garbage');
    const recovered = new SecretStore(file);
    expect(recovered.get('a')).toBe('1');
    expect(recovered.degraded).toMatch(/backup/i);
    expect(() => recovered.set('c', '3')).toThrow(/read-only/i);
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8'))).toEqual({ a: '1' });
  });

  it('a fresh start after quarantine never clobbers the backup with an empty store', () => {
    const store = new SecretStore(file);
    store.set('a', '1');
    store.set('b', '2');
    writeFileSync(file, 'garbage');
    new SecretStore(file); // quarantines
    const fresh = new SecretStore(file); // main file is gone now
    fresh.set('z', '9');
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8'))).toEqual({ a: '1' });
    expect(quarantined()).toHaveLength(1);
  });

  it('does not quarantine when the file cannot be read (e.g. it is a directory), but still refuses writes', () => {
    mkdirSync(file);
    const store = new SecretStore(file);
    expect(store.degraded).toMatch(/unreadable/i);
    expect(quarantined()).toHaveLength(0);
    expect(() => store.set('x', 'y')).toThrow(/read-only/i);
  });

  it(':memory: stores never touch disk', () => {
    const store = new SecretStore(':memory:');
    store.set('a', '1');
    expect(store.get('a')).toBe('1');
    expect(existsSync(':memory:')).toBe(false);
  });
});
