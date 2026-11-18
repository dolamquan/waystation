import { useEffect, useRef, useState } from 'react';

const PREFIX = 'waystation-inspector-draft:';
const changed = () => window.dispatchEvent(new Event('architecture-drafts-changed'));
export function draftCount(documentId: string, validIds?: ReadonlySet<string>): number {
  const prefix = `${PREFIX}${documentId}:`;
  try { return Object.keys(sessionStorage).filter(k => k.startsWith(prefix) && (!validIds || validIds.has(k.slice(prefix.length)))).length; } catch { return 0; }
}

/** Per-tab drafts survive inspector navigation and reloads. Credential values must never be passed here. */
export function useInspectorDraft<T>(key: string, value: T) {
  const storageKey = `${PREFIX}${key}`; const serialized = JSON.stringify(value);
  const [state] = useState(() => {
    try { const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'); if (stored && typeof stored.base === 'string' && stored.draft !== undefined && JSON.stringify(stored.draft) !== serialized) return stored as { base: string; draft: T }; } catch { /* Storage is optional. */ }
    return { base: serialized, draft: value };
  });
  const [draft, setDraft] = useState<T>(state.draft); const [base, setBase] = useState(state.base);
  const committed = useRef(false); const dirty = JSON.stringify(draft) !== serialized; const conflict = dirty && base !== serialized;
  const commit = () => { committed.current = true; try { sessionStorage.removeItem(storageKey); } catch { /* Storage is optional. */ } changed(); };
  useEffect(() => {
    if (committed.current) return;
    try { if (dirty) sessionStorage.setItem(storageKey, JSON.stringify({ base, draft })); else sessionStorage.removeItem(storageKey); } catch { /* Quota/private browsing must not break editing. */ }
    changed();
  }, [storageKey, base, draft, dirty]);
  return { draft, setDraft, dirty, conflict, commit, discard: () => { committed.current = false; setDraft(value); setBase(serialized); }, rebase: () => setBase(serialized) };
}

export function DraftNotice({ dirty, conflict, discard, rebase }: { dirty: boolean; conflict: boolean; discard: () => void; rebase: () => void }) {
  if (!dirty) return null;
  return <div className="arch-draft-notice" role="status"><p>{conflict ? 'The saved configuration changed while you had a draft. Review the changes before replacing it.' : 'Unsaved changes. Your configuration draft is kept in this browser tab when you switch steps.'}</p><div className="arch-actions">{conflict && <button type="button" className="btn btn-small" onClick={rebase}>Keep my draft over the saved changes</button>}<button type="button" className="btn btn-small btn-ghost" onClick={discard}>{conflict ? 'Use saved configuration' : 'Discard draft'}</button></div></div>;
}
