import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { Confirm } from '../Modal.tsx';
import { createPortal } from 'react-dom';
import { FolderBrowser } from './FolderBrowser.tsx';
import { NotebookEditor } from './NotebookEditor.tsx';
import { NotebookOutputs } from './NotebookView.tsx';
import { TerminalPane } from './TerminalPane.tsx';
import { closeRuntime, interruptRuntime, readFile, runFile, runtimeState, writeFile, type FileContent, type Runtime } from './filesApi.ts';
import './fileWorkspace.css';

const CodeEditor = lazy(() => import('./CodeEditor.tsx').then((module) => ({ default: module.CodeEditor })));
const PdfView = lazy(() => import('./PdfView.tsx').then((module) => ({ default: module.PdfView })));
type Entry = { file: FileContent; text: string; revision: string; dirty: boolean; generation: number };
const draftKey = (root: string, path: string) => `waystation-file-draft:${root}:${path}`;
const drafts = new Map<string, { text: string; revision: string }>();
const filename = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

export function FileWorkspace({ root, path }: { root: string; path: string }) {
  const [tabs, setTabs] = useState<Record<string, Entry>>({});
  const tabRef = useRef(tabs); tabRef.current = tabs;
  const [active, setActive] = useState(path);
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [rawNotebook, setRawNotebook] = useState(false);
  const [script, setScript] = useState<Runtime>();
  const [running, setRunning] = useState(false);
  const [terminal, setTerminal] = useState<string>();
  const [openingTerminal, setOpeningTerminal] = useState(false);
  const [pane, setPane] = useState<'output' | 'terminal'>('output');
  const [confirmReload, setConfirmReload] = useState<string>();
  const [confirmClose, setConfirmClose] = useState<string>();
  const [position, setPosition] = useState('');
  const entry = tabs[active];
  const mounted = useRef(true);
  const load = async (next: string, discard = false) => {
    setActive(next); setRawNotebook(false); setError(undefined);
    if (tabRef.current[next] && !discard) return;
    setLoading((old) => new Set([...old, next]));
    try {
      const file = await readFile(root, next);
      if (!mounted.current) return;
      const diskText = file.kind === 'text' || file.kind === 'notebook' ? file.text : '';
      let draft = discard ? undefined : drafts.get(draftKey(root, next));
      if (!draft && !discard) try { draft = JSON.parse(sessionStorage.getItem(draftKey(root, next)) ?? 'null') ?? undefined; } catch { /* Ignore invalid drafts. */ }
      const validDraft = draft && typeof draft.text === 'string' && typeof draft.revision === 'string' && draft.text.length < 30_000_000;
      if (discard) { drafts.delete(draftKey(root, next)); try { sessionStorage.removeItem(draftKey(root, next)); } catch { /* Optional. */ } }
      setTabs((old) => ({ ...old, [next]: { file, text: validDraft ? draft!.text : diskText, revision: validDraft ? draft!.revision : file.revision ?? '', dirty: !!validDraft && draft!.text !== diskText, generation: (old[next]?.generation ?? 0) + 1 } }));
    } catch (failure) { if (mounted.current) setError((failure as Error).message); }
    finally { if (mounted.current) setLoading((old) => new Set([...old].filter((item) => item !== next))); }
  };
  useEffect(() => { mounted.current = true; void load(path); return () => { mounted.current = false; }; }, [root, path]);
  useEffect(() => {
    const saveDrafts = () => { for (const [key, value] of drafts) try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* In-memory draft and unload warning remain. */ } };
    const timer = setTimeout(saveDrafts, 350);
    const before = (event: BeforeUnloadEvent) => { if (Object.values(tabRef.current).some((item) => item.dirty)) { saveDrafts(); event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', before);
    return () => { clearTimeout(timer); saveDrafts(); window.removeEventListener('beforeunload', before); };
  }, [tabs]);
  useEffect(() => {
    if (!script || script.status !== 'running') return;
    let cancelled = false;
    const timer = setInterval(() => void runtimeState(script.id).then((next) => { if (!cancelled) setScript(next); }).catch((failure) => { if (!cancelled) { setError(failure.message); setScript((old) => old ? { ...old, status: 'error' } : old); } }), 400);
    return () => { cancelled = true; clearInterval(timer); };
  }, [script?.id, script?.status]);
  const change = (text: string) => {
    const current = tabRef.current[active]; if (!current) return;
    drafts.set(draftKey(root, active), { text, revision: current.revision });
    setTabs((old) => ({ ...old, [active]: { ...old[active], text, dirty: true } }));
  };
  const save = async () => {
    const current = tabRef.current[active]; if (!current) return false;
    if (!current.dirty) return true;
    if (!current.revision) { setError('The daemon does not support saving yet. Update it at the next normal restart; your draft is kept here.'); return false; }
    setSaving(true); setError(undefined);
    try {
      const result = await writeFile(root, active, current.text, current.revision);
      setTabs((old) => old[active] ? ({ ...old, [active]: { ...old[active], revision: result.revision, dirty: old[active].text !== current.text } }) : old);
      if (tabRef.current[active]?.text === current.text) { drafts.delete(draftKey(root, active)); try { sessionStorage.removeItem(draftKey(root, active)); } catch { /* Optional. */ } }
      else if (tabRef.current[active]) drafts.set(draftKey(root, active), { text: tabRef.current[active].text, revision: result.revision });
      return true;
    } catch (failure) { setError((failure as Error).message); return false; }
    finally { setSaving(false); }
  };
  const execute = async () => {
    if (running || script?.status === 'running') return;
    setRunning(true); setError(undefined);
    try {
      if (!await save()) return;
      if (script) await closeRuntime(script.id);
      const next = await runFile(root, active); setScript(next); setPane('output');
    } catch (failure) { setError((failure as Error).message); }
    finally { setRunning(false); }
  };
  const openTerminal = async () => {
    if (terminal) { setPane('terminal'); return; }
    setOpeningTerminal(true);
    try { const result = await api.openConsole({ kind: 'shell', cwd: root, name: `Files · ${filename(root)}` }); setTerminal(result.console.id); setPane('terminal'); }
    catch (failure) { setError((failure as Error).message); }
    finally { setOpeningTerminal(false); }
  };
  const closeTab = (target: string) => {
    drafts.delete(draftKey(root, target)); try { sessionStorage.removeItem(draftKey(root, target)); } catch { /* Optional. */ }
    setTabs((old) => { const next = { ...old }; delete next[target]; return next; });
    if (active === target) setActive(Object.keys(tabs).find((key) => key !== target) ?? '');
  };
  const editable = entry?.file.kind === 'text' || entry?.file.kind === 'notebook';
  const canRun = entry?.file.kind === 'text' && /\.(py|mjs|cjs|js|ts)$/i.test(active);
  const downloadDraft = () => {
    if (!entry) return;
    const url = URL.createObjectURL(new Blob([entry.text], { type: 'text/plain' })), anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename(active); anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="file-tile ide-workspace" onKeyDown={(event) => {
    if (event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void save(); }
  }}>
    <div className="ide-toolbar" role="toolbar" aria-label="File workspace actions">
      <button type="button" aria-pressed={exploring} onClick={() => setExploring(!exploring)} title="Browse project files"><Icon name="folder" size={14} />Explorer</button>
      <span className="ide-path" title={`${root}/${active}`}>{active || 'No file selected'}</span>
      {editable && <button type="button" disabled={!entry.dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>}
      {canRun && <button type="button" disabled={running || script?.status === 'running'} onClick={() => void execute()}><Icon name="play" size={13} />{running ? 'Starting…' : 'Run file'}</button>}
      {entry?.file.kind === 'notebook' && <button type="button" aria-pressed={rawNotebook} onClick={() => setRawNotebook(!rawNotebook)}>{rawNotebook ? 'Notebook' : 'Source'}</button>}
      <button type="button" disabled={openingTerminal} onClick={() => void openTerminal()}><Icon name="terminal" size={13} />Terminal</button>
      <button type="button" aria-label="Reload file" title="Reload from disk" disabled={!active} onClick={() => entry?.dirty ? setConfirmReload(active) : void load(active, true)}><Icon name="refresh" size={14} /></button>
    </div>
    {error && <div className="ide-error" role="alert">{error}{entry?.dirty && <button type="button" onClick={downloadDraft}>Download my edits</button>}</div>}
    <div className="ide-main">
      {exploring && <aside className="ide-explorer" aria-label="Project explorer"><FolderBrowser root={root} selected={active} onSelect={(next) => void load(next)} onOpen={(next) => void load(next)} /></aside>}
      <div className="ide-center">
        <div className="ide-tabs" role="tablist" aria-label="Open files">{Object.entries(tabs).map(([key, tab]) => <div className="ide-tab-wrap" key={key}>
          <button type="button" role="tab" aria-selected={key === active} onClick={() => { setActive(key); setError(undefined); setRawNotebook(false); }}>{filename(key)}{tab.dirty ? ' •' : ''}</button>
          <button type="button" aria-label={`Close ${filename(key)} tab`} onClick={() => tab.dirty ? setConfirmClose(key) : closeTab(key)}><Icon name="close" size={11} /></button>
        </div>)}</div>
        <div className={`ide-document ${entry?.file.kind === 'text' || rawNotebook ? 'ide-document-code' : ''}`}>
          {loading.has(active) ? <p className="file-message tile-note">Reading {active}…</p> : !entry ? <p className="file-message tile-note">Choose a file in the explorer.</p>
            : editable && (entry.file.kind === 'text' || rawNotebook) ? <Suspense fallback={<textarea className="ide-editor-fallback" aria-label="File source" value={entry.text} onChange={(event) => change(event.target.value)} />}><CodeEditor key={`${active}:${entry.generation}`} value={entry.text} label={`Source editor for ${filename(active)}`} path={rawNotebook ? 'notebook.json' : active} onChange={change} onSave={() => void save()} /></Suspense>
            : entry.file.kind === 'notebook' ? <NotebookEditor key={`${active}:${entry.generation}`} root={root} path={active} text={entry.text} onChange={change} onSave={() => void save()} />
            : entry.file.kind === 'image' ? <div className="file-image"><img src={`data:${entry.file.mime};base64,${entry.file.base64}`} alt={active} /></div>
            : entry.file.kind === 'pdf' ? <Suspense fallback={<p className="file-message tile-note">Opening the PDF…</p>}><PdfView key={active} base64={entry.file.base64} /></Suspense> : null}
        </div>
        {(script || terminal) && <section className="ide-bottom" aria-label="Workspace output and terminal">
          <div className="ide-bottom-tabs"><button type="button" aria-pressed={pane === 'output'} onClick={() => setPane('output')}>Output{script?.path ? ` · ${filename(script.path)}` : ''}</button>{terminal && <button type="button" aria-pressed={pane === 'terminal'} onClick={() => setPane('terminal')}>Terminal</button>}
            <span className="ide-muted">{script?.status === 'running' ? 'Running' : script?.exitCode !== undefined ? `Exit ${script.exitCode}` : ''}</span>
            {script?.status === 'running' && <button type="button" onClick={() => void interruptRuntime(script.id).then(() => setScript({ ...script, status: 'stopped' })).catch((failure) => setError(failure.message))}>Stop</button>}
          </div>
          <div className="ide-run-output" hidden={pane !== 'output'}>{script?.error && <p className="tile-error">{script.error}</p>}<NotebookOutputs outputs={script?.outputs ?? []} /></div>
          {terminal && <div className="ide-terminal" hidden={pane !== 'terminal'}><TerminalPane consoleId={terminal} label="Workspace terminal" kind="shell" /></div>}
        </section>}
        <footer className="ide-status"><span>{entry?.dirty ? 'Unsaved changes' : editable ? 'Saved to disk' : 'Preview'}</span><span>{entry?.file.kind === 'notebook' ? 'Jupyter notebook' : active.split('.').at(-1)?.toUpperCase()} · UTF-8</span></footer>
      </div>
    </div>
    {confirmReload && createPortal(<Confirm title="Reload and discard your edits?" body={<p>The file will be read from disk. Download your edits first if you want to keep a copy.</p>} confirmLabel="Reload file" onClose={() => setConfirmReload(undefined)} onConfirm={() => void load(confirmReload, true)} />, document.body)}
    {confirmClose && createPortal(<Confirm title="Close this unsaved file?" body={<p>Closing this tab discards its unsaved edits. Cancel and save or download them to keep a copy.</p>} confirmLabel="Discard and close" onClose={() => setConfirmClose(undefined)} onConfirm={() => closeTab(confirmClose)} />, document.body)}
  </div>;
}
