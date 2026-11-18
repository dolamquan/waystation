import type { AgentRuntime } from './agentBrains.ts';
import { validateResource, type ResourceConfig } from './agentResources.ts';
import type { CapabilityRef } from './agentPlatform.ts';
import { validateSandbox } from './agentEvaluation.ts';
/** The graph is shared by the editor and the agent bridge; labels are data, never instructions. */
export const ARCHITECTURE_KINDS = ['input', 'agent', 'router', 'tool', 'memory', 'approval', 'output'] as const;
export type ArchitectureKind = typeof ARCHITECTURE_KINDS[number];
export interface ArchitectureNode {
  id: string; kind: ArchitectureKind; name: string; description: string; x: number; y: number;
  provider?: string; model?: string;
  runtime?: AgentRuntime;
  config?: ResourceConfig;
  capabilities?: CapabilityRef[];
}
export interface ArchitectureEdge { id: string; source: string; target: string; label: string; outcome?: 'approved' | 'rejected' }
export interface ArchitectureGraph { title: string; description: string; nodes: ArchitectureNode[]; edges: ArchitectureEdge[] }
export interface ArchitectureDocument extends ArchitectureGraph {
  id: string; project: string; revision: number; updatedAt: number; changedBy: string;
}
export type ArchitectureOperation =
  | { type: 'put_node'; node: ArchitectureNode }
  | { type: 'remove_node'; id: string }
  | { type: 'put_edge'; edge: ArchitectureEdge }
  | { type: 'remove_edge'; id: string }
  | { type: 'describe'; title: string; description: string };
export interface ArchitectureSnapshot { document: ArchitectureDocument; canUndo: boolean; canRedo: boolean; agentId?: string }

export function validateArchitecture(raw: unknown): ArchitectureGraph {
  const fail = (message: string): never => { throw new Error(message); };
  const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('Expected an object.');
  const text = (value: unknown, max: number, label: string, required = false): string => typeof value === 'string' && value.length <= max && (!required || !!value.trim()) ? value : fail(`${label} must be text${required ? ' and cannot be empty' : ''} (up to ${max} characters).`);
  const id = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : fail('Invalid graph id. Use letters, numbers, underscores or dashes.');
  const position = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10000 ? value : fail('Positions must be finite numbers between -10000 and 10000.');
  const data = obj(raw);
  if (!Array.isArray(data.nodes) || data.nodes.length > 200 || !Array.isArray(data.edges) || data.edges.length > 400) fail('A workflow supports up to 200 nodes and 400 connections.');
  const nodes = (data.nodes as unknown[]).map(raw => {
    const n = obj(raw);
    if (!ARCHITECTURE_KINDS.includes(n.kind as ArchitectureKind)) fail('Unknown workflow node kind.');
    let runtime: AgentRuntime | undefined;
    if (n.runtime !== undefined) {
      if (n.kind !== 'agent') fail('Only agent steps can have a runtime.');
      const r = obj(n.runtime);
      if (r.kind !== 'managed' && r.kind !== 'api') fail('Choose a coding runtime or an API brain.');
      if (!['chat-only', 'review-tools', 'configured-tools'].includes(String(r.policy))) fail('Choose a supported capability policy.');
      if (r.kind === 'managed' && r.policy === 'configured-tools') fail('Coding runtimes require review for tool access.');
      if (!Number.isInteger(r.maxOutputTokens) || (r.maxOutputTokens as number) < 64 || (r.maxOutputTokens as number) > 4096) fail('Output limit must be between 64 and 4096 tokens.');
      runtime = { kind: r.kind as AgentRuntime['kind'], policy: r.policy as AgentRuntime['policy'], maxOutputTokens: r.maxOutputTokens as number, ...(r.connectionId === undefined || r.connectionId === '' ? {} : { connectionId: id(r.connectionId) }), ...(r.maxSteps === undefined ? {} : { maxSteps: Number.isInteger(r.maxSteps) && (r.maxSteps as number) >= 1 && (r.maxSteps as number) <= 12 ? r.maxSteps as number : fail('Model turns must be between 1 and 12.') }), ...(r.maxToolCalls === undefined ? {} : { maxToolCalls: Number.isInteger(r.maxToolCalls) && (r.maxToolCalls as number) >= 0 && (r.maxToolCalls as number) <= 20 ? r.maxToolCalls as number : fail('Tool calls must be between 0 and 20.') }),
        ...(r.maxDurationSeconds === undefined ? {} : { maxDurationSeconds: Number.isInteger(r.maxDurationSeconds) && Number(r.maxDurationSeconds) >= 10 && Number(r.maxDurationSeconds) <= 3600 ? Number(r.maxDurationSeconds) : fail('Workflow timeout must be between 10 and 3600 seconds.') }),
        ...(r.maxWorkflowSteps === undefined ? {} : { maxWorkflowSteps: Number.isInteger(r.maxWorkflowSteps) && Number(r.maxWorkflowSteps) >= 1 && Number(r.maxWorkflowSteps) <= 100 ? Number(r.maxWorkflowSteps) : fail('Workflow steps must be between 1 and 100.') }),
        ...(r.maxTotalTokens === undefined ? {} : { maxTotalTokens: Number.isInteger(r.maxTotalTokens) && Number(r.maxTotalTokens) >= 256 && Number(r.maxTotalTokens) <= 1000000 ? Number(r.maxTotalTokens) : fail('Workflow token budget must be between 256 and 1000000.') }),
        ...(r.codeExecution === undefined || r.codeExecution === null ? {} : { codeExecution: r.kind === 'api' ? (() => { try { return validateSandbox(r.codeExecution); } catch (e) { return fail((e as Error).message); } })() : fail('Code execution is available to API agents. Coding runtimes already run code on the host with approvals.') }) };
    }
    let capabilities: CapabilityRef[] | undefined;
    if (n.capabilities !== undefined) {
      if (n.kind !== 'agent' || !Array.isArray(n.capabilities) || n.capabilities.length > 30) fail('Attach up to 30 capabilities to an agent.');
      capabilities = (n.capabilities as unknown[]).map(value => { const ref = obj(value); if (!Number.isInteger(ref.version) || (ref.version as number) < 1) fail('Select a saved capability version.'); return { id: id(ref.id), version: ref.version as number }; });
      if (new Set(capabilities.map(c => c.id)).size !== capabilities.length) fail('A capability can only be attached once.');
    }
    return { id: id(n.id), kind: n.kind as ArchitectureKind, name: text(n.name, 100, 'Node name', true), description: text(n.description, 8000, 'Node instructions'), x: position(n.x), y: position(n.y),
      ...(n.provider === undefined ? {} : { provider: text(n.provider, 100, 'Provider') }), ...(n.model === undefined ? {} : { model: text(n.model, 120, 'Model') }), ...(runtime ? { runtime } : {}), ...(capabilities ? { capabilities } : {}), ...(n.config === undefined ? {} : { config: validateResource(String(n.kind), n.config) }) };
  });
  const nodeIds = new Set(nodes.map(n => n.id));
  if (nodeIds.size !== nodes.length) fail('Node ids must be unique.');
  const edges = (data.edges as unknown[]).map(raw => {
    const e = obj(raw); const source = id(e.source); const target = id(e.target);
    if (!nodeIds.has(source) || !nodeIds.has(target)) fail('Every connection must reference existing nodes.');
    if (source === target) fail('Connect two different nodes.');
    if (e.outcome !== undefined && (!['approved', 'rejected'].includes(String(e.outcome)) || nodes.find(n => n.id === source)?.kind !== 'approval')) fail('An approval outcome belongs on a connection from an Approval step.');
    return { id: id(e.id), source, target, label: text(e.label, 200, 'Connection label'), ...(e.outcome === undefined ? {} : { outcome: e.outcome as 'approved' | 'rejected' }) };
  });
  if (new Set(edges.map(e => e.id)).size !== edges.length) fail('Connection ids must be unique.');
  if (new Set(edges.map(e => `${e.source}\0${e.target}`)).size !== edges.length) fail('These nodes are already connected.');
  return { title: text(data.title, 100, 'Workflow title', true), description: text(data.description, 8000, 'Workflow goal'), nodes, edges };
}

/** Apply to a copy, then validate once: batches are atomic and can refer to nodes added in the same batch. */
export function applyArchitectureOperations(graph: ArchitectureGraph, raw: unknown): ArchitectureGraph {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 500) throw new Error('Provide between 1 and 500 operations.');
  let next = structuredClone(graph);
  for (const op of raw as ArchitectureOperation[]) {
    if (!op || typeof op !== 'object') throw new Error('Invalid workflow operation.');
    switch (op.type) {
      case 'put_node': if (!op.node || typeof op.node !== 'object') throw new Error('A node is required.'); next.nodes = [...next.nodes.filter(n => n.id !== op.node.id), op.node]; break;
      case 'remove_node': if (!next.nodes.some(n => n.id === op.id)) throw new Error('Node not found.'); next.nodes = next.nodes.filter(n => n.id !== op.id); next.edges = next.edges.filter(e => e.source !== op.id && e.target !== op.id); break;
      case 'put_edge': if (!op.edge || typeof op.edge !== 'object') throw new Error('A connection is required.'); next.edges = [...next.edges.filter(e => e.id !== op.edge.id), op.edge]; break;
      case 'remove_edge': if (!next.edges.some(e => e.id === op.id)) throw new Error('Connection not found.'); next.edges = next.edges.filter(e => e.id !== op.id); break;
      case 'describe': next.title = op.title; next.description = op.description; break;
      default: throw new Error('Unknown workflow operation.');
    }
  }
  return validateArchitecture(next);
}

/**
 * The starter executes exactly as drawn: the agent drafts, a person reviews (an approval step the runtime pauses
 * on), then the result is delivered. Additional agent nodes can be connected for executable handoffs.
 */
export function starterWorkflow(): ArchitectureGraph {
  return { title: 'Agent workflow', description: 'One agent drafts the answer, a person reviews it, then it is delivered.', nodes: [
    { id: 'request', kind: 'input', name: 'User request', description: 'The task and its acceptance criteria.', x: 40, y: 180, config: { type: 'input', format: 'text' } },
    { id: 'builder', kind: 'agent', name: 'Agent', description: 'Answer the request accurately and completely. Use attached tools when they help, and say what you could not verify.', x: 300, y: 180 },
    { id: 'reviewer', kind: 'approval', name: 'Human review', description: 'A person checks the draft before it is delivered.', x: 560, y: 180, config: { type: 'approval', message: 'Review the draft for accuracy and completeness before it is delivered.', timeoutMinutes: 30 } },
    { id: 'response', kind: 'output', name: 'Final response', description: 'Return the reviewed response to the user.', x: 820, y: 180, config: { type: 'output', destination: 'dashboard', format: 'text' } },
  ], edges: [
    { id: 'request-builder', source: 'request', target: 'builder', label: 'Task' },
    { id: 'builder-reviewer', source: 'builder', target: 'reviewer', label: 'Draft' },
    { id: 'reviewer-response', source: 'reviewer', target: 'response', label: 'Approved' },
  ] };
}
