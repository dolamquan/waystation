import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WaystationAutomation } from '../daemon/automation/automation.ts';
import { SketchStore } from '../daemon/sketch/sketchStore.ts';
import { TowerStore } from '../daemon/store/db.ts';
import { folder } from '../web/src/stationOffices.ts';
import { emptyPlanning } from '../shared/sketch.ts';
import { tempDir } from './helpers.ts';

const host = { agents: () => [], consoles: () => [] };

describe('sketch store', () => {
  it('starts empty, saves board sketches by revision, refuses stale saves and survives a restart', () => {
    const dbFile = join(tempDir('sketch-db-'), 'state.db');
    let db = new TowerStore(dbFile);
    try {
      const store = new SketchStore(db);
      expect(store.get('folder:c:/app')).toMatchObject({ revision: 0, doc: emptyPlanning() });
      const saved = store.replace('folder:c:/app', { ...emptyPlanning(), title: 'Board' }, 0);
      expect(saved.revision).toBe(1);
      expect(() => store.replace('folder:c:/app', emptyPlanning(), 0)).toThrow(/changed since you read it/);
      expect(() => store.replace('all', emptyPlanning(), 0)).toThrow(/project canvas/);
      expect(() => store.replace('folder:c:/app', { version: 1, nodes: 'x' }, 1)).toThrow();
      db.close(); db = new TowerStore(dbFile);
      expect(new SketchStore(db).get('folder:c:/app')).toMatchObject({ revision: 1, doc: { title: 'Board' } });
    } finally { db.close(); }
  });
});

describe('sketch MCP tools', () => {
  it('lets an agent read and draw on its project sketch, with revision checks', async () => {
    const project = tempDir('sketch-project-');
    const db = new TowerStore(join(tempDir('sketch-db-'), 'state.db'));
    try {
      const automation = new WaystationAutomation(db);
      const grant = automation.authenticate(automation.token);
      expect(automation.toolsFor(grant).map((tool) => tool.name)).toEqual(expect.arrayContaining(['get_sketch', 'update_sketch']));

      const empty = await automation.call('get_sketch', { project }, grant, host) as { revision: number; components: unknown[] };
      expect(empty.revision).toBe(0);
      expect(empty.components.length).toBeGreaterThan(5);

      const drawn = await automation.call('update_sketch', { project, expectedRevision: 0, operations: [
        { type: 'add', node: { id: 'api', kind: 'component', variant: 'service', text: 'Orders API' } },
        { type: 'add', node: { id: 'db', kind: 'component', variant: 'database', text: 'Postgres' } },
        { type: 'connect', from: 'api', to: 'db', label: 'SQL' },
      ] }, grant, host) as { revision: number; created: string[] };
      expect(drawn.revision).toBe(1);
      expect(drawn.created.slice(0, 2)).toEqual(['api', 'db']);

      // The board sees the agent's drawing under the same project key it uses for the canvas.
      const board = automation.sketches.get(folder(project)!.key);
      expect(board.changedBy).toBe('external');
      expect(board.doc.nodes.map((node) => node.kind)).toEqual(['component', 'component', 'link']);

      const read = await automation.call('get_sketch', { project }, grant, host) as { summary: string };
      expect(read.summary).toMatch(/connection: Orders API → Postgres \(SQL\)/);
      await expect(automation.call('update_sketch', { project, expectedRevision: 0, operations: [{ type: 'remove', id: 'db' }] }, grant, host)).rejects.toThrow(/changed since/);
      await expect(automation.call('update_sketch', { project, expectedRevision: 1, operations: [{ type: 'connect', from: 'api', to: 'nope' }] }, grant, host)).rejects.toThrow(/No object/);
      expect(automation.sketches.get(folder(project)!.key).revision).toBe(1);
    } finally { db.close(); }
  });
});
