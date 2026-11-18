import { describe, expect, it } from 'vitest';
import type { ArchitectureEdge, ArchitectureNode } from '../shared/architecture.ts';
import { AGENT_EDGE_MESSAGE, checkWorkflow, duplicateNode, findSteps, graphBounds, layoutWorkflow, neighbourhood, NODE_HEIGHT, NODE_WIDTH } from '../web/src/components/architecture/workflowInsights.ts';

const node = (id: string, kind: ArchitectureNode['kind'], extra: Partial<ArchitectureNode> = {}): ArchitectureNode => ({ id, kind, name: id, description: '', x: 0, y: 0, ...extra });
const edge = (source: string, target: string): ArchitectureEdge => ({ id: `${source}-${target}`, source, target, label: '' });

describe('layoutWorkflow', () => {
  it('places each step one column after its predecessor', () => {
    const nodes = [node('out', 'output'), node('a', 'agent'), node('in', 'input')];
    const positions = layoutWorkflow(nodes, [edge('in', 'a'), edge('a', 'out')]);
    expect(positions.get('in')!.x).toBeLessThan(positions.get('a')!.x);
    expect(positions.get('a')!.x).toBeLessThan(positions.get('out')!.x);
  });

  it('stacks parallel branches in the same column without overlap', () => {
    const nodes = [node('in', 'input'), node('a', 'agent'), node('b', 'agent')];
    const positions = layoutWorkflow(nodes, [edge('in', 'a'), edge('in', 'b')]);
    expect(positions.get('a')!.x).toBe(positions.get('b')!.x);
    expect(Math.abs(positions.get('a')!.y - positions.get('b')!.y)).toBeGreaterThanOrEqual(NODE_HEIGHT);
  });

  it('parks unconnected steps in a row below the flow', () => {
    const nodes = [node('in', 'input'), node('a', 'agent'), node('lonely', 'tool'), node('other', 'memory')];
    const positions = layoutWorkflow(nodes, [edge('in', 'a')]);
    const flowBottom = Math.max(positions.get('in')!.y, positions.get('a')!.y) + NODE_HEIGHT;
    expect(positions.get('lonely')!.y).toBeGreaterThan(flowBottom);
    expect(positions.get('lonely')!.y).toBe(positions.get('other')!.y);
    expect(positions.get('lonely')!.x).not.toBe(positions.get('other')!.x);
  });

  it('terminates on feedback loops and positions every step on the grid', () => {
    const nodes = [node('in', 'input'), node('a', 'agent'), node('r', 'agent')];
    const positions = layoutWorkflow(nodes, [edge('in', 'a'), edge('a', 'r'), edge('r', 'a')]);
    expect(positions.size).toBe(3);
    for (const p of positions.values()) { expect(p.x % 20).toBe(0); expect(p.y % 20).toBe(0); }
    expect(positions.get('a')!.x).toBeLessThan(positions.get('r')!.x);
  });
});

describe('checkWorkflow', () => {
  it('reports a missing input and output', () => {
    const ids = checkWorkflow({ nodes: [node('a', 'agent', { description: 'x' })], edges: [] }).map(i => i.id);
    expect(ids).toContain('no-input');
    expect(ids).toContain('no-output');
  });

  it('flags isolated steps, unreachable outputs and unconfigured agents', () => {
    const nodes = [node('in', 'input', { config: { type: 'input', format: 'text' } }), node('a', 'agent'), node('out', 'output'), node('lonely', 'tool')];
    const issues = checkWorkflow({ nodes, edges: [edge('in', 'a'), edge('out', 'a')] });
    const ids = issues.map(i => i.id);
    expect(ids).toContain('isolated-lonely');
    expect(ids).toContain('unreached-out');
    expect(ids).toContain('instructions-a');
    expect(ids).toContain('brain-a');
    expect(issues[0]!.severity).toBe('error');
  });

  it('requires downstream handoff agents to have a saved brain', () => {
    const nodes = [node('in', 'input'), node('a', 'agent', { description: 'x' }), node('b', 'agent', { description: 'y' }), node('t', 'tool')];
    const issues = checkWorkflow({ nodes, edges: [edge('in', 'a'), edge('a', 'b'), edge('a', 't')] });
    const agentEdges = issues.filter(i => i.id.startsWith('agent-edge-'));
    expect(agentEdges).toEqual([{ id: 'agent-edge-a-b', severity: 'error', nodeId: 'b', message: 'Save a brain for this downstream agent before running the workflow.' }]);
    expect(AGENT_EDGE_MESSAGE).toContain('execute');
  });

  it('does not warn about edges between agents and other step kinds', () => {
    const nodes = [node('in', 'input'), node('a', 'agent', { description: 'x' }), node('r', 'approval'), node('out', 'output')];
    const issues = checkWorkflow({ nodes, edges: [edge('in', 'a'), edge('a', 'r'), edge('r', 'out')] });
    expect(issues.some(i => i.id.startsWith('agent-edge-'))).toBe(false);
  });

  it('returns a single hint for an empty workflow', () => {
    expect(checkWorkflow({ nodes: [], edges: [] })).toEqual([expect.objectContaining({ id: 'empty' })]);
  });
});

describe('helpers', () => {
  it('duplicates without mutating and offsets the copy', () => {
    const original = node('a', 'agent', { x: 100, y: 100, name: 'Writer' });
    const copy = duplicateNode(original, 'b');
    expect(copy).toMatchObject({ id: 'b', name: 'Writer copy', kind: 'agent' });
    expect(copy.y).toBeGreaterThan(original.y);
    expect(original.id).toBe('a');
  });

  it('collects the neighbourhood of a step or a connection', () => {
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('x', 'y')];
    expect([...neighbourhood(edges, 'b').nodes].sort()).toEqual(['a', 'b', 'c']);
    expect([...neighbourhood(edges, 'x-y').nodes].sort()).toEqual(['x', 'y']);
    expect(neighbourhood(edges, undefined).nodes.size).toBe(0);
  });

  it('computes bounds and finds steps by name, kind or description', () => {
    const nodes = [node('a', 'agent', { x: 10, y: 20, name: 'Researcher' }), node('m', 'memory', { x: 300, y: 400, description: 'Shared notes' })];
    expect(graphBounds(nodes)).toEqual({ minX: 10, minY: 20, maxX: 300 + NODE_WIDTH, maxY: 400 + NODE_HEIGHT });
    expect(graphBounds([])).toBeUndefined();
    expect(findSteps(nodes, 'research').map(n => n.id)).toEqual(['a']);
    expect(findSteps(nodes, 'memory').map(n => n.id)).toEqual(['m']);
    expect(findSteps(nodes, 'notes').map(n => n.id)).toEqual(['m']);
    expect(findSteps(nodes, '  ')).toEqual([]);
  });
});
