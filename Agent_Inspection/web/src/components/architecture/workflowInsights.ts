import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode } from '../../../../shared/architecture.ts';

/** Canvas geometry shared by the editor, minimap and auto-layout. */
export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 86;
export const GRID = 20;
const COLUMN_GAP = 280;
const ROW_GAP = 140;
const LAYOUT_ORIGIN = { x: 40, y: 40 };

export type WorkflowIssue = {
  readonly id: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly nodeId?: string;
};

const snap = (value: number) => Math.round(value / GRID) * GRID;

/** Longest-path layering from entry steps; edges that close a cycle are ignored so feedback loops still lay out. */
export function layoutWorkflow(nodes: readonly ArchitectureNode[], edges: readonly ArchitectureEdge[]): Map<string, { x: number; y: number }> {
  const ids = new Set(nodes.map(n => n.id));
  const outgoing = new Map<string, string[]>(nodes.map(n => [n.id, []]));
  for (const e of edges) if (ids.has(e.source) && ids.has(e.target) && e.source !== e.target) outgoing.get(e.source)!.push(e.target);

  const forward = new Map<string, string[]>(nodes.map(n => [n.id, []]));
  const state = new Map<string, 'open' | 'done'>();
  const ordered = [...nodes].sort((a, b) => entryRank(a) - entryRank(b) || a.x - b.x || a.y - b.y);
  const visit = (id: string) => {
    state.set(id, 'open');
    for (const next of outgoing.get(id)!) {
      if (state.get(next) === 'open') continue; // back edge: part of a loop
      forward.get(id)!.push(next);
      if (!state.has(next)) visit(next);
    }
    state.set(id, 'done');
  };
  for (const n of ordered) if (!state.has(n.id)) visit(n.id);

  const layer = new Map<string, number>(nodes.map(n => [n.id, 0]));
  const indegree = new Map<string, number>(nodes.map(n => [n.id, 0]));
  for (const targets of forward.values()) for (const t of targets) indegree.set(t, indegree.get(t)! + 1);
  const queue = ordered.filter(n => indegree.get(n.id) === 0).map(n => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const t of forward.get(id)!) {
      layer.set(t, Math.max(layer.get(t)!, layer.get(id)! + 1));
      indegree.set(t, indegree.get(t)! - 1);
      if (indegree.get(t) === 0) queue.push(t);
    }
  }

  // Unconnected steps would crowd column 0; park them in a row beneath the flow instead.
  const connected = new Set([...forward.entries()].flatMap(([s, targets]) => targets.length ? [s, ...targets] : []));
  const columns = new Map<number, ArchitectureNode[]>();
  for (const n of ordered) if (connected.has(n.id)) { const l = layer.get(n.id)!; columns.set(l, [...(columns.get(l) ?? []), n]); }
  const tallest = Math.max(0, ...[...columns.values()].map(c => c.length));
  const positions = new Map<string, { x: number; y: number }>();
  for (const [l, column] of columns) {
    const sorted = [...column].sort((a, b) => a.y - b.y);
    const offset = ((tallest - sorted.length) * ROW_GAP) / 2;
    sorted.forEach((n, row) => positions.set(n.id, { x: snap(LAYOUT_ORIGIN.x + l * COLUMN_GAP), y: snap(LAYOUT_ORIGIN.y + offset + row * ROW_GAP) }));
  }
  const parkedY = LAYOUT_ORIGIN.y + tallest * ROW_GAP + (tallest ? ROW_GAP / 2 : 0);
  ordered.filter(n => !connected.has(n.id)).forEach((n, i) => positions.set(n.id, { x: snap(LAYOUT_ORIGIN.x + i * (NODE_WIDTH + 60)), y: snap(parkedY) }));
  return positions;
}

const entryRank = (n: ArchitectureNode) => n.kind === 'input' ? 0 : n.kind === 'output' ? 2 : 1;

/** Copy a step next to the original. Ids are supplied by the caller so the function stays deterministic. */
export function duplicateNode(node: ArchitectureNode, id: string): ArchitectureNode {
  const name = `${node.name} copy`.slice(0, 100);
  return { ...node, id, name, x: snap(node.x + 40), y: snap(node.y + NODE_HEIGHT + 48) };
}

/** Steps and connections directly attached to a step, for highlighting its neighbourhood. */
export function neighbourhood(edges: readonly ArchitectureEdge[], id: string | undefined): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>(); const linked = new Set<string>();
  if (!id) return { nodes, edges: linked };
  const isEdge = edges.some(e => e.id === id);
  if (!isEdge) nodes.add(id);
  for (const e of edges) {
    if (e.id === id || e.source === id || e.target === id) { nodes.add(e.source); nodes.add(e.target); linked.add(e.id); }
  }
  return { nodes, edges: linked };
}

const reachable = (starts: readonly string[], edges: readonly ArchitectureEdge[]): Set<string> => {
  const seen = new Set(starts); const queue = [...starts];
  while (queue.length) { const id = queue.shift()!; for (const e of edges) if (e.source === id && !seen.has(e.target)) { seen.add(e.target); queue.push(e.target); } }
  return seen;
};

/** Labels describe edges; typed approval outcomes and router rules select execution paths. */
export const AGENT_EDGE_MESSAGE = 'Agent handoffs execute using the source response as the next agent’s task. Loops stop at the entry agent’s workflow step limit.';

/** Design-time checks. They describe the graph; they never block saving. */
export function checkWorkflow(graph: Pick<ArchitectureGraph, 'nodes' | 'edges'>): WorkflowIssue[] {
  const { nodes, edges } = graph;
  if (!nodes.length) return [{ id: 'empty', severity: 'info', message: 'Add a first step to start the workflow.' }];
  const issues: WorkflowIssue[] = [];
  const inputs = nodes.filter(n => n.kind === 'input');
  if (!inputs.length) issues.push({ id: 'no-input', severity: 'info', message: 'No Input step: choose an entry agent when starting the workflow.' });
  if (!nodes.some(n => n.kind === 'output')) issues.push({ id: 'no-output', severity: 'info', message: 'No Output step: the response is retained in run activity.' });
  const linked = new Set(edges.flatMap(e => [e.source, e.target]));
  const fromInputs = inputs.length ? reachable(inputs.map(n => n.id), edges) : undefined;
  for (const n of nodes) {
    if (nodes.length > 1 && !linked.has(n.id)) issues.push({ id: `isolated-${n.id}`, severity: 'warning', nodeId: n.id, message: `${n.name} is not connected to anything.` });
    else if (fromInputs && n.kind === 'output' && !fromInputs.has(n.id)) issues.push({ id: `unreached-${n.id}`, severity: 'error', nodeId: n.id, message: `${n.name} can't be reached from an Input step.` });
    if (n.kind === 'agent') {
      if (!n.description.trim()) issues.push({ id: `instructions-${n.id}`, severity: 'warning', nodeId: n.id, message: `${n.name} has no role or instructions.` });
      if (!n.runtime) issues.push({ id: `brain-${n.id}`, severity: 'info', nodeId: n.id, message: `${n.name} has no saved brain yet, so it can't run.` });
    } else if (!n.config) issues.push({ id: `config-${n.id}`, severity: 'info', nodeId: n.id, message: `${n.name} needs configuration before runs can use it.` });
  }
  const kindOf = new Map(nodes.map(n => [n.id, n.kind]));
  for (const e of edges) {
    if (kindOf.get(e.source) === 'agent' && kindOf.get(e.target) === 'agent' && !nodes.find(n => n.id === e.target)?.runtime) issues.push({ id: `agent-edge-${e.id}`, severity: 'error', nodeId: e.target, message: 'Save a brain for this downstream agent before running the workflow.' });
  }
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Bounding box of all steps in canvas coordinates. */
export function graphBounds(nodes: readonly Pick<ArchitectureNode, 'x' | 'y'>[]): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  if (!nodes.length) return undefined;
  return {
    minX: Math.min(...nodes.map(n => n.x)), minY: Math.min(...nodes.map(n => n.y)),
    maxX: Math.max(...nodes.map(n => n.x + NODE_WIDTH)), maxY: Math.max(...nodes.map(n => n.y + NODE_HEIGHT)),
  };
}

/** Case-insensitive match on name, kind or description. */
export function findSteps(nodes: readonly ArchitectureNode[], query: string): ArchitectureNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return nodes.filter(n => n.name.toLowerCase().includes(q) || n.kind.includes(q) || n.description.toLowerCase().includes(q));
}
