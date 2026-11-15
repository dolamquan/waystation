import { useState, type FormEvent } from 'react';
import type { ConsoleKind } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { ProjectFolderInput } from '../ProjectFolderInput.tsx';
import { DEFAULT_BROWSER_URL, MAX_NAME, browserUrl, cleanName, fileName } from './canvasTiles.ts';
import { FolderBrowser } from './FolderBrowser.tsx';
import { WorktreePicker, type WorktreeSelection } from './WorktreePicker.tsx';
import './fileTiles.css';

type Choice = ConsoleKind | 'browser' | 'file' | 'orchestrator' | 'worktree';
type IconName = Parameters<typeof Icon>[0]['name'];

const CHOICES: ReadonlyArray<{ readonly id: Choice; readonly label: string; readonly note: string; readonly icon: IconName; readonly placeholder: string }> = [
  { id: 'claude', label: 'Claude Code', note: 'An agent, in a real terminal', icon: 'sparkle', placeholder: 'e.g. Researcher' },
  { id: 'codex', label: 'Codex', note: 'The Codex CLI agent', icon: 'sparkle', placeholder: 'e.g. Builder' },
  { id: 'shell', label: 'Console', note: 'A plain PowerShell prompt', icon: 'terminal', placeholder: 'e.g. Tests' },
  { id: 'worktree', label: 'Worktree', note: 'A separate Git branch and folder', icon: 'folder', placeholder: 'e.g. Feature branches' },
  { id: 'browser', label: 'Browser', note: 'Browse the web inside this tile', icon: 'planet', placeholder: 'e.g. Research' },
  { id: 'file', label: 'File', note: 'Code, a notebook, a PDF or an image', icon: 'book', placeholder: 'defaults to the file name' },
  { id: 'orchestrator', label: 'Orchestrator', note: 'Directs teams with one goal', icon: 'crew', placeholder: 'e.g. Frontend lead' },
];

/** What a blank tile shows: pick what it becomes, and optionally what it is called. Agents, consoles and files use the chosen folder. */
export function TileChooser({ defaultCwd, onOpenConsole, onBrowse, onOpenFile, onOrchestrate, onWorktree }: {
  readonly defaultCwd: string;
  /** Resolves true once the console is open (the tile then turns into it). */
  readonly onOpenConsole: (kind: ConsoleKind, cwd: string, name?: string) => Promise<boolean>;
  readonly onBrowse: (url: string, name?: string) => void;
  readonly onOpenFile: (root: string, path: string, name?: string) => void;
  readonly onOrchestrate: (name?: string) => void;
  readonly onWorktree: (root: string, path: string, name?: string) => void;
}) {
  const [choice, setChoice] = useState<Choice>('claude');
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState(defaultCwd);
  const [url, setUrl] = useState(DEFAULT_BROWSER_URL);
  const [file, setFile] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [selection, setSelection] = useState<WorktreeSelection>();
  const isConsole = choice === 'claude' || choice === 'codex' || choice === 'shell';
  const needsWorktree = choice === 'worktree' || (isConsole && useWorktree);
  const option = CHOICES.find((candidate) => candidate.id === choice)!;
  const chosenName = cleanName(name);

  const openFile = (path: string | undefined) => {
    if (!cwd.trim()) { setError('Choose the folder the file is in.'); return; }
    if (!path) { setError('Pick a file in the list (double-click opens it at once).'); return; }
    onOpenFile(cwd.trim(), path, chosenName);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    if (choice === 'browser') {
      const checked = browserUrl(url, location.origin);
      if (checked.ok) onBrowse(checked.url, chosenName); else setError(checked.reason);
      return;
    }
    if (choice === 'file') { openFile(file); return; }
    if (choice === 'orchestrator') { onOrchestrate(chosenName); return; }
    if (needsWorktree && !selection) { setError('Select or create a worktree first.'); return; }
    if (choice === 'worktree' && selection) { onWorktree(selection.root, selection.worktree.path, chosenName); return; }
    if (!isConsole) return;
    if (!cwd.trim()) { setError('Choose the folder it should work in.'); return; }
    setBusy(true);
    try {
      if (!(await onOpenConsole(choice, needsWorktree && selection ? selection.worktree.path : cwd.trim(), chosenName)))
        setError('Could not open the console. Try again; any created worktree is still available.');
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const action = choice === 'worktree' ? 'Open worktree tile' : choice === 'orchestrator' ? 'Make orchestrator'
    : choice === 'browser' ? 'Open page'
    : choice === 'file' ? (file ? `Open ${fileName(file)}` : 'Open file')
    : busy ? 'Opening…' : `Open ${option.label}`;
  return <form className="tile-chooser" onSubmit={(event) => void submit(event)}>
    <h3>What should this tile be?</h3>
    <fieldset className="tile-chooser-fields" disabled={busy}>
    <div className="tile-choices" role="radiogroup" aria-label="Tile type">
      {CHOICES.map((candidate) => <button key={candidate.id} type="button" role="radio" aria-checked={choice === candidate.id}
        className={choice === candidate.id ? 'tile-choice tile-choice-on' : 'tile-choice'} onClick={() => { setChoice(candidate.id); setError(undefined); }}>
        <Icon name={candidate.icon} size={20} />
        <strong>{candidate.label}</strong>
        <small>{candidate.note}</small>
      </button>)}
    </div>
    <label className="tile-field">Name <small>(optional)</small>
      <input className="text-input" value={name} maxLength={MAX_NAME} placeholder={option.placeholder} onChange={(event) => setName(event.target.value)} />
    </label>
    {choice === 'orchestrator' ? <p className="tile-note">Pick the teams it directs on the tile. A curve on the canvas joins it to each one.</p>
      : choice === 'browser'
      ? <label className="tile-field">Address
        <input className="text-input" value={url} spellCheck={false} onChange={(event) => setUrl(event.target.value)} placeholder="example.com or localhost:3000" />
        <small>Open any website or a local dev server. The browser runs inside this tile.</small>
      </label>
      : <ProjectFolderInput value={cwd} onChange={(next) => { setCwd(next); setFile(undefined); setSelection(undefined); }} label={needsWorktree ? 'Repository folder' : 'Folder'} />}
    {isConsole && <label className="worktree-toggle"><input type="checkbox" checked={useWorktree} onChange={event => setUseWorktree(event.target.checked)} />Use a Git worktree</label>}
    {needsWorktree && <WorktreePicker key={cwd} root={cwd} onChange={setSelection} />}
    {choice === 'file' && <FolderBrowser root={cwd} selected={file} onSelect={(path) => { setFile(path); setError(undefined); }} onOpen={openFile} />}
    {error && <p className="tile-error" role="alert">{error}</p>}
    <button type="submit" className="btn btn-go" disabled={busy || (needsWorktree && !selection)}>{action}</button>
    </fieldset>
  </form>;
}
