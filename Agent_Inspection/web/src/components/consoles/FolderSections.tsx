import { useState, type ReactNode } from 'react';
import { Icon } from '../Icon.tsx';
import type { BoardFolder } from './boardFolders.ts';
import type { BoardItem } from './boardItems.ts';
import './projectStrip.css';

const COLLAPSED_KEY = 'waystation-console-folders-collapsed';

function loadCollapsed(): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(collapsed: ReadonlySet<string>): void {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* storage blocked */ }
}

/**
 * Tiles with "All projects": one section per folder, each with a collapsible header and its own grid.
 * A collapsed grid is hidden, not unmounted, so its terminals keep their connection and scrollback.
 */
export function FolderSections({ folders, renderTile }: {
  readonly folders: readonly BoardFolder[];
  readonly renderTile: (item: BoardItem) => ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(loadCollapsed);
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (!next.delete(key)) next.add(key);
    saveCollapsed(next);
    setCollapsed(next);
  };
  return <div className="console-sections">
    {folders.map((folder) => {
      const open = !collapsed.has(folder.key);
      const gridId = `folder-grid-${folder.key.replace(/[^a-z0-9]/gi, '_')}`;
      return <section key={folder.key} className="folder-section" aria-label={folder.name}>
        <button type="button" className="folder-head" aria-expanded={open} aria-controls={gridId} title={folder.path ?? folder.name} onClick={() => toggle(folder.key)}>
          <span className="folder-chevron" aria-hidden="true">▾</span>
          <Icon name="folder" size={14} />
          <span>{folder.name}</span>
          <small>{folder.items.length} {folder.items.length === 1 ? 'session' : 'sessions'}</small>
          {folder.needsYou > 0 && <span className="project-tab-needs">{folder.needsYou} needs you</span>}
          {folder.path && <span className="folder-path">{folder.path}</span>}
        </button>
        <div id={gridId} hidden={!open} className={`console-tiles console-tiles-${Math.min(folder.items.length, 4)}`}>
          {folder.items.map(renderTile)}
        </div>
      </section>;
    })}
  </div>;
}
