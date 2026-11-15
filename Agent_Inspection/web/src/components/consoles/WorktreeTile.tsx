import { useState } from 'react';
import type { ConsoleKind } from '../../api.ts';
import type { LocalTile } from './canvasTiles.ts';
import { ProjectFolderInput } from '../ProjectFolderInput.tsx';
import { WorktreePicker, type WorktreeSelection } from './WorktreePicker.tsx';

export function WorktreeTile({ tile, onSelect, onOpenConsole }: {
  readonly tile: LocalTile;
  readonly onSelect: (root: string, path: string) => void;
  readonly onOpenConsole: (kind: ConsoleKind, cwd: string, name?: string) => Promise<boolean>;
}) {
  const [root, setRoot] = useState(tile.root ?? '');
  const [selection, setSelection] = useState<WorktreeSelection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const open = async (kind: ConsoleKind) => {
    if (!selection || busy) return;
    setBusy(true); setError(undefined);
    try {
      if (!(await onOpenConsole(kind, selection.worktree.path, selection.worktree.branch))) setError('Could not open the console. The worktree is still available; try again.');
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="tile-chooser worktree-tile">
    <h3>Git worktrees</h3>
    <p className="tile-note">Work on separate branches in their own folders. Open an agent or console in the selected worktree.</p>
    <details className="worktree-repository"><summary>Change repository</summary>
      <ProjectFolderInput label="Repository folder" value={root} onChange={next => { setRoot(next); setSelection(undefined); }} />
    </details>
    <div className="worktree-launch" role="group" aria-label="Open a tile in the selected worktree">
      <button type="button" className="btn btn-go" disabled={!selection || busy} onClick={() => void open('claude')}>Open Claude Code</button>
      <button type="button" className="btn" disabled={!selection || busy} onClick={() => void open('codex')}>Open Codex</button>
      <button type="button" className="btn" disabled={!selection || busy} onClick={() => void open('shell')}>Open console</button>
    </div>
    <WorktreePicker key={root} root={root} initialPath={root === tile.root ? tile.path : undefined} visualize onChange={next => {
      setSelection(next);
      if (next && (tile.root !== next.root || tile.path !== next.worktree.path)) onSelect(next.root, next.worktree.path);
    }} />
    {busy && <p className="tile-note" role="status">Opening console…</p>}
    {error && <p className="tile-error" role="alert">{error}</p>}
  </div>;
}
