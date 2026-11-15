import { useState, type KeyboardEvent } from 'react';
import { MAX_NAME } from './canvasTiles.ts';

/**
 * A tile's name that becomes a text box when clicked: Enter or leaving the box saves, Escape cancels. Pointer and
 * double-click events stop here, so typing never drags the tile or zooms the canvas.
 */
export function EditableName({ value, label, className, onRename }: {
  readonly value: string;
  /** What the thing is, for screen readers ("Shell 1"). */
  readonly label: string;
  readonly className?: string;
  readonly onRename: (name: string) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const finish = (save: boolean) => {
    setEditing(false);
    const next = draft.trim();
    if (save && next && next !== value) void Promise.resolve(onRename(next)).catch(() => { /* the caller reports failures */ });
  };
  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') finish(false);
  };
  if (editing) {
    return <input className="tile-name-input" value={draft} maxLength={MAX_NAME} autoFocus aria-label={`New name for ${label}`}
      onChange={(event) => setDraft(event.target.value)} onBlur={() => finish(true)} onKeyDown={handleKey}
      onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} />;
  }
  return <button type="button" className={['tile-name', className].filter(Boolean).join(' ')} title="Click to rename"
    aria-label={`${value}. Click to rename`} onClick={() => { setDraft(value); setEditing(true); }} onDoubleClick={(event) => event.stopPropagation()}>
    {value}
  </button>;
}
