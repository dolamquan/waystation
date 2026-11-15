import type { ConsoleKind } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { BrowserTile } from './BrowserTile.tsx';
import { tileLabel, urlLabel, type LocalTile } from './canvasTiles.ts';
import { EditableName } from './EditableName.tsx';
import { FileTile } from './FileTile.tsx';
import { NoteTile } from './NoteTile.tsx';
import { TileChooser } from './TileChooser.tsx';
import { WorktreeTile } from './WorktreeTile.tsx';
import './canvasTiles.css';
import './fileTiles.css';

const META: Readonly<Record<LocalTile['kind'], (tile: LocalTile) => string>> = {
  blank: () => 'choose what it becomes',
  browser: (tile) => urlLabel(tile.url),
  file: (tile) => tile.path ?? '',
  note: () => 'Markdown note',
  worktree: (tile) => tile.path ?? 'Git worktrees',
  orchestrator: (tile) => { const count = (tile.teams?.length ?? 0) + (tile.agents?.length ?? 0); return count ? `${count} wired` : 'nothing wired yet'; },
};

/** Title strip of a canvas-only tile, styled like a console's. Click the name to rename it. */
export function LocalTileHeader({ tile, onClose, onRename }: {
  readonly tile: LocalTile;
  readonly onClose: () => void;
  readonly onRename: (name: string) => void;
}) {
  const name = tileLabel(tile);
  return <header className="console-head">
    <span className={`console-dot ${tile.kind === 'blank' ? '' : 'console-dot-ready'}`} aria-hidden="true" />
    <EditableName value={name} label={name} className="console-name" onRename={onRename} />
    <span className="console-meta" title={META[tile.kind](tile)}>{META[tile.kind](tile)}</span>
    <button className="icon-btn" onClick={onClose} aria-label={`Close ${name}`} title="Close tile"><Icon name="close" size={15} /></button>
  </header>;
}

/** A blank tile's chooser, a browser tile's page, or a file tile's viewer. */
export function LocalTileBody({ tile, defaultCwd, onOpenConsole, onShowPage, onShowFile, onOrchestrate, onWorktree }: {
  readonly tile: LocalTile;
  readonly defaultCwd: string;
  readonly onOpenConsole: (kind: ConsoleKind, cwd: string, name?: string) => Promise<boolean>;
  readonly onShowPage: (url: string, name?: string) => void;
  readonly onShowFile: (root: string, path: string, name?: string) => void;
  readonly onOrchestrate: (name?: string) => void;
  readonly onWorktree: (root: string, path: string, name?: string) => void;
}) {
  if (tile.kind === 'browser' && tile.url) return <BrowserTile id={tile.id} url={tile.url} />;
  if (tile.kind === 'file' && tile.root && tile.path) return <FileTile root={tile.root} path={tile.path} />;
  if (tile.kind === 'note') return <NoteTile tile={tile} />;
  if (tile.kind === 'worktree') return <WorktreeTile tile={tile} onSelect={onWorktree} onOpenConsole={onOpenConsole} />;
  return <TileChooser defaultCwd={defaultCwd} onOpenConsole={onOpenConsole} onBrowse={onShowPage} onOpenFile={onShowFile} onOrchestrate={onOrchestrate} onWorktree={onWorktree} />;
}
