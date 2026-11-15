import { describe, expect, it } from 'vitest';
import { TowerStore } from '../daemon/store/db.ts';
import { DiscoveryCatalog } from '../daemon/collectors/discoveryCatalog.ts';
import { classifyObserved } from '../daemon/collectors/processScanner.ts';

describe('custom discovery rules', () => {
  it('validates signatures, detects runtime packages and prevents shared-host or duplicate executable rules', () => {
    const store = new TowerStore(':memory:');
    const catalog = new DiscoveryCatalog(store);
    try {
      const rule = catalog.add({ label: 'My Agent', package: '@example/my-agent' });
      expect(classifyObserved([{ pid: 5, ppid: 1, name: 'node.exe', commandLine: 'node C:/npm/@example/my-agent/bin.js', created: '' }], catalog.list())[0].providerId).toBe(rule.id);
      expect(() => catalog.add({ label: 'duplicate', package: '@example/my-agent' })).toThrow(/already/);
      for (const executable of ['node.exe', 'Code.exe', 'python.exe', 'powershell.exe', 'codex.exe', 'copilot.exe', 'agent.exe --prompt hi']) {
        expect(() => catalog.add({ label: 'Unsafe or duplicate', executable })).toThrow();
      }
      expect(() => catalog.add({ label: 'No signature' })).toThrow();
      expect(() => catalog.add({ label: '', executable: 'test-agent' })).toThrow();
      expect(() => catalog.remove('copilot')).toThrow();
      catalog.remove(rule.id);
      expect(catalog.list().some(entry => entry.id === rule.id)).toBe(false);
    } finally { store.close(); }
  });
});
