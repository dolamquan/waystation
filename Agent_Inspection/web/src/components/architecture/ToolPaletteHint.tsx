import type { ArchitectureNode } from '../../../../shared/architecture.ts';
import { Icon } from '../Icon.tsx';

interface Props { agent?: ArchitectureNode; busy: boolean; onAddTool: (agentId: string) => void; onCanvasStep: () => void; onDismiss: () => void }

/** Shown after choosing Tool with no agent selected: tools belong to an agent, so ask which one. */
export function ToolPaletteHint({ agent, busy, onAddTool, onCanvasStep, onDismiss }: Props) {
  return <div className="add-tool-hint" role="status">
    <p><Icon name="info" size={14} />{agent ? <>Add a tool to <strong>{agent.name}</strong>?</> : 'Select the agent this tool is for on the canvas.'}</p>
    <div className="arch-actions">
      {agent && <button type="button" className="btn btn-small btn-go" disabled={busy} onClick={() => onAddTool(agent.id)}><Icon name="plus" size={13} />Add tool</button>}
      <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={onCanvasStep} title="An unconfigured tool step you connect to agents yourself">Add a canvas tool step instead</button>
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={onDismiss}><Icon name="close" size={12} /></button>
    </div>
  </div>;
}
