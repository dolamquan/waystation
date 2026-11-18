import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { request } from '../../api.ts';
import type { ArchitectureNode, ArchitectureSnapshot } from '../../../../shared/architecture.ts';
import { Modal } from '../Modal.tsx';
import { Icon } from '../Icon.tsx';
import { AddMcpTool } from './AddMcpTool.tsx';
import { DescribeTool } from './DescribeTool.tsx';
import { AddRunCode, AddSearchTool } from './AddSearchTool.tsx';
import { isAbort, loadCatalog, message, toolsUrl, type AddToolResult, type ToolCatalog } from './toolCatalog.ts';
import './add-tool.css';

type Flow = 'search' | 'mcp' | 'describe' | 'code';
type IconName = ComponentProps<typeof Icon>['name'];
const FLOW_TITLE: Record<Flow, string> = { search: 'Search the web', mcp: 'Connect an MCP server', describe: 'Describe a tool', code: 'Run code' };

export interface AddToolDialogProps {
  documentId: string; project: string; node: ArchitectureNode;
  /** Reads the editor's latest revision at submit time, so a poll that landed while the dialog was open never causes a false conflict. */
  revision: () => number;
  onAdded: (snapshot: ArchitectureSnapshot, message: string) => void;
  onClose: () => void;
  /** Experts: open the manual tool editor in Capabilities. */
  onAdvanced: () => void;
  /** Where model connections are added (for the "Describe a tool" writer). */
  onManageConnections: () => void;
}

/** One place to give an agent a tool. Each choice ends in a single call that creates, attaches and enables it. */
export function AddToolDialog({ documentId, project, node, revision, onAdded, onClose, onAdvanced, onManageConnections }: AddToolDialogProps) {
  const [flow, setFlow] = useState<Flow>();
  const content = useRef<HTMLDivElement>(null);
  // Moving between screens unmounts the button that had focus; put focus at the start of the new screen instead.
  const [catalog, setCatalog] = useState<ToolCatalog>(); const [catalogError, setCatalogError] = useState(''); const [attempt, setAttempt] = useState(0);
  const loaded = !!catalog;
  useEffect(() => {
    if (!loaded) return;
    const root = content.current;
    (root?.querySelector<HTMLElement>('[data-autofocus]') ?? root?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])'))?.focus();
  }, [flow, loaded]);
  useEffect(() => {
    const controller = new AbortController(); setCatalogError('');
    loadCatalog(project, controller.signal).then(setCatalog, e => { if (!isAbort(e)) setCatalogError(message(e)); });
    return () => controller.abort();
  }, [project, attempt]);

  const addTool = useCallback(async (body: Record<string, unknown>) => {
    const result = await request<AddToolResult>('POST', toolsUrl(documentId, node.id), { ...body, expectedRevision: revision() });
    onAdded(result.snapshot, result.message);
  }, [documentId, node.id, revision, onAdded]);

  const isApi = node.runtime?.kind === 'api';
  const codeOn = !!node.runtime?.codeExecution;
  const agentName = node.name || 'this agent';
  const title = flow ? FLOW_TITLE[flow] : `Add a tool to ${agentName}`;

  const body = !node.runtime ? <p className="arch-error" role="alert">Choose a brain for {agentName} and save it before adding tools.</p>
    : catalogError ? <div className="arch-error" role="alert">{catalogError}<button type="button" className="btn btn-small" onClick={() => setAttempt(n => n + 1)}>Try again</button></div>
    : !catalog ? <p role="status" className="platform-help">Loading tool options…</p>
    : flow === 'mcp' ? <AddMcpTool catalog={catalog} project={project} agentName={agentName} addTool={addTool} />
    : flow === 'describe' ? <DescribeTool project={project} writers={catalog.writers} agentName={agentName} addTool={addTool} onManageConnections={onManageConnections} />
    : flow === 'search' ? <AddSearchTool connections={catalog.searchConnections} agentName={agentName} addTool={addTool} />
    : flow === 'code' ? <AddRunCode agentName={agentName} addTool={addTool} />
    : <div className="add-tool-choices">
      <ChoiceCard icon="search" title="Search the web" onPick={() => setFlow('search')}>Tavily search with your API key. Results come back with sources.</ChoiceCard>
      <ChoiceCard icon="link" title="Connect an MCP server" onPick={() => setFlow('mcp')}>GitHub, Context7, DeepWiki and more. Pick which of its tools the agent may use.</ChoiceCard>
      <ChoiceCard icon="sparkle" title="Describe a tool" onPick={() => setFlow('describe')}>Say what it should do. A model writes it, tests it, and shows you before adding.</ChoiceCard>
      <ChoiceCard icon="terminal" title="Run code" onPick={() => setFlow('code')} disabled={!isApi ? 'Coding runtimes already run code on your machine, with approvals.' : codeOn ? 'Already on for this agent.' : undefined}>
        Lets the agent write and run short programs in an isolated sandbox.</ChoiceCard>
    </div>;

  return <Modal title={title} onClose={onClose} className="add-tool-modal">
    {flow && <button type="button" className="btn btn-small btn-ghost add-tool-back" onClick={() => setFlow(undefined)}><Icon name="chevronLeft" size={14} />All tool types</button>}
    <div ref={content} className="add-tool-body">{body}</div>
    {!flow && <footer className="add-tool-footer"><button type="button" className="add-tool-link" onClick={onAdvanced}>Advanced: HTTP endpoint or JavaScript</button><small>Write the tool yourself in Capabilities.</small></footer>}
  </Modal>;
}

function ChoiceCard({ icon, title, children, onPick, disabled }: { icon: IconName; title: string; children: string; onPick: () => void; disabled?: string }) {
  const id = `add-tool-why-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return <button type="button" className="add-tool-choice" onClick={onPick} disabled={!!disabled} aria-describedby={disabled ? id : undefined}>
    <span className="add-tool-choice-mark" aria-hidden="true"><Icon name={icon} size={18} /></span>
    <span className="add-tool-choice-text"><strong>{title}</strong><span>{children}</span>{disabled && <small id={id}>{disabled}</small>}</span>
    <Icon name="chevronRight" size={14} />
  </button>;
}
