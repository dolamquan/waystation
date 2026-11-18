import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SANDBOX, type SandboxConfig, type SandboxExecution } from '../../../../shared/agentEvaluation.ts';
import { request } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { StatusBadge, WorkspaceEmpty } from './ArchitectureUI.tsx';

const enc = encodeURIComponent;

export function SandboxSettings({ config, onChange }: { config: SandboxConfig; onChange: (config: SandboxConfig) => void }) {
  return <div className="sandbox-settings"><label>Sandbox backend<select aria-label="Sandbox backend" className="text-input" value={config.backend} onChange={e => onChange(e.target.value === 'quickjs' ? DEFAULT_SANDBOX : { backend: 'docker', language: 'python', memoryMb: 128, timeoutMs: 10000 })}><option value="quickjs">Isolated JavaScript interpreter</option><option value="docker">Docker container</option></select></label><label>Sandbox language<select aria-label="Sandbox language" className="text-input" value={config.language} onChange={e => onChange({ ...config, language: e.target.value as SandboxConfig['language'] })}><option value="javascript">JavaScript</option><option value="python" disabled={config.backend === 'quickjs'}>Python</option><option value="shell" disabled={config.backend === 'quickjs'}>Shell</option></select></label><label>Sandbox memory (MB)<input className="text-input" type="number" min={config.backend === 'quickjs' ? 16 : 64} max={config.backend === 'quickjs' ? 64 : 1024} value={config.memoryMb} required onChange={e => onChange({ ...config, memoryMb: Number(e.target.value) })} /></label><label>Sandbox timeout (ms)<input className="text-input" type="number" min={100} max={config.backend === 'quickjs' ? 1000 : 30000} value={config.timeoutMs} required onChange={e => onChange({ ...config, timeoutMs: Number(e.target.value) })} /></label></div>;
}

/** Code execution is a tool agents call (`run_code`); this page runs the same sandbox by hand for testing. */
export function AgentSandboxesView({ project, onProject, onActivity }: { project: string; onProject: (project: string) => void; onActivity?: (runId: string) => void }) {
  const [folder, setFolder] = useState(project); const [config, setConfig] = useState<SandboxConfig>(DEFAULT_SANDBOX); const [code, setCode] = useState('return { answer: input.n + 1 };'); const [input, setInput] = useState('{"n":3}'); const [executions, setExecutions] = useState<SandboxExecution[]>([]); const [selected, setSelected] = useState(''); const [availability, setAvailability] = useState<{ docker: boolean; message: string; images: string[] }>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { if (!project) return; try { setExecutions((await request<{ executions: SandboxExecution[] }>('GET', `/api/agent-sandboxes?project=${enc(project)}`)).executions); } catch (e) { setError((e as Error).message); } }, [project]);
  const check = async () => { try { setAvailability(await request('GET', '/api/agent-sandboxes/availability')); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { void load(); void check(); const timer = setInterval(() => { void load(); }, 1500); return () => clearInterval(timer); }, [load]);
  const start = async () => { setBusy(true); setError(''); try { const result = await request<{ execution: SandboxExecution }>('POST', '/api/agent-sandboxes', { project, config, code, input: JSON.parse(input || 'null') }); setSelected(result.execution.id); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const row = executions.find(e => e.id === selected);
  return <section className="agent-platform agent-sandboxes" aria-label="Code execution">
    <header className="platform-heading"><div><h1>Code execution</h1><p>Code execution is a tool. When an environment enables it, API agents get a <code>run_code</code> tool; each call runs in a fresh isolated interpreter or container. This page runs code by hand for testing.</p></div><button className="btn btn-small" onClick={() => { void check(); }}><Icon name="refresh" size={14} />Check Docker</button></header>
    <div className={`sandbox-runtime-note ${!availability ? '' : availability.docker ? 'is-ready' : 'is-missing'}`} role="status"><Icon name={availability?.docker ? 'check' : 'terminal'} size={16} /><p>{availability?.message ?? 'Checking container runtime…'}</p></div>
    <form className="evaluation-project" onSubmit={e => { e.preventDefault(); onProject(folder); }}><label>Project<input className="text-input" value={folder} onChange={e => setFolder(e.target.value)} required /></label><button className="btn btn-small">Use project</button></form>
    {error && <p className="arch-error" role="alert">{error}</p>}
    <div className="sandbox-workbench">
      <form className="platform-form sandbox-code-form" onSubmit={e => { e.preventDefault(); void start(); }}>
        <h2><Icon name="terminal" size={18} />Run code by hand</h2>
        <div className="platform-wide"><SandboxSettings config={config} onChange={setConfig} /></div>
        <label className="platform-wide">Sandbox code<textarea aria-label="Sandbox code" className="text-input platform-code" rows={9} value={code} maxLength={20000} onChange={e => setCode(e.target.value)} required spellCheck={false} /></label>
        <label className="platform-wide">Sandbox input JSON<textarea aria-label="Sandbox input JSON" className="text-input platform-code" rows={3} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} /></label>
        <p className="platform-help platform-wide">{config.backend === 'quickjs' ? 'Return a synchronous JSON value using input. No Node, filesystem, imports or network APIs are exposed.' : `Runtime image: ${config.language === 'javascript' ? 'node:22-alpine' : 'python:3.12-alpine'}. Pull this image in Docker first. Containers have no host mounts, no network, a read-only root filesystem, limited memory/CPU/processes and temporary workspace storage. Python receives input; shell receives INPUT_JSON.`}</p>
        <div className="arch-actions platform-form-footer platform-wide"><button className="btn btn-go" disabled={busy || !project || config.backend === 'docker' && !availability?.docker}><Icon name="play" size={15} />{busy ? 'Starting…' : 'Run code'}</button><button className="btn" type="button" onClick={() => setCode(config.language === 'javascript' ? 'return { answer: input.n + 1 };' : config.language === 'python' ? 'print(input["n"] + 1)' : 'printf "%s\\n" "$INPUT_JSON"')}>Load language example</button></div>
      </form>
      <aside className="sandbox-results" aria-label="Execution results and history">
        <div className="platform-inventory-heading"><h2>Execution results</h2><span className="platform-count">{executions.length}</span></div>
        {row ? <div className="evaluation-snapshot sandbox-result" aria-label="Sandbox execution result"><div className="sandbox-result-heading"><h3>{row.status} · exit {row.exitCode ?? '—'}</h3><StatusBadge tone={row.status === 'succeeded' ? 'success' : row.status === 'failed' ? 'error' : 'neutral'}>{row.config.language}</StatusBadge></div>{row.error && <p className="arch-error">{row.error}</p>}<h4>Output</h4><pre>{row.stdout || 'No stdout'}</pre>{row.stderr && <><h4>Errors</h4><pre>{row.stderr}</pre></>}<details><summary>Executed code</summary><pre>{row.code}</pre></details>{row.runId && <RunLink runId={row.runId} onActivity={onActivity} />}</div> : <WorkspaceEmpty icon="terminal" title="Ready for a test run">Execute code to inspect its output, errors and exit status here. Every invocation starts fresh.</WorkspaceEmpty>}
        <h3 className="sandbox-history-heading">Recent executions</h3>
        <ul className="platform-resource-list sandbox-history">{executions.map(e => <li key={e.id} className={selected === e.id ? 'selected' : ''}><div><strong>{e.config.backend === 'quickjs' ? 'Interpreter' : 'Docker'} · {e.config.language}</strong><p><StatusBadge tone={e.status === 'succeeded' ? 'success' : e.status === 'failed' ? 'error' : 'neutral'}>{e.status}</StatusBadge></p><small>{new Date(e.createdAt).toLocaleString()} · {e.finishedAt ? `${e.finishedAt - e.createdAt}ms` : 'Running'} · {e.runId ? 'Called by an agent' : 'Run by hand'}</small></div><div className="platform-resource-actions"><button className="btn btn-small" aria-pressed={selected === e.id} onClick={() => setSelected(e.id)}>Inspect result</button>{e.runId && onActivity && <button className="btn btn-small" onClick={() => onActivity(e.runId!)}>Open agent run</button>}{e.status === 'running' && <button className="btn btn-small" onClick={() => { void request('POST', `/api/agent-sandboxes/${enc(e.id)}/cancel`, {}).then(load, err => setError(err.message)); }}>Cancel execution</button>}</div></li>)}</ul>
      </aside>
    </div>
  </section>;
}

function RunLink({ runId, onActivity }: { runId: string; onActivity?: (runId: string) => void }) {
  return <p className="sandbox-run-link">Called by agent run <code>{runId.slice(0, 8)}</code>{onActivity && <button className="btn btn-small" onClick={() => onActivity(runId)}><Icon name="activity" size={14} />Open in Agent activity</button>}</p>;
}
