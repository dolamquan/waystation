import { Icon } from '../Icon.tsx';
import { fileName } from './canvasTiles.ts';
import type { WorktreeListing } from './worktreesApi.ts';

/** Repository membership, not commit ancestry: worktrees can start from any branch or commit. */
export function WorktreeMap({ listing, selected, disabled, onSelect }: {
  readonly listing: WorktreeListing;
  readonly selected: string;
  readonly disabled: boolean;
  readonly onSelect: (path: string) => void;
}) {
  const main = listing.worktrees.find(tree => tree.main);
  return <section className="worktree-map" aria-label="Worktree visualization">
    <div className="worktree-map-root">
      <Icon name="folder" size={18} />
      <div><strong>{fileName(main?.path ?? listing.root)}</strong><span>Shared Git repository</span></div>
    </div>
    {listing.worktrees.length ? <ol className="worktree-map-branches" aria-label="Repository worktrees">
      {listing.worktrees.map(tree => {
        const active = selected === tree.path;
        const unavailable = tree.bare || !!tree.prunable;
        const hasCommit = tree.head && !/^0+$/.test(tree.head);
        const branch = tree.branch ?? (tree.bare ? 'Bare repository' : 'Detached HEAD');
        return <li key={tree.path} className="worktree-map-item">
          <button type="button" className={`worktree-map-node${active ? ' worktree-map-node-selected' : ''}`}
            aria-label={`Select worktree ${branch} at ${tree.path}`} aria-pressed={active} disabled={disabled || unavailable}
            onClick={() => onSelect(tree.path)}>
            <span className="worktree-map-node-title"><strong>{branch}</strong>
              <span className="worktree-map-kind">{tree.main ? 'Main checkout' : 'Worktree'}</span>
              {active && <span className="worktree-map-selected"><Icon name="check" size={13} />Selected</span>}
              {hasCommit && <code className="worktree-map-commit" title={`Current commit ${tree.head}`}>{tree.head!.slice(0, 7)}</code>}
            </span>
            <span className="worktree-map-folder" title={tree.path}>{tree.path}</span>
            {(!hasCommit || tree.locked || tree.prunable) && <span className="worktree-map-node-meta">
              {!hasCommit && <span>{tree.bare ? 'No working folder' : 'No commits yet'}</span>}
              {tree.locked && <span title={tree.locked}>Locked</span>}
              {tree.prunable && <span title={tree.prunable}>Folder unavailable</span>}
            </span>}
          </button>
        </li>;
      })}
    </ol> : <p className="tile-note">No worktrees found. Refresh or create a worktree below.</p>}
    <p className="tile-note">Each folder has its own files. Select one to choose where your next tile opens.</p>
  </section>;
}
