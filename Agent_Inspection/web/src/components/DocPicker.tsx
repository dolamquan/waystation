import { useEffect, useMemo, useState } from 'react';
import { loadoutApi, type ContextDoc } from '../library/loadoutApi.ts';
import { formatBytes } from './LoadoutPicker.tsx';

interface DocPickerProps {
  readonly onPick: (doc: ContextDoc) => void;
}

const MAX_SHOWN = 60;

/** Lists the Library's context docs so one can be sent to a running agent. Looks like SkillPicker. */
export function DocPicker({ onPick }: DocPickerProps) {
  const [docs, setDocs] = useState<ContextDoc[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [query, setQuery] = useState('');

  useEffect(() => {
    let ignore = false;
    loadoutApi.docs().then(
      (r) => { if (!ignore) setDocs(r.docs); },
      (e: Error) => { if (!ignore) setError(e.message); },
    );
    return () => { ignore = true; };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = docs ?? [];
    return (q ? list.filter((d) => `${d.title} ${d.filename ?? ''}`.toLowerCase().includes(q)) : list).slice(0, MAX_SHOWN);
  }, [docs, query]);

  if (error) return <p className="muted">Context docs are not available yet. ({error})</p>;
  if (!docs) return <p className="muted">Loading context docs…</p>;
  if (docs.length === 0) return <p className="muted">No context docs yet. Add .md files in the Library first.</p>;
  return (
    <div className="skill-picker">
      <input className="text-input" placeholder={`Search ${docs.length} docs…`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search context docs" />
      <ul className="skill-list">
        {filtered.map((doc) => (
          <li key={doc.id}>
            <button type="button" className="skill-row" onClick={() => onPick(doc)}>
              <span className="skill-name">{doc.title}</span>
              <span className="doc-picker-size">{formatBytes(doc.bytes)}</span>
              <span className="skill-desc">{doc.filename ?? 'Written in WayStation'}</span>
            </button>
          </li>
        ))}
        {filtered.length === 0 && <li className="muted">No matching docs.</li>}
      </ul>
    </div>
  );
}
