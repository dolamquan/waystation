import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyArchitectureOperations, starterWorkflow, validateArchitecture } from '../shared/architecture.ts';
import { ArchitectureStore } from '../daemon/architecture/store.ts';
import { TowerStore } from '../daemon/store/db.ts';
import { tempDir } from './helpers.ts';

describe('workflow graph integrity', () => {
  it('rejects malformed graphs, missing endpoints, duplicate identities, duplicate edges and unsafe coordinates', () => {
    const graph = starterWorkflow();
    for (const bad of [null, { ...graph, title: ' ' }, { ...graph, nodes: [...graph.nodes, graph.nodes[0]] }, { ...graph, nodes: [{ ...graph.nodes[0], x: Infinity }] }, { ...graph, edges: [{ ...graph.edges[0], target: 'missing' }] }, { ...graph, edges: [...graph.edges, { ...graph.edges[0], id: 'duplicate' }] }]) expect(() => validateArchitecture(bad)).toThrow();
  });
  it('atomically creates nodes and edges, allows feedback cycles, and cascades node removal', () => {
    const original = starterWorkflow();
    const next = applyArchitectureOperations(original, [
      { type: 'put_node', node: { id: 'approval', kind: 'approval', name: 'Review gate', description: 'A person approves.', x: 800, y: 400 } },
      { type: 'put_edge', edge: { id: 'gate', source: 'reviewer', target: 'approval', label: 'Review' } },
      { type: 'put_edge', edge: { id: 'retry', source: 'approval', target: 'builder', label: 'Needs revision' } },
    ]);
    expect(next.nodes).toHaveLength(5); expect(next.edges).toHaveLength(5); expect(original.nodes).toHaveLength(4);
    expect(() => applyArchitectureOperations(next, [{ type: 'remove_node', id: 'builder' }, { type: 'put_edge', edge: { id: 'bad', source: 'builder', target: 'reviewer', label: '' } }])).toThrow();
    const removed = applyArchitectureOperations(next, [{ type: 'remove_node', id: 'builder' }]);
    expect(removed.edges.some(e => e.source === 'builder' || e.target === 'builder')).toBe(false);
    expect(() => applyArchitectureOperations(next, [{ type: 'execute', command: 'anything' }])).toThrow();
  });
});

describe('persistent workflow revisions', () => {
  it('rejects stale edits without partial writes, preserves agent edits through restart, and supports undo/redo', () => {
    const project = tempDir('architecture-project-'); const dbFile = join(tempDir('architecture-db-'), 'state.db');
    let db = new TowerStore(dbFile); let store = new ArchitectureStore(db);
    try {
      const initial = store.create({ project, graph: 'starter' }); const id = initial.document.id;
      const changed = store.update(id, 1, [{ type: 'remove_node', id: 'reviewer' }], 'managed:architect');
      expect(changed.document.changedBy).toBe('managed:architect'); expect(changed.document.edges).toHaveLength(1);
      expect(() => store.update(id, 1, [{ type: 'remove_node', id: 'builder' }])).toThrow(/changed/);
      expect(() => store.update(id, 2, [{ type: 'remove_node', id: 'builder' }, { type: 'put_node', node: {} }])).toThrow();
      expect(store.get(id).document.revision).toBe(2); expect(store.get(id).document.nodes).toHaveLength(3);
      store.attach(id, 'managed:architect'); db.close(); db = new TowerStore(dbFile); store = new ArchitectureStore(db);
      expect(store.get(id).agentId).toBe('managed:architect'); expect(store.get(id).canUndo).toBe(true);
      const undo = store.history(id, 2, 'undo'); expect(undo.document.nodes).toHaveLength(4); expect(undo.document.revision).toBe(3);
      const redo = store.history(id, 3, 'redo'); expect(redo.document.nodes).toHaveLength(3); expect(redo.document.revision).toBe(4);
      store.history(id, 4, 'undo');
      expect(store.update(id, 5, [{ type: 'describe', title: 'New branch', description: '' }]).canRedo).toBe(false);
      expect(() => store.requireProject(id, tempDir('other-workflow-'))).toThrow(/another project/);
    } finally { db.close(); }
  });
});
