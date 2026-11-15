import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker.js?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js';
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js';

self.MonacoEnvironment = { getWorker: (_id, label) => label === 'typescript' || label === 'javascript' ? new TypeScriptWorker() : label === 'json' ? new JsonWorker() : new EditorWorker() };
monaco.editor.defineTheme('waystation', { base: 'vs-dark', inherit: true, rules: [], colors: {
  'editor.background': '#0b0b0d', 'editor.foreground': '#e6e6ea', 'editorLineNumber.foreground': '#5f5f68',
  'editor.selectionBackground': '#2c3a55', 'editorCursor.foreground': '#e6e6ea', 'editorWidget.background': '#151518',
} });

export function languageFor(path: string): string {
  const ext = path.split('.').at(-1)?.toLowerCase();
  return ({ py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown', css: 'css', html: 'html', htm: 'html', sh: 'shell', ps1: 'powershell', yaml: 'yaml', yml: 'yaml', sql: 'sql' } as Record<string, string>)[ext ?? ''] ?? 'plaintext';
}

/** VS Code's editor engine, local workers, and a model owned by this tile rather than a global file singleton. */
export function CodeEditor({ value, onChange, label, path, language, cell = false, onSave, onRun }: {
  value: string; onChange: (value: string) => void; label: string; path?: string; language?: string; cell?: boolean;
  onSave?: () => void; onRun?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const callbacks = useRef({ onChange, onSave, onRun }); callbacks.current = { onChange, onSave, onRun };
  useEffect(() => {
    if (!host.current) return;
    const model = monaco.editor.createModel(value, language ?? languageFor(path ?? ''));
    const editor = monaco.editor.create(host.current, { model, theme: 'waystation', ariaLabel: label, automaticLayout: true, editContext: false,
      minimap: { enabled: !cell }, lineNumbers: cell ? 'off' : 'on', fontSize: 13, fontFamily: '"Cascadia Mono", Consolas, monospace',
      scrollBeyondLastLine: false, wordWrap: cell ? 'on' : 'off', tabSize: 4, padding: { top: 10, bottom: 10 },
      fixedOverflowWidgets: true, ...(cell ? { scrollbar: { alwaysConsumeMouseWheel: false }, folding: false, glyphMargin: false, overviewRulerLanes: 0 } : {}),
    });
    current.current = editor;
    const listener = editor.onDidChangeModelContent(() => callbacks.current.onChange(editor.getValue()));
    const saveAction = editor.addAction({ id: 'waystation.save', label: 'Save file', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => callbacks.current.onSave?.() });
    const runAction = cell ? editor.addAction({ id: 'waystation.runCell', label: 'Run cell', keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.Enter], run: () => callbacks.current.onRun?.() }) : undefined;
    return () => { saveAction.dispose(); runAction?.dispose(); listener.dispose(); current.current = undefined; editor.dispose(); model.dispose(); };
  }, []);
  useEffect(() => { if (current.current && current.current.getValue() !== value) current.current.setValue(value); }, [value]);
  useEffect(() => { const model = current.current?.getModel(); if (model) monaco.editor.setModelLanguage(model, language ?? languageFor(path ?? '')); }, [language, path]);
  const height = cell ? Math.min(420, Math.max(76, value.split('\n').length * 20 + 24)) : undefined;
  return <div ref={host} className={cell ? 'ide-cell-editor' : 'ide-code-editor'} style={height ? { height } : undefined} />;
}
