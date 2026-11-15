import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../Icon.tsx';
import { listFolder, type FolderListing } from './filesApi.ts';

const LIST_DELAY_MS = 300;
const KB = 1024;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sizeLabel = (bytes: number | undefined): string => {
  if (bytes === undefined) return '';
  if (bytes < KB) return `${bytes} B`;
  if (bytes < KB * KB) return `${Math.round(bytes / KB)} KB`;
  return `${(bytes / KB / KB).toFixed(1)} MB`;
};

/** A short type badge: PY, IPYNB, PDF… */
const badge = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).slice(0, 5).toUpperCase() : 'FILE';
};

/**
 * Browses the chosen folder for a file to open in a tile. Click a folder to go in, a file to pick it, double-click a
 * file to open it at once. The daemon keeps every listing inside the folder.
 */
export function FolderBrowser({ root, selected, onSelect, onOpen }: {
  readonly root: string;
  /** The picked file, relative to root. */
  readonly selected?: string;
  readonly onSelect: (path: string) => void;
  readonly onOpen: (path: string) => void;
}) {
  const [dir, setDir] = useState('');
  const [listing, setListing] = useState<FolderListing>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState('');

  useEffect(() => { setDir(''); setFilter(''); }, [root]);
  useEffect(() => {
    const folder = root.trim();
    if (!folder) { setListing(undefined); setError('Choose a folder above.'); return undefined; }
    let cancelled = false;
    // Typing a path fires a change per key; wait for a pause before asking the daemon.
    const timer = setTimeout(() => {
      listFolder(folder, dir).then(
        (next) => { if (!cancelled) { setListing(next); setError(undefined); } },
        (failure: unknown) => { if (!cancelled) { setListing(undefined); setError(messageOf(failure)); } },
      );
    }, LIST_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [root, dir]);

  const inside = (name: string) => (dir ? `${dir}/${name}` : name);
  const crumbs = dir ? dir.split('/') : [];
  const shown = useMemo(() => {
    const wanted = filter.trim().toLowerCase();
    return (listing?.entries ?? []).filter((entry) => !wanted || entry.name.toLowerCase().includes(wanted));
  }, [listing, filter]);

  return <div className="folder-browser">
    <div className="folder-bar">
      <nav className="folder-crumbs" aria-label="Folder">
        <button type="button" onClick={() => setDir('')} title={listing?.root ?? root}><Icon name="folder" size={13} />{(listing?.root ?? root).split(/[\\/]/).filter(Boolean).pop() ?? 'folder'}</button>
        {crumbs.map((part, index) => <span key={`${part}-${index}`}>
          <span aria-hidden="true">/</span>
          <button type="button" onClick={() => setDir(crumbs.slice(0, index + 1).join('/'))}>{part}</button>
        </span>)}
      </nav>
      <input className="folder-filter" value={filter} placeholder="Filter" aria-label="Filter files" spellCheck={false} onChange={(event) => setFilter(event.target.value)} />
    </div>
    {error && <p className="tile-error" role="alert">{error}</p>}
    {listing && <ul className="folder-list" aria-label="Files">
      {dir && <li><button type="button" className="folder-row" onClick={() => setDir(crumbs.slice(0, -1).join('/'))}>
        <span className="folder-icon"><Icon name="arrow" size={13} /></span><span className="folder-name">..</span>
      </button></li>}
      {shown.map((entry) => {
        const path = inside(entry.name);
        const isDir = entry.kind === 'dir';
        return <li key={entry.name}>
          <button type="button" className={selected === path ? 'folder-row folder-row-on' : 'folder-row'} aria-pressed={!isDir ? selected === path : undefined}
            onClick={() => (isDir ? setDir(path) : onSelect(path))} onDoubleClick={() => { if (!isDir) onOpen(path); }}>
            <span className={isDir ? 'folder-icon' : 'folder-badge'}>{isDir ? <Icon name="folder" size={13} /> : badge(entry.name)}</span>
            <span className="folder-name">{entry.name}</span>
            <small>{sizeLabel(entry.size)}</small>
          </button>
        </li>;
      })}
      {shown.length === 0 && <li className="folder-empty">{filter ? 'Nothing matches.' : 'This folder is empty.'}</li>}
    </ul>}
    {listing?.truncated && <p className="tile-note">Only the first {listing.entries.length} entries are listed; use the filter to narrow them.</p>}
  </div>;
}
