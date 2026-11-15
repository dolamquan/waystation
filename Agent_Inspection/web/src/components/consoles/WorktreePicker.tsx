import { useEffect, useRef, useState } from 'react';
import { worktreesApi, type GitWorktree, type WorktreeListing } from './worktreesApi.ts';
import { WorktreeMap } from './WorktreeMap.tsx';
import './worktrees.css';

export interface WorktreeSelection { readonly root: string; readonly worktree: GitWorktree }

/** Shared by terminal creation and the persistent Worktree tile. It never launches a process. */
export function WorktreePicker({ root, initialPath, visualize = false, onChange }: {
  readonly root: string;
  readonly initialPath?: string;
  readonly visualize?: boolean;
  readonly onChange: (selection: WorktreeSelection | undefined) => void;
}) {
  const [listing, setListing] = useState<WorktreeListing>();
  const [selected, setSelected] = useState(initialPath ?? '');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<'map' | 'list'>('map');
  const notify = useRef(onChange); notify.current = onChange;
  const chosen = useRef(initialPath ?? '');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(undefined); notify.current(undefined);
    const timer = setTimeout(() => {
      void worktreesApi.list(root).then(result => {
        if (cancelled) return;
        setListing(result);
        const tree = result.worktrees.find(tree => tree.path === chosen.current)
          ?? (!chosen.current ? result.worktrees.find(tree => !tree.bare && !tree.prunable) : undefined);
        if (tree) {
          chosen.current = tree.path; setSelected(tree.path);
          if (!tree.bare && !tree.prunable) notify.current({ root: result.root, worktree: tree });
        } else { setSelected(''); }
      }).catch(err => { if (!cancelled) { setListing(undefined); setError((err as Error).message); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [root, revision]);

  const select = (path: string) => {
    const tree = listing?.worktrees.find(tree => tree.path === path);
    chosen.current = path; setSelected(path); setMessage(undefined);
    notify.current(tree && listing && !tree.bare && !tree.prunable ? { root: listing.root, worktree: tree } : undefined);
  };
  const create = async () => {
    if (!listing || busy) return;
    setBusy(true); setError(undefined); setMessage(undefined);
    notify.current(undefined);
    try {
      const result = await worktreesApi.create({ root: listing.root, branch: branch.trim(), mode,
        ...(base.trim() && mode === 'new' ? { base: base.trim() } : {}), ...(path.trim() ? { path: path.trim() } : {}) });
      if (!mounted.current) return;
      chosen.current = result.worktree.path; setSelected(result.worktree.path);
      // Keep the created worktree selected even if listing it again would fail.
      setListing(current => current ? { ...current, worktrees: [...current.worktrees, result.worktree],
        branches: [...new Set([...current.branches, branch.trim()])] } : current);
      notify.current(result);
      setMessage(`Created ${result.worktree.branch}. Ready to open a tile.`);
      setBranch(''); setPath(''); setExpanded(false);
    } catch (err) {
      if (mounted.current) {
        setError((err as Error).message);
        const previous = listing.worktrees.find(tree => tree.path === selected);
        if (previous && !previous.bare && !previous.prunable) notify.current({ root: listing.root, worktree: previous });
      }
    }
    finally { if (mounted.current) setBusy(false); }
  };
  const available = listing?.branches.filter(branch => !listing.worktrees.some(tree => tree.branch === branch)) ?? [];
  return <div className="worktree-picker" aria-busy={loading || busy}>
    {visualize && <div className="worktree-map-toolbar">
      <strong>Worktree map</strong>
      <div className="worktree-view-switch" role="group" aria-label="Worktree view">
        <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>Map</button>
        <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
      </div>
      <button type="button" className="btn" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}>Refresh</button>
    </div>}
    {visualize && view === 'map'
      ? loading ? <p className="tile-note" role="status">Loading worktree map…</p>
        : listing && <WorktreeMap listing={listing} selected={selected} disabled={busy} onSelect={select} />
      : <div className="worktree-select-row">
      <label className="tile-field">Worktree
        <select className="text-input" value={selected} disabled={loading || busy || !listing} onChange={event => select(event.target.value)}>
          <option value="" disabled>{loading ? 'Loading worktrees…' : 'Select a worktree'}</option>
          {listing?.worktrees.map(tree => <option key={tree.path} value={tree.path} disabled={tree.bare || !!tree.prunable}>
            {tree.branch ?? (tree.bare ? 'Bare repository' : 'Detached HEAD')} {tree.main ? '(main checkout)' : ''} — {tree.path}{tree.prunable ? ' (missing)' : ''}
          </option>)}
        </select>
      </label>
      {!visualize && <button type="button" className="btn" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}>Refresh</button>}
    </div>}
    {selected && (!visualize || view === 'list') && <p className="worktree-path">{selected}</p>}
    {listing && !loading && <details className="worktree-create" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>Create a worktree</summary>
      {!listing.hasCommits ? <p className="tile-note">Commit your project at least once before creating a worktree.</p>
        : <div className="worktree-create-fields" onKeyDown={event => {
          if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
            event.preventDefault();
            if (branch.trim()) void create();
          }
        }}>
          <label className="tile-field">Branch
            <select className="text-input" value={mode} disabled={busy} onChange={event => { setMode(event.target.value as typeof mode); setBranch(''); }}>
              <option value="new">Create a new branch</option><option value="existing">Use an existing local branch</option>
            </select>
          </label>
          {mode === 'new' ? <>
            <label className="tile-field">New branch name
              <input className="text-input" value={branch} disabled={busy} placeholder="feature/search" onChange={event => setBranch(event.target.value)} />
            </label>
            <label className="tile-field">Start from <small>(optional)</small>
              <input className="text-input" value={base} disabled={busy} placeholder="HEAD" onChange={event => setBase(event.target.value)} />
            </label>
          </> : <label className="tile-field">Existing branch
            <select className="text-input" value={branch} disabled={busy} onChange={event => setBranch(event.target.value)}>
              <option value="">{available.length ? 'Select a branch' : 'All local branches are already checked out'}</option>
              {available.map(branch => <option key={branch} value={branch}>{branch}</option>)}
            </select>
          </label>}
          <label className="tile-field">New worktree folder <small>(optional)</small>
            <input className="text-input" value={path} disabled={busy} placeholder="Automatic: next to the repository" onChange={event => setPath(event.target.value)} />
            <small>Use a new folder with an existing parent. Leave blank to name it after the repository and branch.</small>
          </label>
          <p className="tile-note">The worktree starts from committed files.{listing.dirty ? ' This checkout has uncommitted changes; they stay here.' : ''}</p>
          <button type="button" className="btn" disabled={busy || !branch.trim()} onClick={() => void create()}>{busy ? 'Creating worktree…' : 'Create worktree'}</button>
        </div>}
    </details>}
    {message && <p className="tile-note" role="status">{message}</p>}
    {error && <p className="tile-error" role="alert">{error}</p>}
  </div>;
}
