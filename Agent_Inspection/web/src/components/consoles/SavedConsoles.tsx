import { useCallback, useEffect, useState } from 'react';
import { api, type SavedConsole } from '../../api.ts';
import './savedConsoles.css';
import { folderName } from './boardItems.ts';

type Notify = (text: string, kind?: 'ok' | 'error') => void;

const KIND_LABEL: Readonly<Record<SavedConsole['kind'], string>> = { claude: 'Claude Code', codex: 'Codex', shell: 'Shell' };
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A banner above the board offering the consoles that were open when Waystation last stopped. */
export function SavedConsoles({ notify, onChanged, onList }: {
  readonly notify: Notify;
  /** Resolves once the board has re-read its consoles, so a restored console is never in neither list. */
  readonly onChanged: () => Promise<void>;
  /** The board keys (`console:<id>`) of every restorable console, so their teams wait for them. */
  readonly onList?: (keys: readonly string[]) => void;
}) {
  const [saved, setSaved] = useState<readonly SavedConsole[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    let next: readonly SavedConsole[] = [];
    try {
      next = (await api.savedConsoles()).saved;
    } catch {
      // The banner is optional; the board still works without it.
    }
    setSaved(next);
    onList?.(next.map((item) => `console:${item.id}`));
  }, [onList]);

  useEffect(() => { void refresh(); }, [refresh]);

  const restoreOne = async (item: SavedConsole): Promise<boolean> => {
    try {
      await api.restoreConsole(item.id);
      return true;
    } catch (error) {
      notify(`Could not restore ${item.name}: ${messageOf(error)}`, 'error');
      return false;
    }
  };

  const restore = async (items: readonly SavedConsole[]) => {
    setBusy(true);
    let restored = 0;
    for (const item of items) if (await restoreOne(item)) restored += 1;
    if (restored > 0) notify(restored === 1 ? 'Console restored.' : `${restored} consoles restored.`);
    // The board lists the restored consoles before they leave the restorable list, so their teams never dissolve.
    if (restored > 0) await onChanged();
    await refresh();
    setBusy(false);
  };

  const discard = async (item: SavedConsole) => {
    setBusy(true);
    try {
      await api.discardSavedConsole(item.id);
    } catch (error) {
      notify(`Could not discard ${item.name}: ${messageOf(error)}`, 'error');
    }
    await refresh();
    setBusy(false);
  };

  if (saved.length === 0) return null;
  return (
    <section className="saved-consoles" aria-label="Saved consoles">
      <header className="saved-head">
        <strong>Pick up where you left off</strong>
        <span className="saved-note">Claude Code and Codex resume their last session in that folder.</span>
        {saved.length > 1 && (
          <button type="button" className="saved-btn saved-btn-main" disabled={busy} onClick={() => void restore(saved)}>Restore all</button>
        )}
      </header>
      <ul className="saved-list">
        {saved.map((item) => (
          <li key={item.id} className="saved-row">
            <span className="saved-name">{item.name}</span>
            <span className="saved-meta">{KIND_LABEL[item.kind]} in <span title={item.cwd}>{folderName(item.cwd)}</span></span>
            <button type="button" className="saved-btn saved-btn-main" disabled={busy} onClick={() => void restore([item])}>Restore</button>
            <button type="button" className="saved-btn" disabled={busy} onClick={() => void discard(item)}>Discard</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
