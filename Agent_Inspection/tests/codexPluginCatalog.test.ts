import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexPluginCatalog, readMarketplaceDescriptions, type CodexPluginCli } from '../daemon/library/codexPluginCatalog.ts';
import type { LibraryDeps } from '../daemon/library/deps.ts';
import { SecretStore } from '../daemon/library/secretStore.ts';
import { LibraryInputError } from '../daemon/library/types.ts';
import { TowerStore } from '../daemon/store/db.ts';
import { tempDir } from './helpers.ts';

const write = (path: string, data: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data));
};

const entry = (name: string, marketplace: string, extra: Record<string, unknown> = {}) => ({
  pluginId: `${name}@${marketplace}`, name, marketplaceName: marketplace, installed: false, enabled: false,
  source: { source: 'remote', id: `plugin_${name}` }, installPolicy: 'AVAILABLE', authPolicy: 'ON_INSTALL', ...extra,
});

/** A local marketplace folder laid out the way Codex keeps its curated one. */
function fakeMarketplaceRoot(): string {
  const root = tempDir('codex-market-');
  write(join(root, '.agents', 'plugins', 'marketplace.json'), {
    name: 'curated',
    plugins: [
      { name: 'figma', source: { source: 'local', path: './plugins/figma' } },
      { name: 'linear', source: { source: 'local', path: './plugins/linear' } },
      { name: 'escape', source: { source: 'local', path: '../outside' } },
    ],
  });
  write(join(root, 'plugins', 'figma', '.codex-plugin', 'plugin.json'), { name: 'figma', description: 'Long text', interface: { shortDescription: 'Figma design-to-code' } });
  write(join(root, 'plugins', 'linear', '.codex-plugin', 'plugin.json'), { name: 'linear', description: 'Issue tracking' });
  write(join(root, '..', 'outside', '.codex-plugin', 'plugin.json'), { description: 'should never be read' });
  return root;
}

function setup(responses: { list?: unknown; available?: unknown; code?: number; output?: string } = {}) {
  const root = fakeMarketplaceRoot();
  const calls: string[][] = [];
  const audits: string[] = [];
  const cli: CodexPluginCli = async (args) => {
    calls.push([...args]);
    if (args[0] === 'marketplace') return { code: 0, output: '', stdout: JSON.stringify({ marketplaces: [{ name: 'curated', root }] }) };
    if (args[0] === 'list') {
      const body = args.includes('--available') ? responses.available : responses.list;
      return { code: responses.code ?? 0, output: responses.output ?? '', stdout: JSON.stringify(body ?? { installed: [], available: [] }) };
    }
    return { code: responses.code ?? 0, output: responses.output ?? 'done' };
  };
  const deps: LibraryDeps = {
    store: new TowerStore(':memory:'),
    secrets: new SecretStore(':memory:'),
    paths: { skillsLibraryDir: '', docsDir: '', loadoutsDir: '', claudeHome: '' },
    audit: (action, target) => audits.push(`${action} ${target}`),
  };
  return { root, calls, audits, catalog: new CodexPluginCatalog(deps, cli) };
}

const installed = {
  installed: [
    entry('github', 'curated-remote', { installed: true, enabled: true, version: '0.1.12' }),
    entry('figma', 'curated-remote', { installed: true, enabled: false }),
    { pluginId: '--evil@x', name: '--evil', marketplaceName: 'x', installed: true },
    'not an object',
  ],
};

describe('readMarketplaceDescriptions', () => {
  it('reads short descriptions by id and by name, never outside the marketplace root', () => {
    const descriptions = readMarketplaceDescriptions([fakeMarketplaceRoot(), join(tempDir(), 'missing')]);
    expect(descriptions.get('figma@curated')).toBe('Figma design-to-code');
    expect(descriptions.get('figma')).toBe('Figma design-to-code');
    expect(descriptions.get('linear')).toBe('Issue tracking');
    expect(descriptions.has('escape')).toBe(false);
  });
});

describe('CodexPluginCatalog.list', () => {
  it('parses codex plugin list --json, drops malformed entries and adds marketplace descriptions', async () => {
    const { catalog, calls } = setup({ list: installed });
    expect(await catalog.list()).toEqual([
      { id: 'figma@curated-remote', name: 'figma', marketplace: 'curated-remote', description: 'Figma design-to-code', enabled: false, source: 'remote' },
      { id: 'github@curated-remote', name: 'github', marketplace: 'curated-remote', version: '0.1.12', enabled: true, source: 'remote' },
    ]);
    expect(calls).toContainEqual(['list', '--json']);
  });

  it('reports CLI failures and unreadable output', async () => {
    await expect(setup({ code: 1, output: 'not signed in' }).catalog.list()).rejects.toThrow(/not signed in/);
    const { catalog } = setup();
    const broken = new CodexPluginCatalog(
      { store: new TowerStore(':memory:'), secrets: new SecretStore(':memory:'), paths: { skillsLibraryDir: '', docsDir: '', loadoutsDir: '', claudeHome: '' }, audit: () => undefined },
      async () => ({ code: 0, output: '', stdout: 'Error: oops' }),
    );
    await expect(broken.list()).rejects.toThrow(LibraryInputError);
    expect(await catalog.list()).toEqual([]);
  });
});

describe('CodexPluginCatalog.available', () => {
  it('merges installed and available, hides unavailable and opaque connector ids, puts described plugins first', async () => {
    const { catalog, calls } = setup({
      available: {
        installed: [entry('figma', 'curated-remote', { installed: true, enabled: true })],
        available: [
          entry('zapier', 'curated-remote'),
          entry('linear', 'curated-remote'),
          entry('figma', 'curated-remote'),
          entry('app-6a057d268ebc81919918d37eec718425', 'curated-remote'),
          entry('blocked', 'curated-remote', { installPolicy: 'NOT_AVAILABLE' }),
        ],
      },
    });
    expect(await catalog.available()).toEqual([
      { id: 'figma@curated-remote', name: 'figma', marketplace: 'curated-remote', installed: true, description: 'Figma design-to-code' },
      { id: 'linear@curated-remote', name: 'linear', marketplace: 'curated-remote', installed: false, description: 'Issue tracking' },
      { id: 'zapier@curated-remote', name: 'zapier', marketplace: 'curated-remote', installed: false },
    ]);
    expect(calls).toContainEqual(['list', '--json', '--available']);
  });
});

describe('CodexPluginCatalog install and uninstall', () => {
  it('runs codex plugin add/remove with an args array and audits it', async () => {
    const { catalog, calls, audits } = setup({ list: installed });
    expect(await catalog.install('linear@curated-remote')).toBe('done');
    expect(await catalog.uninstall('github@curated-remote')).toBe('done');
    expect(calls).toContainEqual(['add', 'linear@curated-remote']);
    expect(calls).toContainEqual(['remove', 'github@curated-remote']);
    expect(audits).toEqual(['codex_plugin_add linear@curated-remote', 'codex_plugin_remove github@curated-remote']);
  });

  it('refuses ids that could read as flags and plugins that are not installed', async () => {
    const { catalog } = setup({ list: installed });
    await expect(catalog.install('--dangerous@x')).rejects.toThrow(LibraryInputError);
    await expect(catalog.install('linear')).rejects.toThrow(LibraryInputError);
    await expect(catalog.uninstall('ghost@curated-remote')).rejects.toThrow(/not installed/);
  });

  it('reports a failed install with what the CLI printed', async () => {
    const { catalog } = setup({ code: 2, output: 'marketplace not found' });
    await expect(catalog.install('linear@curated-remote')).rejects.toThrow(/marketplace not found/);
  });
});
