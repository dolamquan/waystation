import { describe, expect, it } from 'vitest';
import { applyLoadout, isEmptyLoadout, parseLoadout } from '../daemon/library/loadout.ts';
import { SecretStore } from '../daemon/library/secretStore.ts';
import type { LoadoutProvider } from '../daemon/library/types.ts';
import type { ManagedLaunch } from '../daemon/managed/types.ts';

const base: ManagedLaunch = { vendor: 'claude', cwd: 'C:/work', prompt: 'go', agentId: 'managed:1', appendSystemPrompt: 'Be brief.' };

describe('parseLoadout', () => {
  it('returns undefined when nothing is selected', () => {
    expect(parseLoadout(undefined)).toBeUndefined();
    expect(parseLoadout({ skillIds: [] })).toBeUndefined();
  });

  it('dedupes ids and keeps only known keys', () => {
    expect(parseLoadout({ skillIds: ['a', 'a', 'b'], other: ['x'] })).toEqual({ skillIds: ['a', 'b'] });
  });

  it('rejects invalid ids and shapes', () => {
    expect(() => parseLoadout({ docIds: ['bad id with spaces'] })).toThrow(/invalid id/);
    expect(() => parseLoadout({ mcpIds: 'playwright' })).toThrow(/list/);
    expect(() => parseLoadout([])).toThrow(/object/);
  });
});

describe('applyLoadout', () => {
  it('leaves the launch untouched for an empty loadout', () => {
    expect(applyLoadout(base, undefined, []).launch).toBe(base);
    expect(isEmptyLoadout({})).toBe(true);
  });

  it('merges prompts, plugins, MCP servers, env and notes in provider order', () => {
    const docs: LoadoutProvider = { contribute: () => ({ appendSystemPrompt: 'Read DOC.md first.' }) };
    const tools: LoadoutProvider = {
      contribute: () => ({
        plugins: ['C:/plugins/a'],
        mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp'], env: {} } },
        remoteMcpServers: { remote: { type: 'http', url: 'https://example.test/mcp' } },
        env: { TOKEN: 'secret' },
        notes: ['note'],
      }),
    };
    const { launch, notes } = applyLoadout(base, { docIds: ['d1'] }, [docs, tools]);
    expect(launch.appendSystemPrompt).toBe('Be brief.\n\nRead DOC.md first.');
    expect(launch.plugins).toEqual(['C:/plugins/a']);
    expect(Object.keys(launch.mcpServers ?? {})).toEqual(['playwright']);
    expect(launch.remoteMcpServers?.remote.url).toBe('https://example.test/mcp');
    expect(launch.env).toEqual({ TOKEN: 'secret' });
    expect(notes).toEqual(['note']);
  });

  it('refuses two MCP servers with the same name', () => {
    const one: LoadoutProvider = { contribute: () => ({ mcpServers: { x: { command: 'a', args: [], env: {} } } }) };
    const two: LoadoutProvider = { contribute: () => ({ remoteMcpServers: { x: { type: 'sse', url: 'https://e.test' } } }) };
    expect(() => applyLoadout(base, { mcpIds: ['m'] }, [one, two])).toThrow(/both named "x"/);
  });

  it('needs an agent id', () => {
    expect(() => applyLoadout({ ...base, agentId: undefined }, { skillIds: ['s'] }, [])).toThrow(/agentId/);
  });
});

describe('SecretStore (memory)', () => {
  it('stores, lists by prefix and deletes', () => {
    const secrets = new SecretStore(':memory:');
    secrets.set('mcp:1:TOKEN', 'a');
    secrets.set('mcp:1:OTHER', 'b');
    secrets.set('notify:2:url', 'c');
    expect(secrets.namesUnder('mcp:1:')).toEqual(['OTHER', 'TOKEN']);
    secrets.deleteUnder('mcp:1:');
    expect(secrets.namesUnder('mcp:1:')).toEqual([]);
    expect(secrets.get('notify:2:url')).toBe('c');
    expect(() => secrets.set('bad key', 'x')).toThrow();
  });
});
