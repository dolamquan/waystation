import { useEffect, useState } from 'react';
import { request } from '../../api.ts';
import type { AgentCapability, AgentPlatformState } from '../../../../shared/agentPlatform.ts';
import type { ArchitectureNode, ArchitectureSnapshot } from '../../../../shared/architecture.ts';
import type { ToolConfig } from '../../../../shared/agentResources.ts';
import { Icon } from '../Icon.tsx';
import { StatusBadge } from './ArchitectureUI.tsx';
import { message } from './toolCatalog.ts';
import './add-tool.css';

const enc = encodeURIComponent;

const kindLabel = (cap: AgentCapability): string => {
  switch (cap.spec.kind) {
    case 'tavily': return 'Web search';
    case 'mcp': return `MCP · ${cap.spec.server}`;
    case 'tool': return 'Custom tool';
    case 'memory': return 'Memory';
    default: return 'Skill';
  }
};
const detailOf = (cap: AgentCapability): string => {
  switch (cap.spec.kind) {
    case 'tavily': return `web search · up to ${cap.spec.maxResults} results`;
    case 'mcp': return `${cap.spec.tools.length} tool${cap.spec.tools.length === 1 ? '' : 's'} · ${cap.spec.approval === 'always' ? 'asks before every call' : 'read-only tools run without asking'}`;
    case 'tool': return `${cap.spec.config.functionName} · ${cap.spec.config.readOnly === false ? 'asks before every call' : 'read-only'}`;
    default: return cap.description;
  }
};

interface Props {
  node: ArchitectureNode; documentId: string; project: string; revision: number;
  /** Tool steps linked to this agent on the canvas. */
  canvasTools: readonly ArchitectureNode[];
  /** Why adding is unavailable right now (e.g. unsaved changes), or undefined when it is available. */
  blockedReason?: string;
  notice?: string; onDismissNotice: () => void;
  onAddTool: () => void; onSnapshot: (snapshot: ArchitectureSnapshot) => void;
}

/** Everything this agent can call, from every source, with one way to add more. */
export function AgentToolList({ node, documentId, project, revision, canvasTools, blockedReason, notice, onDismissNotice, onAddTool, onSnapshot }: Props) {
  const [capabilities, setCapabilities] = useState<AgentCapability[]>(); const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const refs = node.capabilities ?? [];
  const refKey = refs.map(r => `${r.id}@${r.version}`).join(',');
  useEffect(() => {
    if (!refKey) return;
    let active = true;
    request<AgentPlatformState>('GET', `/api/agent-platform?project=${enc(project)}`).then(state => { if (active) { setCapabilities(state.capabilities); setLoadError(''); } }, e => { if (active) setLoadError(message(e)); });
    return () => { active = false; };
  }, [project, refKey]);

  const remove = async (key: string, body: Record<string, unknown>) => {
    setBusy(key); setError('');
    try { const result = await request<{ snapshot: ArchitectureSnapshot }>('POST', `/api/architectures/${enc(documentId)}/nodes/${enc(node.id)}/tools/remove`, { ...body, expectedRevision: revision }); onSnapshot(result.snapshot); }
    catch (e) { setError(message(e)); } finally { setBusy(''); }
  };
  const codeOn = !!node.runtime?.codeExecution;
  const total = refs.length + (codeOn ? 1 : 0) + canvasTools.length;

  return <section className="agent-tool-section" aria-labelledby={`tools-${node.id}`}>
    <header><h3 id={`tools-${node.id}`}>Tools this agent can use</h3>{total > 0 && <span className="platform-count">{total}</span>}
      <button type="button" className="btn btn-small btn-go" disabled={!!blockedReason} aria-describedby={blockedReason ? `tools-blocked-${node.id}` : undefined} onClick={onAddTool}><Icon name="plus" size={14} />Add tool</button></header>
    {blockedReason && <p className="platform-help" id={`tools-blocked-${node.id}`}>{blockedReason}</p>}
    {notice && <p className="platform-success add-tool-notice" role="status"><Icon name="check" size={14} /><span>{notice}</span><button type="button" className="icon-btn" aria-label="Dismiss" onClick={onDismissNotice}><Icon name="close" size={12} /></button></p>}
    {!total ? <p className="platform-help">This agent has no tools yet. Add one so it can search, call services or run code.</p>
      : <ul className="agent-tool-rows">
        {refs.map(ref => {
          const cap = capabilities?.find(c => c.id === ref.id);
          const name = cap?.name ?? (capabilities ? 'Missing capability' : 'Loading…');
          return <li key={ref.id}>
            <div><strong>{name}</strong>{cap && <StatusBadge>{kindLabel(cap)}</StatusBadge>}<span className="platform-version">v{ref.version}</span></div>
            <small>{cap ? detailOf(cap) : capabilities ? 'It was removed from Capabilities. Remove it here, or deploys will fail.' : ''}</small>
            <button type="button" className="btn btn-small btn-ghost" disabled={!!busy} aria-label={`Remove ${name}`} onClick={() => { void remove(ref.id, { capabilityId: ref.id }); }}>{busy === ref.id ? 'Removing…' : 'Remove'}</button>
          </li>;
        })}
        {codeOn && <li><div><strong>Run code</strong><StatusBadge>Code execution</StatusBadge></div><small>run_code · {node.runtime!.codeExecution!.language} in {node.runtime!.codeExecution!.backend === 'docker' ? 'a container' : 'an isolated interpreter'}</small>
          <button type="button" className="btn btn-small btn-ghost" disabled={!!busy} aria-label="Turn off code execution" onClick={() => { void remove('code', { codeExecution: true }); }}>{busy === 'code' ? 'Turning off…' : 'Turn off'}</button></li>}
        {canvasTools.map(tool => <li key={tool.id}><div><strong>{tool.name}</strong><StatusBadge>Connected on canvas</StatusBadge></div>
          <small>{(tool.config as ToolConfig | undefined)?.functionName ?? 'Not configured yet'} · to remove it, delete its link or the step on the canvas.</small></li>)}
      </ul>}
    {loadError && <p className="arch-error" role="alert">Could not load tool details: {loadError}</p>}
    {error && <p className="arch-error" role="alert">{error}</p>}
  </section>;
}
