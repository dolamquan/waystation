import { describe, expect, test } from 'vitest';
import {
  applySketchOperations, componentNode, emptyPlanning, layeredTemplate, linkEnds, linkNode, objectAt, parsePlanning, planningBrief,
  sketchBounds, sketchForAgents, type PlanningDocument,
} from '../shared/sketch.ts';

const doc = (nodes: PlanningDocument['nodes']): PlanningDocument => ({ version: 1, title: 'Plan', nodes });

describe('parsePlanning', () => {
  test('accepts architecture components and connections', () => {
    const db = componentNode('database', { x: 100, y: 100 }, { id: 'db' });
    const api = componentNode('service', { x: 400, y: 100 }, { id: 'api' });
    const parsed = parsePlanning(JSON.parse(JSON.stringify(doc([db, api, linkNode('api', 'db', { id: 'l1', text: 'SQL' })]))));
    expect(parsed.nodes.map((n) => n.kind)).toEqual(['component', 'component', 'link']);
    expect(parsed.nodes[2]).toMatchObject({ from: 'api', to: 'db', text: 'SQL' });
  });

  test('rejects unknown component variants', () => {
    const bad = { ...componentNode('server', { x: 0, y: 0 }), variant: 'mainframe' };
    expect(() => parsePlanning(doc([bad as never]))).toThrow(/Components must be one of/);
  });

  test('drops connections whose ends are missing', () => {
    const a = componentNode('client', { x: 0, y: 0 }, { id: 'a' });
    expect(parsePlanning(doc([a, linkNode('a', 'gone')])).nodes).toHaveLength(1);
  });

  test('still reads boards saved before components existed', () => {
    const old = { version: 1, title: 'Old', nodes: [{ id: 'n', kind: 'note', text: 'hi', color: 'sand', x: 0, y: 0, width: 260, height: 220 }] };
    expect(parsePlanning(old).nodes[0]?.kind).toBe('note');
  });
});

describe('applySketchOperations', () => {
  test('adds components with agent ids, connects them in the same batch, and reports what it created', () => {
    const result = applySketchOperations(emptyPlanning(), [
      { type: 'add', node: { id: 'web', kind: 'component', variant: 'server', text: 'Web app' } },
      { type: 'add', node: { id: 'db', kind: 'component', variant: 'database', text: 'Postgres', x: 600, y: 0 } },
      { type: 'connect', from: 'web', to: 'db', label: 'SQL' },
      { type: 'title', title: 'Checkout' },
    ]);
    expect(result.doc.title).toBe('Checkout');
    expect(result.created.slice(0, 2)).toEqual(['web', 'db']);
    expect(result.doc.nodes.find((n) => n.id === 'db')).toMatchObject({ x: 600, y: 0, text: 'Postgres' });
    expect(result.doc.nodes.find((n) => n.kind === 'link')).toMatchObject({ from: 'web', to: 'db', text: 'SQL' });
  });

  test('places objects without a position below the existing content, side by side', () => {
    const start = doc([componentNode('client', { x: 48, y: 52 }, { id: 'c' })]);
    const { doc: next } = applySketchOperations(start, [
      { type: 'add', node: { id: 'a', kind: 'component', variant: 'service' } },
      { type: 'add', node: { id: 'b', kind: 'component', variant: 'service' } },
    ]);
    const [a, b] = ['a', 'b'].map((id) => next.nodes.find((n) => n.id === id)!);
    expect(a.y).toBeGreaterThan(104);
    expect(b.x).toBeGreaterThan(a.x + a.width);
  });

  test('removing an object removes its connections', () => {
    const start = doc([componentNode('client', { x: 0, y: 0 }, { id: 'a' }), componentNode('server', { x: 300, y: 0 }, { id: 'b' }), linkNode('a', 'b', { id: 'l' })]);
    expect(applySketchOperations(start, [{ type: 'remove', id: 'b' }]).doc.nodes.map((n) => n.id)).toEqual(['a']);
  });

  test('updates fields and rejects the whole batch when one edit is invalid', () => {
    const start = doc([componentNode('server', { x: 0, y: 0 }, { id: 's' })]);
    expect(applySketchOperations(start, [{ type: 'update', id: 's', text: 'API', variant: 'gateway', x: 10 }]).doc.nodes[0])
      .toMatchObject({ text: 'API', variant: 'gateway', x: 10 });
    expect(() => applySketchOperations(start, [{ type: 'update', id: 's', text: 'ok' }, { type: 'connect', from: 's', to: 'missing' }])).toThrow(/No object/);
    expect(() => applySketchOperations(start, [{ type: 'add', node: { id: 's', kind: 'note' } }])).toThrow(/already used/);
    expect(() => applySketchOperations(start, [])).toThrow(/between 1 and 200/);
  });
});

describe('geometry', () => {
  test('connections run edge to edge, so they follow the objects', () => {
    const { start, end } = linkEnds({ x: 0, y: 0, width: 100, height: 100 }, { x: 300, y: 0, width: 100, height: 100 });
    expect(start).toEqual({ x: 100, y: 50 });
    expect(end).toEqual({ x: 300, y: 50 });
  });

  test('the smallest object under the pointer wins, so a service inside a layer is picked over the layer', () => {
    const layer = componentNode('layer', { x: 200, y: 200 }, { id: 'layer' });
    const service = componentNode('service', { x: 200, y: 200 }, { id: 'svc' });
    expect(objectAt([layer, service], { x: 200, y: 200 })?.id).toBe('svc');
    expect(objectAt([layer, service], { x: layer.x + 5, y: layer.y + 5 })?.id).toBe('layer');
  });

  test('bounds ignore connections', () => {
    const a = componentNode('client', { x: 1000, y: 1000 }, { id: 'a' }), b = componentNode('client', { x: 1200, y: 1000 }, { id: 'b' });
    expect(sketchBounds([a, b, linkNode('a', 'b')])!.x).toBe(a.x);
  });
});

test('the layered template is a valid board with layers, services and connections', () => {
  const nodes = layeredTemplate({ x: 0, y: 0 });
  const parsed = parsePlanning(JSON.parse(JSON.stringify(doc(nodes))));
  expect(parsed.nodes).toHaveLength(nodes.length);
  expect(parsed.nodes.filter((n) => n.variant === 'layer').map((n) => n.text)).toEqual(['Frontend', 'Backend']);
  expect(parsed.nodes.filter((n) => n.kind === 'link')).toHaveLength(6);
});

test('briefs describe components, what layer they sit in, and connections by name', () => {
  const nodes = layeredTemplate({ x: 0, y: 0 });
  const brief = planningBrief(doc(nodes), nodes);
  expect(brief).toMatch(/service: Order service \[in Backend\]/);
  expect(brief).toMatch(/connection: Logic → Database \(SQL\)/);
});

test('agents read the sketch without embedded image data', () => {
  const image = { id: 'i', kind: 'image' as const, text: 'diagram', color: 'sand' as const, x: 0, y: 0, width: 10, height: 10, src: 'data:image/png;base64,AAAA' };
  expect(sketchForAgents(doc([image])).nodes[0]).not.toHaveProperty('src');
});
