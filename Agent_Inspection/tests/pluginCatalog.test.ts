import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LibraryDeps } from '../daemon/library/deps.ts';
import { PluginCatalog, type PluginCli } from '../daemon/library/pluginCatalog.ts';
import { SecretStore } from '../daemon/library/secretStore.ts';
import { LibraryInputError } from '../daemon/library/types.ts';
import type { ManagedLaunch } from '../daemon/managed/types.ts';
import { TowerStore } from '../daemon/store/db.ts';
import { tempDir } from './helpers.ts';

const write = (path: string, data: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data));
};

function fakeClaudeHome(): { home: string; browserPath: string; reviewPath: string } {
  const home = tempDir('claude-home-');
  const browserPath = join(home, 'plugins', 'cache', 'official', 'browser', '1.0.0');
  const reviewPath = join(home, 'plugins', 'cache', 'official', 'review', 'abc');
  write(join(home, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'browser@official': [{ scope: 'user', installPath: browserPath, version: '1.0.0' }],
      'review@official': [{ scope: 'project', installPath: reviewPath, version: 'abc' }],
      'bad id': [{ scope: 'user', installPath: reviewPath }],
    },
  });
  write(join(browserPath, '.claude-plugin', 'plugin.json'), { name: 'browser', description: 'Browse the web' });
  write(join(browserPath, '.mcp.json'), { mcpServers: { playwright: {}, devtools: {} } });
  write(join(browserPath, 'skills', 'screenshots', 'SKILL.md'), '---\nname: screenshots\n---\n');
  write(join(browserPath, 'skills', 'empty', 'notes.txt'), 'no skill here');
  write(join(reviewPath, '.claude-plugin', 'plugin.json'), { name: 'review', mcpServers: { one: {} } });
  write(join(home, 'settings.json'), { enabledPlugins: { 'browser@official': true, 'review@official': false } });
  write(join(home, 'plugins', 'marketplaces', 'official', '.claude-plugin', 'marketplace.json'), {
    name: 'official',
    plugins: [{ name: 'browser', description: 'Browse' }, { name: 'docs', description: 'Docs helper' }, { name: 'bad name!' }],
  });
  return { home, browserPath, reviewPath };
}

function setup(cli: PluginCli = async () => ({ code: 0, output: 'done' })) {
  const fake = fakeClaudeHome();
  const audits: string[] = [];
  const deps: LibraryDeps = {
    store: new TowerStore(':memory:'),
    secrets: new SecretStore(':memory:'),
    paths: { skillsLibraryDir: '', docsDir: '', loadoutsDir: '', claudeHome: fake.home },
    audit: (action, target) => audits.push(`${action} ${target}`),
  };
  return { ...fake, audits, catalog: new PluginCatalog(deps, cli) };
}

const launch = (vendor: 'claude' | 'codex'): ManagedLaunch => ({ vendor, cwd: 'C:\\w', prompt: 'go', agentId: 'managed:1' });

describe('PluginCatalog.list', () => {
  it('reads installed plugins, manifests, skill and MCP counts and global enablement', () => {
    const { catalog, browserPath } = setup();
    const plugins = catalog.list();
    expect(plugins.map((p) => p.id)).toEqual(['browser@official', 'review@official']);
    expect(plugins[0]).toEqual({
      id: 'browser@official', name: 'browser', marketplace: 'official', version: '1.0.0', description: 'Browse the web',
      installPath: browserPath, skills: 1, mcpServers: 2, enabledGlobally: true, defaultOn: false,
    });
    expect(plugins[1]).toMatchObject({ skills: 0, mcpServers: 1, enabledGlobally: false });
  });

  it('is empty when nothing is installed', () => {
    const deps = { store: new TowerStore(':memory:'), secrets: new SecretStore(':memory:'), paths: { skillsLibraryDir: '', docsDir: '', loadoutsDir: '', claudeHome: tempDir() }, audit: () => undefined };
    const catalog = new PluginCatalog(deps);
    expect(catalog.list()).toEqual([]);
    expect(catalog.available()).toEqual([]);
  });
});

describe('PluginCatalog.available', () => {
  it('lists marketplace plugins and marks installed ones', () => {
    const { catalog } = setup();
    expect(catalog.available()).toEqual([
      { id: 'browser@official', name: 'browser', marketplace: 'official', installed: true, description: 'Browse' },
      { id: 'docs@official', name: 'docs', marketplace: 'official', installed: false, description: 'Docs helper' },
    ]);
  });
});

describe('PluginCatalog defaults and CLI actions', () => {
  it('stores default-on preferences for installed plugins only', () => {
    const { catalog } = setup();
    catalog.setDefault('review@official', true);
    expect(catalog.list().find((p) => p.id === 'review@official')?.defaultOn).toBe(true);
    expect(() => catalog.setDefault('ghost@official', true)).toThrow(LibraryInputError);
    expect(() => catalog.setDefault('review@official', 'yes')).toThrow(LibraryInputError);
  });

  it('runs claude plugin with an args array and audits it', async () => {
    const calls: string[][] = [];
    const { catalog, audits } = setup(async (args) => { calls.push([...args]); return { code: 0, output: 'ok' }; });
    expect(await catalog.install('docs@official')).toBe('ok');
    await catalog.setEnabled('review@official', true);
    await catalog.setEnabled('browser@official', false);
    await catalog.uninstall('review@official');
    expect(calls).toEqual([
      ['install', 'docs@official', '--scope', 'user'],
      ['enable', 'review@official', '--scope', 'user'],
      ['disable', 'browser@official', '--scope', 'user'],
      ['uninstall', 'review@official', '--scope', 'user'],
    ]);
    expect(audits).toContain('plugin_install docs@official');
  });

  it('refuses ids that could read as flags and reports CLI failures', async () => {
    const { catalog } = setup(async () => ({ code: 1, output: 'Plugin not found' }));
    await expect(catalog.install('--dangerous@x')).rejects.toThrow(LibraryInputError);
    await expect(catalog.install('docs')).rejects.toThrow(LibraryInputError);
    await expect(catalog.install('docs@official')).rejects.toThrow(/Plugin not found/);
  });
});

describe('PluginCatalog.contribute', () => {
  it('loads plugins not enabled globally as plugin dirs for Claude', () => {
    const { catalog, reviewPath } = setup();
    expect(catalog.contribute({ pluginIds: ['browser@official', 'review@official'] }, launch('claude'))).toEqual({ plugins: [reviewPath] });
    expect(catalog.contribute({ pluginIds: ['browser@official'] }, launch('claude'))).toEqual({});
    expect(catalog.contribute({ mcpIds: ['x'] }, launch('claude'))).toEqual({});
  });

  it('notes that Codex ignores plugins and refuses unknown ids', () => {
    const { catalog } = setup();
    expect(catalog.contribute({ pluginIds: ['review@official'] }, launch('codex'))).toEqual({ notes: ['Plugins are ignored for Codex agents.'] });
    expect(() => catalog.contribute({ pluginIds: ['ghost@official'] }, launch('claude'))).toThrow(LibraryInputError);
  });
});
