import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon.tsx';
import { Confirm } from '../Modal.tsx';
import { createPortal } from 'react-dom';
import { MiniMarkdown, NotebookOutputs } from './NotebookView.tsx';
import { joinSource } from './notebook.ts';
import { closeRuntime, executeCell, interruptRuntime, kernels, runtimeState, startKernel, type Runtime } from './filesApi.ts';
const CodeEditor = lazy(() => import('./CodeEditor.tsx').then((module) => ({ default: module.CodeEditor })));

function readDocument(text: string): Record<string, any> {
  const doc = JSON.parse(text);
  if (doc.nbformat !== 4 || !Array.isArray(doc.cells) || doc.cells.length > 2000) throw new Error('Open a notebook in nbformat 4 with at most 2,000 cells.');
  return { ...doc, nbformat_minor: Math.max(5, doc.nbformat_minor ?? 0), cells: doc.cells.map((cell: Record<string, any>) => ({ ...cell, id: cell.id ?? crypto.randomUUID() })) };
}

export function NotebookEditor({ text, root, path, onChange, onSave }: {
  text: string; root: string; path: string; onChange: (text: string) => void; onSave: () => void;
}) {
  const [initial] = useState(() => { try { return { doc: readDocument(text) }; } catch (error) { return { error: (error as Error).message }; } });
  const [doc, setDoc] = useState<Record<string, any>>(initial.doc ?? { cells: [] });
  const docRef = useRef(doc); docRef.current = doc;
  const [runtime, setRuntime] = useState<Runtime>();
  const live = useRef<Runtime | undefined>(undefined);
  const [available, setAvailable] = useState<{ name: string; label: string; language: string }[]>([]);
  const [kernel, setKernel] = useState(doc.metadata?.kernelspec?.name ?? 'python3');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [runningCell, setRunningCell] = useState<string>();
  const [editingMarkdown, setEditingMarkdown] = useState<ReadonlySet<string>>(new Set());
  const [confirmRestart, setConfirmRestart] = useState(false);
  const mounted = useRef(true);
  const runtimeKey = `waystation-kernel:${root}:${path}`;
  const update = (change: (current: Record<string, any>) => Record<string, any>) => {
    const next = change(docRef.current); docRef.current = next; setDoc(next); onChange(JSON.stringify(next, null, 1) + '\n');
  };
  const patch = (id: string, changes: Record<string, any>) => update((current) => ({ ...current, cells: current.cells.map((cell: any) => cell.id === id ? { ...cell, ...changes } : cell) }));
  const remember = (next: Runtime) => { live.current = next; setRuntime(next); try { sessionStorage.setItem(runtimeKey, next.id); } catch { /* Storage may be disabled. */ } };
  useEffect(() => {
    mounted.current = true;
    void kernels().then((result) => setAvailable(result.kernels)).catch((failure) => setError(failure.message));
    let previous: string | null = null; try { previous = sessionStorage.getItem(runtimeKey); } catch { /* Optional. */ }
    if (previous) void runtimeState(previous).then(async (next) => {
      if (!mounted.current) return;
      remember(next);
      let pending: { cell: string; job: string } | undefined;
      try { pending = JSON.parse(sessionStorage.getItem(runtimeKey + ':pending') ?? 'null'); } catch { /* Optional. */ }
      if (pending && pending.job === next.job) {
        setBusy(true); setRunningCell(pending.cell);
        try { await watch(next, pending.cell); } catch (failure) { setError((failure as Error).message); }
        finally { if (mounted.current) { setBusy(false); setRunningCell(undefined); } }
      }
    }).catch(() => { try { sessionStorage.removeItem(runtimeKey); } catch { /* Optional. */ } });
    return () => { mounted.current = false; };
  }, [runtimeKey]);
  const ensure = async () => {
    if (live.current?.status === 'idle') return live.current;
    if (live.current?.status === 'running') throw new Error('A cell is already running in this kernel. Interrupt it or wait for it to finish.');
    const next = await startKernel(root, path, kernel); remember(next); return next;
  };
  const watch = async (state: Runtime, id: string) => {
    let next = state;
    while (mounted.current) {
      patch(id, { outputs: next.outputs, execution_count: next.count ?? null });
      if (next.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 350));
      next = await runtimeState(state.id); remember(next);
    }
    if (next.status !== 'running') try { sessionStorage.removeItem(runtimeKey + ':pending'); } catch { /* Optional. */ }
    if (next.error) throw new Error(next.error);
    return next.outputs.some((output) => output.output_type === 'error');
  };
  const runOne = async (id: string) => {
    const cell = docRef.current.cells.find((entry: any) => entry.id === id);
    if (!cell || cell.cell_type !== 'code' || !joinSource(cell.source).trim()) return;
    const active = await ensure(); setRunningCell(id);
    const next = await executeCell(active.id, joinSource(cell.source)); remember(next);
    try { sessionStorage.setItem(runtimeKey + ':pending', JSON.stringify({ cell: id, job: next.job })); } catch { /* Optional. */ }
    return watch(next, id);
  };
  const run = async (ids: readonly string[]) => {
    if (busy) return; setBusy(true); setError(undefined);
    try { for (const id of ids) if (await runOne(id)) break; }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); setRunningCell(undefined); }
  };
  const restart = async () => {
    try { if (live.current) await closeRuntime(live.current.id); live.current = undefined; setRuntime(undefined); sessionStorage.removeItem(runtimeKey); setError(undefined); }
    catch (failure) { setError((failure as Error).message); }
  };
  const add = (type: 'code' | 'markdown', after?: number) => update((current) => {
    const cells = [...current.cells], cell = { id: crypto.randomUUID(), cell_type: type, metadata: {}, source: '', ...(type === 'code' ? { execution_count: null, outputs: [] } : {}) };
    cells.splice(after === undefined ? cells.length : after + 1, 0, cell);
    if (type === 'markdown') setEditingMarkdown((before) => new Set([...before, cell.id]));
    return { ...current, cells };
  });
  if (initial.error) return <p className="file-message tile-error" role="alert">{initial.error} Use Source to repair the notebook JSON.</p>;
  return <div className="notebook-workspace">
    <div className="nb-toolbar" role="toolbar" aria-label="Notebook actions">
      <button type="button" onClick={() => void run(doc.cells.filter((cell: any) => cell.cell_type === 'code').map((cell: any) => cell.id))} disabled={busy}><Icon name="play" size={13} />Run all</button>
      <button type="button" onClick={() => add('code')}>+ Code</button><button type="button" onClick={() => add('markdown')}>+ Markdown</button>
      <select aria-label="Notebook kernel" value={kernel} disabled={busy || !!runtime} onChange={(event) => setKernel(event.target.value)}>
        {!available.some((item) => item.name === kernel) && <option value={kernel}>{kernel}</option>}
        {available.map((item) => <option key={item.name} value={item.name}>{item.label}</option>)}
      </select>
      <span className="ide-muted" role="status">{busy ? runningCell ? 'Running cell…' : 'Starting kernel…' : runtime?.status === 'idle' ? 'Kernel ready' : 'Kernel not started'}</span>
      {busy && <button type="button" onClick={() => { if (live.current) void interruptRuntime(live.current.id).catch((failure) => setError(failure.message)); }}>Interrupt</button>}
      {runtime && <button type="button" onClick={() => setConfirmRestart(true)} disabled={busy}>Restart kernel</button>}
    </div>
    {error && <p className="ide-error" role="alert">{error}</p>}
    <div className="nb-edit-cells">{doc.cells.map((cell: any, index: number) => <section key={cell.id} className={`nb-edit-cell ${runningCell === cell.id ? 'nb-edit-cell-running' : ''}`} aria-label={`Cell ${index + 1}`}>
      <div className="nb-cell-tools"><span>{index + 1} · {cell.cell_type}{cell.cell_type === 'code' ? ` [${cell.execution_count ?? ' '}]` : ''}</span>
        {cell.cell_type === 'code' && <button type="button" disabled={busy || !joinSource(cell.source).trim()} aria-label={`Run cell ${index + 1}`} title="Run cell (Shift+Enter)" onClick={() => void run([cell.id])}><Icon name="play" size={13} />Run</button>}
        {cell.cell_type === 'markdown' && <button type="button" onClick={() => setEditingMarkdown((previous) => { const next = new Set(previous); if (next.has(cell.id)) next.delete(cell.id); else next.add(cell.id); return next; })}>{editingMarkdown.has(cell.id) ? 'Preview' : 'Edit'}</button>}
        <button type="button" aria-label={`Move cell ${index + 1} up`} disabled={index === 0 || busy} onClick={() => update((current) => { const cells = [...current.cells]; [cells[index - 1], cells[index]] = [cells[index], cells[index - 1]]; return { ...current, cells }; })}>Move up</button>
        <button type="button" aria-label={`Delete cell ${index + 1}`} disabled={busy} onClick={() => update((current) => ({ ...current, cells: current.cells.filter((item: any) => item.id !== cell.id) }))}><Icon name="trash" size={13} /></button>
      </div>
      {cell.cell_type === 'markdown' && !editingMarkdown.has(cell.id) ? <div className="nb-markdown-preview" onDoubleClick={() => setEditingMarkdown(new Set([...editingMarkdown, cell.id]))}><MiniMarkdown text={joinSource(cell.source) || '*Empty Markdown cell. Choose Edit to write.*'} /></div>
        : <Suspense fallback={<textarea aria-label={`Cell ${index + 1} source`} value={joinSource(cell.source)} onChange={(event) => patch(cell.id, { source: event.target.value })} />}>
          <CodeEditor cell value={joinSource(cell.source)} label={`Cell ${index + 1} source`} language={cell.cell_type === 'markdown' ? 'markdown' : doc.metadata?.language_info?.name ?? 'python'}
            onChange={(value) => patch(cell.id, { source: value })} onSave={onSave} onRun={() => void run([cell.id])} />
        </Suspense>}
      {cell.cell_type === 'code' && Array.isArray(cell.outputs) && <NotebookOutputs outputs={cell.outputs} />}
    </section>)}
      {!doc.cells.length && <p className="ide-muted">This notebook is empty. Add a code or Markdown cell to begin.</p>}
      <button className="nb-add-cell" type="button" onClick={() => add('code')}>+ Add code cell</button>
    </div>
    {confirmRestart && createPortal(<Confirm title="Restart the notebook kernel?" body={<p>This clears variables from the current kernel. Cell contents and saved outputs stay in the notebook.</p>} confirmLabel="Restart kernel" onClose={() => setConfirmRestart(false)} onConfirm={() => void restart()} />, document.body)}
  </div>;
}
