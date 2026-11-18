import { describe, expect, it, vi } from 'vitest';
import { architectureRoutes } from '../daemon/api/routes/architecture.ts';
import { TowerStore } from '../daemon/store/db.ts';
import { ArchitectureStore } from '../daemon/architecture/store.ts';
import { tempDir } from './helpers.ts';

describe('API architect proposals', () => {
  it('closes the legacy untracked test path in hosted mode', async () => {
    const tower = { library: { automation: { architectures: {} }, agentRuns: { bind: vi.fn() } } } as any;
    const route = architectureRoutes(tower).find(r => r.method === 'POST' && r.pattern.test('/api/architectures/id/nodes/a/test'))!;
    vi.stubEnv('WAYSTATION_HOSTED', '1');
    try { await expect(route.handler({ params: ['id', 'a'], body: {}, req: {} as any, res: {} as any })).rejects.toThrow(/legacy untracked/); }
    finally { vi.unstubAllEnvs(); }
  });
  it('blocks native coding launches at the worker boundary', async () => {
    const { Tower } = await import('../daemon/tower.ts');
    vi.stubEnv('WAYSTATION_HOSTED', '1');
    try { expect(() => Tower.prototype.launch.call({} as any, {})).toThrow(/disabled for hosted/); }
    finally { vi.unstubAllEnvs(); }
  });
  it('validates proposed edits without applying them and rejects stale requests', async () => {
    const db = new TowerStore(':memory:'); const store = new ArchitectureStore(db);
    const doc = store.create({ project: tempDir(), graph: 'starter' }).document;
    const run = vi.fn(async (..._args: unknown[]) => ({ text: JSON.stringify({ reply: 'A clearer goal.', operations: [{ type: 'describe', title: doc.title, description: 'Verified proposal' }] }), truncated: false }));
    const tower = { library: { automation: { architectures: store }, agentRuns: { bind: vi.fn() }, brains: { run, list: () => [], sanitize: (_p: string, value: string) => value } } } as any;
    const route = architectureRoutes(tower).find(r => r.method === 'POST' && r.pattern.test(`/api/architectures/${doc.id}/api-chat`))!;
    const call = (revision: number) => route.handler({ params: [doc.id], body: { connectionId: 'brain', text: 'Clarify the workflow goal', expectedRevision: revision }, req: {} as any, res: {} as any }) as Promise<any>;
    try {
      const result = await call(1); expect(result.operations).toHaveLength(1); expect(store.get(doc.id).document.description).not.toBe('Verified proposal');
      expect(run.mock.calls[0][4]).toMatchObject({ maxSteps: 1, maxToolCalls: 0 });
      store.update(doc.id, result.expectedRevision, result.operations); expect(store.get(doc.id).document.description).toBe('Verified proposal');
      await expect(call(1)).rejects.toThrow(/changed/);
      run.mockResolvedValueOnce({ text: JSON.stringify({ reply: 'Unsafe graph', operations: [{ type: 'put_edge', edge: { id: 'bad', source: 'missing', target: 'none', label: '' } }] }), truncated: false });
      await expect(call(2)).rejects.toThrow(/validated/);
      expect(store.get(doc.id).document.revision).toBe(2);
    } finally { db.close(); }
  });
});
