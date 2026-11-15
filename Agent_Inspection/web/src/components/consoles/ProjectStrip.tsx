import { useId, type KeyboardEvent } from 'react';
import { Icon } from '../Icon.tsx';
import type { BoardFolder } from './boardFolders.ts';
import './projectStrip.css';

export const ALL_PROJECTS = 'all';

/** One chip per working folder, like the overview's office tabs, plus "All projects". Arrow keys move between chips. */
export function ProjectStrip({ folders, total, value, onChange, hint }: {
  readonly folders: readonly BoardFolder[];
  readonly total: number;
  /** ALL_PROJECTS or a folder key. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Shown beside the strip, e.g. why "All projects" is not selectable on the canvas. */
  readonly hint?: string;
}) {
  const id = useId();
  const tabs = [{ key: ALL_PROJECTS, name: 'All projects', count: total, needsYou: 0, path: undefined as string | undefined },
    ...folders.map((folder) => ({ key: folder.key, name: folder.name, count: folder.items.length, needsYou: folder.needsYou, path: folder.path }))];
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onChange(tabs[next]!.key);
    document.getElementById(`${id}-${next}`)?.focus();
  };
  return <div className="project-strip">
    <div className="project-tabs" role="tablist" aria-label="Projects">
      {tabs.map((tab, index) => <button key={tab.key} id={`${id}-${index}`} role="tab" type="button"
        className={tab.key === value ? 'project-tab project-tab-on' : 'project-tab'} aria-selected={tab.key === value}
        tabIndex={tab.key === value ? 0 : -1} title={tab.path ?? tab.name} onClick={() => onChange(tab.key)} onKeyDown={(event) => onKey(event, index)}>
        <Icon name="folder" size={13} />
        <span className="project-tab-name">{tab.name}</span>
        <span className="project-tab-count" aria-label={`${tab.count} sessions`}>{tab.count}</span>
        {tab.needsYou > 0 && <span className="project-tab-needs" title={`${tab.needsYou} need you`}>{tab.needsYou} needs you</span>}
      </button>)}
    </div>
    {hint && <span className="project-hint" role="status">{hint}</span>}
  </div>;
}
