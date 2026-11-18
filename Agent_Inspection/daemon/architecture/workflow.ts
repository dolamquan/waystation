import type { ArchitectureDocument, ArchitectureNode } from '../../shared/architecture.ts';
import type { WorkflowStep } from '../../shared/agentRuns.ts';
import { LibraryInputError } from '../library/types.ts';
import { routeResult } from './resources.ts';

const CONTROL = new Set(['agent', 'approval', 'router', 'output']);
export function assertWorkflowReady(doc: ArchitectureDocument, entry: string): void {
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return; seen.add(id);
    const node = doc.nodes.find(n => n.id === id); if (!node || !CONTROL.has(node.kind)) return;
    if (node.kind === 'agent' ? !node.runtime || !node.description.trim() : !node.config) throw new LibraryInputError(`Configure “${node.name}” before running the workflow.`);
    if (process.env.WAYSTATION_HOSTED === '1' && node.runtime?.kind === 'managed') throw new LibraryInputError('Hosted workflows require API brains. Native coding runtimes must run in a separately managed private worker.');
    if (node.config?.type === 'router') {
      const targets = [...node.config.rules.map(r => r.target), node.config.fallback].filter(Boolean);
      if (!targets.length || targets.some(target => !doc.edges.some(e => e.source === id && e.target === target && CONTROL.has(doc.nodes.find(n => n.id === target)?.kind ?? '')))) throw new LibraryInputError(`Connect every routing destination for “${node.name}” before running.`);
    }
    if (node.kind !== 'output') for (const edge of doc.edges.filter(e => e.source === id)) visit(edge.target);
  };
  visit(entry);
}
export function workflowAgents(doc: ArchitectureDocument, entry: string): ArchitectureNode[] {
  const visited = new Set<string>(); const agents: ArchitectureNode[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) return; visited.add(id);
    const node = doc.nodes.find(n => n.id === id); if (!node || !CONTROL.has(node.kind)) return;
    if (node.kind === 'agent') agents.push(node);
    if (node.kind !== 'output') for (const edge of doc.edges.filter(e => e.source === id)) visit(edge.target);
  };
  visit(entry); return agents;
}

export function workflowEntry(doc: ArchitectureDocument, requested?: string): string {
  if (requested) { if (!doc.nodes.some(n => n.id === requested && n.kind === 'agent')) throw new LibraryInputError('Choose an agent as the workflow entry.'); return requested; }
  const inputs = new Set(doc.nodes.filter(n => n.kind === 'input').map(n => n.id));
  const fromInputs = doc.nodes.filter(n => n.kind === 'agent' && doc.edges.some(e => inputs.has(e.source) && e.target === n.id));
  const roots = fromInputs.length ? fromInputs : doc.nodes.filter(n => n.kind === 'agent' && !doc.edges.some(e => e.target === n.id && CONTROL.has(doc.nodes.find(p => p.id === e.source)?.kind ?? '')));
  if (roots.length !== 1) throw new LibraryInputError('Choose one entry agent. The workflow has multiple entry points or a loop.');
  return roots[0].id;
}

export interface WorkflowHandlers {
  signal: AbortSignal;
  step: (node: ArchitectureNode, input: string, execute: (operationId: string) => Promise<string>, kind?: WorkflowStep['kind']) => Promise<string>;
  agent: (node: ArchitectureNode, input: string) => Promise<string>;
  approve: (node: ArchitectureNode, output: string) => Promise<boolean>;
  deliver: (node: ArchitectureNode, output: string, operationId: string) => Promise<void>;
  remember: (agent: ArchitectureNode, memory: ArchitectureNode, input: string, output: string, operationId: string) => Promise<void>;
}

/** Ordered branches execute independently; a shared downstream node is invoked once per incoming branch.
 * Cycles are allowed, but the durable step budget bounds every traversal. Tools/memory edges attach resources.
 */
export async function executeWorkflow(doc: ArchitectureDocument, entry: string, input: string, h: WorkflowHandlers): Promise<string> {
  const outgoing = (id: string) => doc.edges.filter(e => e.source === id && CONTROL.has(doc.nodes.find(n => n.id === e.target)?.kind ?? ''));
  const visit = async (nodeId: string, value: string): Promise<string> => {
    h.signal.throwIfAborted();
    const node = doc.nodes.find(n => n.id === nodeId)!;
    let output = value;
    if (node.kind === 'agent') {
      output = await h.step(node, value, () => h.agent(node, value));
      const memories = new Set(doc.edges.flatMap(e => e.source === node.id ? [e.target] : e.target === node.id ? [e.source] : []));
      for (const memory of doc.nodes.filter(n => n.kind === 'memory' && memories.has(n.id))) {
        await h.step(memory, JSON.stringify({ agent: node.id, input: value, output }), async operationId => { await h.remember(node, memory, value, output, operationId); return ''; });
      }
    } else if (node.kind === 'output') {
      await h.step(node, value, async operationId => { await h.deliver(node, value, operationId); return value; });
      return value;
    } else if (node.kind === 'approval') {
      const outcome = await h.step(node, value, async () => await h.approve(node, value) ? 'approved' : 'rejected');
      const routes = outgoing(node.id).filter(e => (e.outcome ?? 'approved') === outcome);
      if (outcome === 'rejected' && !routes.length) throw new LibraryInputError(`Approval “${node.name}” was rejected or expired. Add a Rejected connection to handle rejection.`);
      for (const edge of routes) output = await visit(edge.target, value);
      return output;
    } else if (node.kind === 'router') {
      const target = await h.step(node, value, async () => {
        if (node.config?.type !== 'router') throw new LibraryInputError(`Configure router “${node.name}” first.`);
        let parsed: unknown = value; try { parsed = JSON.parse(value.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* Text routing is supported. */ }
        return routeResult(node.config, parsed);
      });
      if (!target || !outgoing(node.id).some(e => e.target === target)) throw new LibraryInputError(`Router “${node.name}” has no connected destination for this result.`);
      return visit(target, value);
    }
    const sourceOutput = output;
    for (const edge of outgoing(node.id)) output = await visit(edge.target, sourceOutput);
    return output;
  };
  return visit(entry, input);
}
