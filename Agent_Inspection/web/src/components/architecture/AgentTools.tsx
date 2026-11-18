import type { ToolCallRecord, ToolManifestEntry } from '../../../../shared/agentRuns.ts';
import { StatusBadge } from './ArchitectureUI.tsx';

type ToolSource = ToolManifestEntry['source'];
export const TOOL_SOURCE_LABEL: Record<ToolSource, string> = { tool: 'Tool', mcp: 'MCP', memory: 'Memory', code: 'Code' };
const APPROVAL_LABEL: Record<ToolCallRecord['approval'], string> = { auto: 'Ran without asking', operator: 'Approved by you', harness: 'Runtime approval' };

/** The tool list exactly as the model will receive it, with the gateway policy applied to each call. */
export function ToolsTheModelSees({ tools, loading = false, error = '' }: { tools?: readonly ToolManifestEntry[]; loading?: boolean; error?: string }) {
  return <section className="agent-tools" aria-label="Tools the model sees">
    <header><h4>Tools the model sees</h4>{tools && !loading && !error && <span className="platform-count">{tools.length}</span>}</header>
    {loading ? <p role="status" className="platform-help">Checking which tools this version would offer…</p>
      : error ? <p className="arch-error" role="alert">{error}</p>
      : !tools?.length ? <p className="platform-help">No tools. The model can only answer in text.</p>
      : <ul className="agent-tool-list">{tools.map(t => <li key={t.name}>
        <div className="agent-tool-name"><code>{t.name}</code>{t.label !== t.name && <span>{t.label}</span>}</div>
        <div className="agent-tool-badges">
          <StatusBadge>{TOOL_SOURCE_LABEL[t.source]}</StatusBadge>
          <StatusBadge tone={t.readOnly ? 'neutral' : 'warning'}>{t.readOnly ? 'Read-only' : 'Writes'}</StatusBadge>
          {t.approval && <StatusBadge tone="warning">Asks before running</StatusBadge>}
        </div>
        {t.description && <p title={t.description}>{t.description}</p>}
      </li>)}</ul>}
  </section>;
}

/** Compact structured trajectory of a run: what was called, in order, and how each call went. */
export function ToolTrajectory({ calls }: { calls: readonly ToolCallRecord[] }) {
  return <details className="agent-trajectory" open>
    <summary>Tool trajectory · {calls.length} call{calls.length === 1 ? '' : 's'}</summary>
    <div className="agent-table-scroll"><table>
      <thead><tr><th scope="col">#</th><th scope="col">Tool</th><th scope="col">Source</th><th scope="col">Result</th><th scope="col">Time</th><th scope="col">Approval</th></tr></thead>
      <tbody>{calls.map(c => <tr key={c.seq}>
        <td>{c.seq}</td>
        <td><code>{c.name}</code></td>
        <td>{TOOL_SOURCE_LABEL[c.source]}</td>
        <td><StatusBadge tone={c.ok ? 'success' : 'error'}>{c.ok ? 'OK' : 'Failed'}</StatusBadge>{c.error && <small title={c.error}>{c.error}</small>}</td>
        <td>{c.durationMs.toLocaleString()} ms</td>
        <td>{APPROVAL_LABEL[c.approval]}</td>
      </tr>)}</tbody>
    </table></div>
  </details>;
}
