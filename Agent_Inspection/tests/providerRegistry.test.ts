import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, resolveAgentCommand } from '../daemon/managed/providerRegistry.ts';
import { NATIVE_PROVIDERS, replaceProviderCatalog } from '../shared/agentProviders.ts';
import { tempDir } from './helpers.ts';
afterEach(() => replaceProviderCatalog(NATIVE_PROVIDERS));
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));

describe('dynamic provider registry', () => {
  it('discovers installed Gemini without running it, including npm Windows shims', () => {
    const dir = tempDir();
    const script = join(dir, 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js'); mkdirSync(dirname(script), { recursive: true }); writeFileSync(script, 'throw new Error("Discovery must not execute me")');
    writeFileSync(join(dir, 'gemini.cmd'), '@"%dp0%\\node.exe" "%dp0%\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*');
    const command = process.platform === 'win32' ? 'gemini' : 'gemini.cmd';
    const resolved = resolveAgentCommand(command, ['--acp'], { PATH: dir });
    expect(resolved).toEqual({ command: process.execPath, args: [script, '--acp'] });
    if (process.platform === 'win32') {
      const registry = new ProviderRegistry({ files: [], env: { PATH: dir } });
      expect(registry.list()).toContainEqual(expect.objectContaining({ id: 'gemini', adapter: 'acp', available: true }));
    }
  });
  it('refreshes configured agents, keeps a last good config on malformed edits, and never exposes secrets', () => {
    const configFile = join(tempDir(), 'providers.json');
    const registry = new ProviderRegistry({ configFile, files: [configFile], env: { PATH: '' }, home: tempDir() });
    expect(registry.get('my-agent')).toBeUndefined();
    write(configFile, { providers: [{ id: 'my-agent', label: 'My Agent', command: process.execPath, args: ['agent.js'], env: { SECRET: 'never-expose' } }] });
    registry.refresh();
    expect(registry.list()).toContainEqual(expect.objectContaining({ id: 'my-agent', available: true }));
    expect(JSON.stringify(registry.report())).not.toContain('never-expose');
    writeFileSync(configFile, '{ broken'); registry.refresh(); expect(registry.get('my-agent')).toBeDefined(); expect(registry.report().warnings).toHaveLength(1);
    write(configFile, { providers: [] }); registry.refresh(); expect(registry.get('my-agent')).toBeUndefined();
    unlinkSync(configFile); registry.refresh(); expect(registry.report().warnings).toEqual([]);
  });
  it('imports local Zed agent servers with JSON comments and rejects duplicates and native ID collisions', () => {
    const configFile = join(tempDir(), 'providers.json'), settings = join(tempDir(), 'settings.json');
    writeFileSync(settings, `{ // existing editor configuration\n "agent_servers": { "Example Agent": { "command": ${JSON.stringify(process.execPath)}, "args": [], }, "registry-agent": {"type":"registry"} } }`);
    const registry = new ProviderRegistry({ configFile, files: [settings, configFile], env: { PATH: '' }, home: tempDir() });
    expect(registry.get('acp-example-agent')).toBeDefined();
    expect(registry.list().filter(provider => provider.adapter === 'acp')).toHaveLength(1);
    expect(() => registry.add({ id: 'claude', command: process.execPath })).toThrow(/IDs/);
    registry.add({ id: 'custom', label: 'Custom', command: 'nonexistent-waystation-agent' });
    expect(registry.list()).toContainEqual(expect.objectContaining({ id: 'custom', available: false }));
    expect(() => registry.add({ id: 'custom', command: process.execPath })).toThrow(/already/);
    registry.remove('custom'); expect(registry.get('custom')).toBeUndefined();
    expect(() => registry.remove('acp-example-agent')).toThrow(/original/);
  });
  it('shows configured but unavailable agents without reading account secrets', () => {
    const home = tempDir(); mkdirSync(join(home, '.gemini')); writeFileSync(join(home, '.gemini', 'settings.json'), '{"secret":"never-return-this"}');
    const registry = new ProviderRegistry({ home, files: [], env: { PATH: '' } });
    expect(registry.list()).toContainEqual(expect.objectContaining({ id: 'gemini', available: false }));
    expect(JSON.stringify(registry.report())).not.toContain('never-return-this');
  });
  it('resolves npm native binaries and extensionless Node launchers without a shell', () => {
    const directory = tempDir(), bin = join(directory, 'node_modules', 'example-agent', 'bin'); mkdirSync(bin, { recursive: true });
    const native = join(bin, 'agent.exe'); writeFileSync(native, 'fixture');
    const script = join(bin, 'agent'); writeFileSync(script, '#!/usr/bin/env node\nthrow new Error("Never run discovery probes");');
    writeFileSync(join(directory, 'native.cmd'), '@"%dp0%\\node_modules\\example-agent\\bin\\agent.exe" %*');
    writeFileSync(join(directory, 'script.cmd'), '@"%dp0%\\node.exe" "%dp0%\\node_modules\\example-agent\\bin\\agent" %*');
    expect(resolveAgentCommand(join(directory, 'native.cmd'), ['acp'])).toEqual({ command: native, args: ['acp'] });
    expect(resolveAgentCommand(join(directory, 'script.cmd'), ['--acp'])).toEqual({ command: process.execPath, args: [script, '--acp'] });
  });
});
