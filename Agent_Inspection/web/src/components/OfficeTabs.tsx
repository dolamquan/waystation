import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { StationOffice } from '../stationOffices.ts';
import { idleOfficeKeys, splitOffices } from '../stationOfficeTabs.ts';
import { Icon } from './Icon.tsx';

interface OfficeTabsProps {
  readonly offices: readonly StationOffice[];
  readonly closedKeys: readonly string[];
  readonly activeKey?: string;
  readonly tabIdPrefix: string;
  readonly panelId: string;
  readonly onSelect: (key: string) => void;
  readonly onClose: (keys: readonly string[]) => void;
  readonly onOpen: (key: string) => void;
}

const sessionCount = (office: StationOffice) => `${office.agents.length} ${office.agents.length === 1 ? 'session' : 'sessions'}`;

/** The working-folder tabs, each closable, plus a menu to reopen closed ones. */
export function OfficeTabs({ offices, closedKeys, activeKey, tabIdPrefix, panelId, onSelect, onClose, onOpen }: OfficeTabsProps) {
  const { open, closed } = splitOffices(offices, closedKeys);
  const idleOpen = idleOfficeKeys(open);

  const focusTab = (index: number) => document.getElementById(`${tabIdPrefix}-tab-${index}`)?.focus();
  const closeTab = (index: number) => {
    onClose([open[index].key]);
    if (open.length > 1) requestAnimationFrame(() => focusTab(Math.min(index, open.length - 2)));
  };
  const handleKeyDown = (event: ReactKeyboardEvent, index: number) => {
    if (event.key === 'Delete') { event.preventDefault(); closeTab(index); return; }
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % open.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + open.length) % open.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = open.length - 1;
    else return;
    event.preventDefault();
    onSelect(open[next].key);
    focusTab(next);
  };

  return <>
    <div className="office-tabs" role="tablist" aria-label="Working folders">
      {open.map((office, index) => {
        const active = office.key === activeKey;
        return <span key={office.key} className={`office-tab-wrap ${active ? 'office-tab-active' : ''}`} role="presentation">
          <button
            id={`${tabIdPrefix}-tab-${index}`}
            className="office-tab"
            role="tab"
            aria-selected={active}
            aria-controls={panelId}
            aria-keyshortcuts="Delete"
            tabIndex={active ? 0 : -1}
            title={`${office.path ?? 'Sessions with no known working folder'} · Delete closes this tab`}
            onClick={() => onSelect(office.key)}
            onKeyDown={event => handleKeyDown(event, index)}
          ><Icon name="folder" size={13} /><span className="office-tab-name">{office.name}</span><span className="office-tab-count" aria-label={sessionCount(office)}>{office.agents.length}</span></button>
          <button className="office-tab-close" tabIndex={-1} aria-label={`Close ${office.name} workspace`} title="Close workspace" onClick={() => closeTab(index)}><Icon name="close" size={11} /></button>
        </span>;
      })}
    </div>
    <WorkspaceMenu closed={closed} idleOpenKeys={idleOpen} onOpen={key => { onOpen(key); onSelect(key); }} onCloseIdle={() => onClose(idleOpen)} />
  </>;
}

interface WorkspaceMenuProps {
  readonly closed: readonly StationOffice[];
  readonly idleOpenKeys: readonly string[];
  readonly onOpen: (key: string) => void;
  readonly onCloseIdle: () => void;
}

function WorkspaceMenu({ closed, idleOpenKeys, onOpen, onCloseIdle }: WorkspaceMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [isOpen]);

  const run = (action: () => void) => { action(); setIsOpen(false); };
  const label = closed.length ? `Workspaces (${closed.length} closed)` : 'Workspaces';

  return <div className="office-menu" ref={rootRef}>
    <button ref={triggerRef} className="world-tool world-tool-text office-menu-trigger" aria-haspopup="menu" aria-expanded={isOpen} onClick={() => setIsOpen(!isOpen)} title="Open or close workspaces">
      <Icon name="plus" size={13} />{label}
    </button>
    {isOpen && <div className="office-menu-panel" role="menu" aria-label="Workspaces">
      <p className="office-menu-heading">Closed workspaces</p>
      {closed.length === 0 && <p className="office-menu-empty">None. Close a tab with its × to tidy it away.</p>}
      {closed.map(office => <button key={office.key} role="menuitem" className="office-menu-item" title={office.path} onClick={() => run(() => onOpen(office.key))}>
        <Icon name="folder" size={13} /><span className="office-tab-name">{office.name}</span><span className="office-tab-count" aria-label={sessionCount(office)}>{office.agents.length}</span>
      </button>)}
      <hr className="office-menu-rule" />
      <button role="menuitem" className="office-menu-item" disabled={idleOpenKeys.length === 0} onClick={() => run(onCloseIdle)}>
        <Icon name="close" size={13} />Close empty workspaces{idleOpenKeys.length ? ` (${idleOpenKeys.length})` : ''}
      </button>
    </div>}
  </div>;
}
